#!/usr/bin/env node
/**
 * drainNotes — pont notes (API) → BACKLOG.md + notes/<sujet>.md optionnel.
 *
 * 1. GET  {baseUrl}{notesPath}?status=pending   (headers d'auth optionnels)
 * 2. Append chaque note au BACKLOG.md sous une section marqueur, en item TODO
 * 3. Si `subjects` + `notesDir` fournis : catégorise la note → append aussi dans
 *    notes/<sujet>.md (format réservoir : ligne datée). La note est ainsi invoquée
 *    par le plan quand la phase correspondante démarre, pas cherchée par l'agent.
 * 4. POST {baseUrl}{notesPath}/:id/processed     → marque traité côté serveur
 *
 * Catégorisation — deux passes dans l'ordre :
 *   1. Préfixe explicite : "note produit:", "note B:", "note tech:", etc. → direct.
 *   2. Keyword matching en fallback si aucun préfixe reconnu.
 *
 * Fail-soft : serveur down → notes restent pending, drainées au prochain run.
 * Fail-soft : fichier notes/<sujet>.md absent → skip silencieux (BACKLOG seul).
 *
 * Utilisable en module (`import { drainNotes }`) ou en CLI (`notes-drain`).
 * Config via options OU variables d'env (NOTES_BASE_URL, NOTES_PATH,
 * NOTES_AUTH_HEADER, NOTES_AUTH_VALUE, NOTES_BACKLOG_PATH).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { categorize, categorizeByRules } from '../categorize/categorize.js';
import { stripAccents, normalize, escapeRegExp } from '../util/text.js';

// Garde-fou taille : un store custom (Postgres) ou une note injectée hors API
// (qui borne à maxNoteLen) peut contenir un texte géant. On re-borne dans le drain
// avant tout traitement regex/écriture (anti-DoS, cf. audit sécu).
const MAX_DRAIN_TEXT = 20000;

function log(msg) {
    process.stdout.write(`[${new Date().toISOString()}] [notes-drain] ${msg}\n`);
}

/** Tronque le texte d'une note à une borne dure (défensif côté drain). */
function boundedText(note) {
    return String(note.text || '').slice(0, MAX_DRAIN_TEXT);
}

/**
 * Neutralise une ligne de note pour qu'elle ne puisse pas être confondue avec un
 * marqueur de section du BACKLOG. Le repérage du marker est ancré en début de ligne
 * (cf. findMarkerInsert), donc une ligne quotée `  > ## x` ne casse déjà plus
 * l'insertion ; ici on échappe en plus tout heading ATX en tête de ligne (`## …` →
 * `\## …`) pour qu'un parseur markdown aval ne le lise pas comme une section.
 */
