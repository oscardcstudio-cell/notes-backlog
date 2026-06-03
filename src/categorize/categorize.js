/**
 * categorize — range une note dans une catégorie (ex: une phase du playbook).
 *
 * Moteur hybride, config-driven (le package ne hardcode AUCUNE taxonomie) :
 *   1. Règles d'abord : score chaque catégorie par mots-clés trouvés dans le texte.
 *      Gratuit, instantané, déterministe.
 *   2. LLM en fallback (optionnel, injecté) : si aucune règle ne tranche (zéro
 *      match ou égalité au sommet), on délègue à `llmClassifier`. Le package
 *      n'embarque aucun client LLM — le caller fournit la fonction (peerDeps-style).
 *
 * Une catégorie = { id, label?, keywords?: string[], marker?: string, default?: boolean }
 *   - `marker` : section de destination dans le BACKLOG.md (sinon le drain retombe
 *     sur le marker global). `default: true` = catégorie de repli si rien ne matche.
 *
 * @returns {Promise<{id, label, marker, via: 'rules'|'llm'|'default'}>}
 */

function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalize(s) {
    return stripAccents(String(s || '').toLowerCase());
}

/**
 * Score par règles (synchrone, testable sans LLM).
 * @returns {{ id, label, marker, score, tie }} meilleure catégorie + métadonnées.
 */
export function categorizeByRules(text, categories = []) {
    const hay = normalize(text);
    let best = null;
    let bestScore = 0;
    let tie = false;

    for (const cat of categories) {
        const kws = cat.keywords || [];
        let score = 0;
        for (const kw of kws) {
            if (hay.includes(normalize(kw))) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = cat;
            tie = false;
        } else if (score === bestScore && score > 0 && best && cat.id !== best.id) {
            tie = true;
        }
    }

    const meta = best
        ? { id: best.id, label: best.label || best.id, marker: best.marker || null }
        : { id: null, label: null, marker: null };
    return { ...meta, score: bestScore, tie };
}

function pickDefault(categories = []) {
    const def = categories.find(c => c.default);
    const c = def || categories[categories.length - 1] || null;
    return c
        ? { id: c.id, label: c.label || c.id, marker: c.marker || null }
        : { id: 'unsorted', label: 'Non classé', marker: null };
}

/**
 * @param {string} text
 * @param {Array}  categories
 * @param {Object} [opts]
 * @param {(text:string, categories:Array)=>Promise<string>} [opts.llmClassifier]
 *        Renvoie l'`id` d'une catégorie. Appelé seulement si les règles ne tranchent pas.
 */
export async function categorize(text, categories = [], opts = {}) {
    if (!categories.length) return { id: null, label: null, marker: null, via: 'default' };

    const ruled = categorizeByRules(text, categories);
    const decisive = ruled.id && ruled.score > 0 && !ruled.tie;
    if (decisive) return { id: ruled.id, label: ruled.label, marker: ruled.marker, via: 'rules' };

    if (typeof opts.llmClassifier === 'function') {
        try {
            const id = await opts.llmClassifier(text, categories);
            const cat = categories.find(c => c.id === id);
            if (cat) return { id: cat.id, label: cat.label || cat.id, marker: cat.marker || null, via: 'llm' };
        } catch {
            // fail-soft : on retombe sur le défaut plutôt que de jeter la note
        }
    }

    // Égalité au sommet sans LLM : on garde le meilleur match plutôt que le défaut.
    if (ruled.id && ruled.score > 0) {
        return { id: ruled.id, label: ruled.label, marker: ruled.marker, via: 'rules' };
    }
    return { ...pickDefault(categories), via: 'default' };
}

export default categorize;