function neutralizeLine(line) {
    return String(line).replace(/^(\s*)(#{1,6}\s)/, '$1\\$2');
}

/**
 * Catégorise une note vers un SUJET (notes/<sujet>.md) — deux passes :
 * 1. Préfixe explicite "note <alias>: …" → résolution directe (via: 'prefix').
 * 2. Keyword matching en fallback (via: 'keywords') — délègue à categorizeByRules
 *    (plus de duplication ; détection de tie héritée).
 * Retourne le sujet gagnant enrichi de `via`, ou null.
 *
 * @param {string} text
 * @param {Array<{id, keywords?, filePath?, marker?}>} subjects
 * @param {Object<string,string>} [aliasMap] — map alias→id injectée par le caller
 *        (cœur agnostique : aucune taxonomie hardcodée). Sans map, l'alias = l'id.
 */
export function categorizeBySubject(text, subjects, aliasMap = {}) {
    // Passe 1 — préfixe "note <alias>: …"
    // Match sur le texte SANS accents (la classe ne couvre pas les accentuées) ; on
    // accepte chiffres et tirets dans l'alias ("note p4:", "note tech-ops:").
    const prefixMatch = stripAccents(String(text || '')).match(/^note\s+([a-z0-9-]+)\s*:/i);
    if (prefixMatch) {
        const alias = normalize(prefixMatch[1]);
        const targetId = aliasMap[alias] || alias;
        const found = subjects.find(s => s.id === targetId);
        if (found) return { ...found, via: 'prefix' };
    }

    // Passe 2 — keyword matching (réutilise le moteur de règles agnostique).
    const ruled = categorizeByRules(text, subjects);
    if (ruled.id && ruled.score > 0) {
        const found = subjects.find(s => s.id === ruled.id);
        if (found) return { ...found, via: 'keywords', tie: ruled.tie };
    }
    return null;
}

/**
 * Trouve l'index d'insertion (fin de la ligne du marker) dans `content`.
 * Le marker est repéré ANCRÉ EN DÉBUT DE LIGNE (heading) — un `indexOf` brut matchait
 * aussi un marker quoté à l'intérieur d'une note (`  > ## À faire`) → insertion dans
 * un blockquote, BACKLOG corrompu. Retourne -1 si le heading est absent.
 */
function findMarkerInsert(content, marker) {
    const re = new RegExp(`^${escapeRegExp(marker)}[ \\t]*$`, 'm');
    const m = re.exec(content);
    if (!m) return -1;
    return m.index + m[0].length;
}

/**
 * Construit le bloc TODO d'une note (markdown). Lignes neutralisées contre l'injection
 * de heading (`## …` quoté → `\## …`).
 */
function buildNoteBlock(note, phaseLabel) {
    const text = boundedText(note);
    const date = (note.created_at || new Date().toISOString()).slice(0, 10);
    // Première ligne NON vide (une note commençant par '\n' donnait un titre vide), avec
    // garde null : note.text absent/null ne doit pas crasher (poison-pill re-drainé en boucle).
    const firstLine = neutralizeLine(text.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 80) || '(sans titre)');
    return [
        ``,
        `### [LOW][TODO] 📝 Note — ${firstLine}`,
        `- **Découvert** : ${date} — saisie via le widget de notes`,
        ...(phaseLabel ? [`- **Phase** : ${phaseLabel}`] : []),
        `- **Note** :`,
        ...text.split('\n').map(l => `  > ${neutralizeLine(l)}`),
        `- **Action** : trier — convertir en item structuré, traiter, ou archiver`,
        `- **Dernière maj** : ${date} — ingérée depuis le widget (note ${note.id})`,
        ``,
    ].join('\n');
}

/**
 * Insère une note dans `content` (string en mémoire — pas d'I/O, batchable).
 * @returns {{ content, written, reason? }}
 *   written=false + reason='duplicate' si déjà présente (idempotent),
 *   written=false + reason='no-marker' si ni le marker cible ni le fallback ne sont présents.
 */
function insertNoteBlock(content, marker, note, phaseLabel, fallbackMarker) {
    // Guard idempotency ancré sur le marqueur EXACT écrit — `(note <id>)` avec
    // parenthèses. Sans le `)` fermant, un ID court préfixe d'un autre (s3 vs s30) donnait
    // un faux « déjà présent » → note jamais écrite mais marquée processed = idée perdue.
    if (content.includes(`(note ${note.id})`)) return { content, written: false, reason: 'duplicate' };

    let insertAt = findMarkerInsert(content, marker);
    let usedLabel = phaseLabel;
    if (insertAt === -1 && fallbackMarker && fallbackMarker !== marker) {
        insertAt = findMarkerInsert(content, fallbackMarker); // marker de phase absent → repli global
        usedLabel = phaseLabel; // on garde l'annotation de phase même rangée en global
    }
    if (insertAt === -1) return { content, written: false, reason: 'no-marker' };

    const block = buildNoteBlock(note, usedLabel);
    const updated = content.slice(0, insertAt) + '\n' + block + content.slice(insertAt);
    return { content: updated, written: true };
}

/** Écrit un fichier de façon atomique (tmp unique + rename) — anti-troncature sur crash. */
let _tmpCounter = 0;
async function writeFileAtomic(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${_tmpCounter++}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmp, data, 'utf8');
        await fs.rename(tmp, filePath);
    } catch (e) {
        await fs.unlink(tmp).catch(() => {});
        throw e;
    }
}

/** Résout un filePath de sujet en restant SOUS notesDir (anti path-traversal). */
function resolveUnder(notesDir, filePath) {
    const base = path.resolve(notesDir);
    const target = path.resolve(base, filePath);
    const rel = path.relative(base, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return target;
}

/**
 * Append note dans notes/<sujet>.md (format réservoir : une ligne datée).
 * Multi-lignes → jointes par " / ".
 * Idempotent : guard propre `(note <id>)` (ne dépend plus du seul flag `written` du
 * BACKLOG — un refactor futur ou un appel direct ne peut plus créer de doublon).
 * Retourne false si le fichier est absent (skip silencieux) ou note déjà présente.
 */
async function appendToNotesFile(filePath, note) {
    let existing;
    try { existing = await fs.readFile(filePath, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') { log(`⚠ ${path.basename(filePath)} absent — skip (BACKLOG seul)`); return false; }
        throw e;
    }
    if (existing.includes(`(note ${note.id})`)) return false; // déjà drainée dans ce fichier
    const date = (note.created_at || new Date().toISOString()).slice(0, 10);
    const text = boundedText(note).replace(/\r?\n+/g, ' / ').trim();
    // Marqueur `(note <id>)` littéral (paren adjacente) — DOIT matcher le guard ci-dessus.
    await fs.appendFile(filePath, `- [${date}] ${text} — _(source: widget)_ (note ${note.id})\n`, 'utf8');
    return true;
}

/**
 * @param {Object}   opts
 * @param {string}   opts.baseUrl          — ex: 'https://app.example.com'
 * @param {string}   [opts.notesPath]      — défaut '/api/notes'
 * @param {string}   opts.backlogPath      — chemin absolu du BACKLOG.md
 * @param {string}   [opts.marker]         — section BACKLOG (défaut '## À faire')
 * @param {Object}   [opts.authHeaders]    — ex: { 'x-admin-token': '…' }
 * @param {number}   [opts.timeoutMs]      — défaut 8000
 * @param {Array}    [opts.categories]     — buckets companyPhases (marker-based, legacy).
 *        Si fourni sans `subjects`, range dans les sections BACKLOG par phase.
 * @param {Array}    [opts.subjects]       — buckets notes/<sujet>.md (filePath-based).
 *        Si fourni avec `notesDir`, écrit aussi dans le fichier notes du sujet.
 * @param {string}   [opts.notesDir]       — répertoire absolu des notes/<sujet>.md
 * @param {Object}   [opts.subjectAliasMap]— map alias→subject.id pour la passe préfixe
 *        "note <alias>: …" (cœur agnostique : aucune taxonomie hardcodée).
 * @param {Function} [opts.llmClassifier]  — fallback async (text, categories)=>id
 * @returns {Promise<{drained:number, pending:number}>}
 */
export async function drainNotes(opts = {}) {
    const baseUrl = opts.baseUrl;
    const notesPath = opts.notesPath || '/api/notes';
    const backlogPath = opts.backlogPath;
    const marker = opts.marker || '## À faire';
    const authHeaders = opts.authHeaders || {};
    const timeoutMs = opts.timeoutMs || 8000;
    const categories = Array.isArray(opts.categories) ? opts.categories : null;
    const subjects = Array.isArray(opts.subjects) ? opts.subjects : null;
    const notesDir = opts.notesDir || null;
    const llmClassifier = opts.llmClassifier;
    const subjectAliasMap = opts.subjectAliasMap || {};

    if (!baseUrl) { log('baseUrl manquant — skip'); return { drained: 0, pending: 0 }; }
    if (!backlogPath) { log('backlogPath manquant — skip'); return { drained: 0, pending: 0 }; }

    const headers = { 'Content-Type': 'application/json', ...authHeaders };
    const notesUrl = `${baseUrl.replace(/\/$/, '')}${notesPath}`;

    let pending = [];
    try {
        const r = await fetch(`${notesUrl}?status=pending`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { log(`GET notes HTTP ${r.status} — skip`); return { drained: 0, pending: 0 }; }
        const data = await r.json();
        pending = Array.isArray(data.notes) ? data.notes : [];
    } catch (e) {
        log(`GET notes error: ${e.message} — skip`);
        return { drained: 0, pending: 0 };
    }

    if (pending.length === 0) { log('aucune note pending'); return { drained: 0, pending: 0 }; }
    log(`${pending.length} note(s) pending`);

    // Lecture UNIQUE du BACKLOG (perf : plus de read+write par note → O(n²) éliminé).
    let content;
    try {
        content = await fs.readFile(backlogPath, 'utf8');
    } catch (e) {
        log(`lecture BACKLOG échouée: ${e.message} — skip`);
        return { drained: 0, pending: pending.length };
    }

    // Phase 1 — insertions en mémoire (plus ancienne d'abord → plus récente en haut).
    const ordered = pending.slice().reverse();
    const handled = []; // { note, written, skip }
    for (const note of ordered) {
        // Catégorisation BACKLOG (companyPhases — marker-based).
        let targetMarker = marker;
        let phaseLabel = null;
        if (categories) {
            try {
                const cat = await categorize(boundedText(note), categories, { llmClassifier });
                if (cat.marker) { targetMarker = cat.marker; phaseLabel = `${cat.label} (${cat.via})`; }
            } catch (e) {
                log(`⚠ catégorisation note ${note.id} échouée: ${e.message} — marker global`);
            }
        }
        const res = insertNoteBlock(content, targetMarker, note, phaseLabel, marker);
        content = res.content;
        if (res.reason === 'no-marker') {
            log(`✗ note ${note.id}: marker "${targetMarker}" (et fallback "${marker}") introuvable — laissée pending`);
            handled.push({ note, written: false, skip: true });
            continue;
        }
        if (res.reason === 'duplicate') log(`⚠ note ${note.id} déjà dans BACKLOG — skip écriture (idempotent)`);
        handled.push({ note, written: res.written, skip: false });
    }

    // Phase 2 — persistance UNIQUE et atomique, AVANT tout mark-processed (durabilité :
    // crash après write → notes re-drainées, idempotency = zéro doublon ; crash avant →
    // notes restent pending). Jamais l'inverse (sinon idée marquée traitée mais non écrite).
    if (handled.some(h => h.written)) {
        try {
            await writeFileAtomic(backlogPath, content);
        } catch (e) {
            log(`✗ écriture BACKLOG échouée: ${e.message} — aucune note marquée processed`);
            return { drained: 0, pending: pending.length };
        }
    }

    // Phase 3 — notes/<sujet>.md (si fraîchement écrite) puis mark-processed côté serveur.
    let done = 0;
    for (const h of handled) {
        if (h.skip) continue; // marker introuvable → reste pending pour un prochain run
        const note = h.note;
        try {
            if (h.written && subjects && notesDir) {
                const subject = categorizeBySubject(boundedText(note), subjects, subjectAliasMap);
                if (subject) {
                    const filePath = resolveUnder(notesDir, subject.filePath);
                    if (!filePath) {
                        log(`  ⚠ sujet ${subject.id}: filePath "${subject.filePath}" hors notesDir — skip (sécu)`);
                    } else {
                        const ok = await appendToNotesFile(filePath, note);
                        if (ok) log(`  → notes/${subject.filePath} (${subject.id}, via: ${subject.via})`);
                    }
                } else {
                    log(`  → sujet non détecté, BACKLOG seul`);
                }
            }

            const r = await fetch(`${notesUrl}/${encodeURIComponent(note.id)}/processed`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ backlog_ref: `${backlogPath.split(/[\\/]/).pop()}` }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!r.ok) throw new Error(`mark processed HTTP ${r.status}`);
            done++;
            log(`✓ note ${note.id} → BACKLOG`);
        } catch (e) {
            log(`✗ note ${note.id}: ${e.message}`);
        }
    }
    log(`📊 ${done}/${pending.length} note(s) ingérée(s)`);
    return { drained: done, pending: pending.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// isMain via pathToFileURL : robuste cross-OS (le naïf `file://${argv1}` casse sur
// Windows — file:///C:/ vs file://C:/ → CLI jamais déclenché). Cf. GOTCHAS.md.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const authHeader = process.env.NOTES_AUTH_HEADER;
    const authValue = process.env.NOTES_AUTH_VALUE;
    drainNotes({
        baseUrl: process.env.NOTES_BASE_URL,
        notesPath: process.env.NOTES_PATH || '/api/notes',
        backlogPath: process.env.NOTES_BACKLOG_PATH,
        authHeaders: authHeader && authValue ? { [authHeader]: authValue } : {},
    }).catch(e => { log(`fatal: ${e.message}`); process.exit(1); });
}

export default drainNotes;
