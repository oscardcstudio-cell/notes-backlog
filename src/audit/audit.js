#!/usr/bin/env node
/**
 * audit — la moitié SORTIE du répertoire de notes.
 *
 * `drain` fait entrer les idées, `coverage` vérifie qu'aucune n'est perdue du plan.
 * Il manquait le troisième : vérifier que les items **fermés le sont vraiment** et que
 * les items **ouverts le sont encore**. Sans ça un répertoire de notes dérive en silence :
 * le README de ce package l'annonçait déjà (« sans ce marqueur, les items résolus restent
 * indiscernables des items ouverts et les agents les re-surfacent à chaque session ») —
 * c'est arrivé, un agent a recommandé un chantier livré 5 semaines plus tôt sur la foi
 * d'un index périmé.
 *
 * Cause racine visée : la CAPTURE a un déclencheur d'événement (« note: … » → drain),
 * la CLÔTURE n'en a aucun — sa règle est conditionnée à « si un agent re-surface l'item »,
 * donc à une relecture qui n'arrive jamais. Ce module donne à la clôture ses déclencheurs :
 * un gate déterministe (CI/pre-push) et `relatedOpenItems` (un push qui touche un fichier
 * cité par un item ouvert = le moment exact où il faut trancher).
 *
 * Sémantique des constats (déterministe, anti-faux-positif) :
 *   - `self-declared-done` : item OUVERT dont le corps annonce lui-même livré/fait/abandonné.
 *                            L'agent SAVAIT — il ne l'a pas dit au bon endroit. Zéro ambiguïté.
 *   - `stale-index`        : fichier index daté plus ancien qu'un item de ses sources.
 *                            Compare deux dates, pas deux vérités : jamais de faux positif.
 *   - `dangling-anchor`    : RÉSOLU dont l'ancre code ne résout pas (fichier absent, ligne
 *                            hors bornes, symbole introuvable).
 *   - `unproven-resolution`: RÉSOLU sans aucune ancre code — la convention l'exige.
 *   - `orphan-file`        : fichier de notes qu'aucune étape du plan ne référence → jamais relu.
 *
 * Le cœur est AGNOSTIQUE et sans I/O (comme categorize/drain/coverage) : il prend du texte,
 * rend des constats. Le caller fournit ses patterns ; les presets sont de la data ; le CLI
 * fait les seuls accès disque. Testable sans fixture de fichiers.
 *
 * Baseline — pourquoi elle n'est pas optionnelle en pratique : un répertoire vivant a déjà
 * un stock de constats le jour où on branche le gate. Le rendre rouge d'emblée garantit le
 * `--no-verify`, donc un gate mort, donc le problème d'origine. Avec `--baseline`, les
 * constats connus sont dégradés en `warn` et **seuls les nouveaux échouent** : le gate est
 * vert dès le premier jour et ne mord que sur les régressions. On draine le stock ensuite.
 *
 * Module (`import { auditNotes }`) ou CLI :
 *   notes-audit <notesDir> [--plan plan.json] [--baseline f.json] [--files-from -] [...]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { normalize, escapeRegExp } from '../util/text.js';

// ── Patterns par défaut ───────────────────────────────────────────────────────

/** Item de note du réservoir : `- [AAAA-MM-JJ] texte…` (puces -, *, + tolérées). */
const DEFAULT_ITEM_PATTERN = /^[ \t]*[-*+]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/;

/** Marqueur de clôture : `~~titre~~ … RÉSOLU [date]` (date optionnelle). */
const DEFAULT_RESOLVED_PATTERN = /~~[\s\S]*?~~[\s\S]*?R[ÉE]SOLU(?:\s*\[?(\d{4}-\d{2}-\d{2}))?/i;

/**
 * Ancre code d'un RÉSOLU, entre backticks. Trois formes acceptées :
 *   `src/Form.tsx:386`          → fichier + ligne (ou plage `:386-402`)
 *   `src/Form.tsx:STATUS_LIST`  → fichier + SYMBOLE (préféré : survit au drift de lignes)
 *   `video-studio:server/index.ts:488` → ancre EXTERNE (autre repo), jamais comptée dangling
 * Le préfixe repo se distingue du reste par l'absence d'extension de fichier sur le 1er segment.
 */
const DEFAULT_ANCHOR_PATTERN = /`([^`\s]+\.[a-z0-9]{1,5}):([A-Za-z_$][\w$]*|\d+(?:-\d+)?)`/g;
const DEFAULT_EXTERNAL_ANCHOR_PATTERN = /`([\w.-]+):([^`\s]+\.[a-z0-9]{1,5})(?::[^`\s]+)?`/g;

/** Le corps d'un item ouvert annonce-t-il lui-même que c'est terminé ? */
const DEFAULT_DONE_MARKERS = [
    'LIVRÉ', 'LIVRÉE', 'LIVRÉS', 'LIVRÉES',
    'FAIT', 'FAITS', 'FAITE', 'FAITES',
    'APPLIQUÉ', 'APPLIQUÉE',
    'ABANDONNÉ', 'ABANDONNÉE',
    'PÉRIMÉ', 'PÉRIMÉE',
    'CLÔTURÉ', 'CLÔTURÉE',
];

/**
 * Marqueurs de travail RESTANT. Un item qui en porte un n'est PAS signalé, même s'il
 * annonce « LIVRÉ » par ailleurs.
 *
 * Mesuré sur un répertoire réel : sans ce filtre, 18 items sur 18 étaient signalés, et
 * aucun n'était actionnable — ce sont des notes de gros chantier qui **relatent** ce qui
 * a été livré tout en gardant un reste ouvert (« LIVRÉ … Reste à faire : … »). Un gate
 * qui crie au loup 18 fois se fait baseliner en bloc, donc ne sert plus à rien. Avec le
 * filtre il ne reste que les items qui se déclarent finis SANS aucune réserve — les seuls
 * où « pourquoi ce n'est pas marqué RÉSOLU ? » est une vraie question.
 */
const DEFAULT_OPEN_WORK_MARKERS = [
    'reste', 'restent', 'restant', 'restants', 'à faire', 'todo', 'en attente',
    'non fait', 'pas encore', 'différé', 'differe', 'à trancher', 'manque', 'manquant',
    'bloqué', 'en pause', 'later', 'next', 'à confirmer', 'à vérifier', 'non traité',
];

/** Date auto-déclarée d'un index : `Dernière mise à jour : 2026-06-12`. */
const DEFAULT_INDEX_DATE_PATTERN = /(?:derni[èe]re\s+mise\s+[àa]\s+jour|last\s+updated)\s*[:—-]*\s*(\d{4}-\d{2}-\d{2})/i;

/** Gravité par défaut. Voir l'en-tête : le stock legacy passe par la baseline, pas par le laxisme. */
const DEFAULT_SEVERITY = {
    'self-declared-done': 'error',
    'stale-index': 'error',
    'dangling-anchor': 'error',
    'unproven-resolution': 'warn',
    'orphan-file': 'warn',
};

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Extrait les ancres code d'un texte d'item.
 * @returns {{internal: Array<{file, locator, raw}>, external: string[]}}
 */
function extractAnchors(text, anchorPattern, externalPattern) {
    const internal = [];
    const external = [];
    const seen = new Set();

    // Les externes d'abord : `video-studio:server/index.ts:488` matcherait aussi le pattern
    // interne (sur `index.ts:488`) et produirait un dangling systématique — le faux positif
    // exact qu'on veut éviter (une ref vers un AUTRE repo n'est pas une ref cassée).
    const extRe = new RegExp(externalPattern.source, 'gi');
    let m;
    while ((m = extRe.exec(text)) !== null) {
        external.push(m[0]);
        seen.add(m[0]);
        if (m.index === extRe.lastIndex) extRe.lastIndex++;
    }

    const re = new RegExp(anchorPattern.source, 'gi');
    while ((m = re.exec(text)) !== null) {
        if (![...seen].some(e => e.includes(m[1]))) {
            internal.push({ file: m[1], locator: m[2], raw: m[0] });
        }
        if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { internal, external };
}

/**
 * Parse un fichier de notes en items.
 * Un item = une ligne racine `- [date] …`. Les lignes indentées qui suivent sont
 * rattachées à l'item courant (les notes réelles ont des sous-puces de mise à jour,
 * les ignorer ferait perdre le « RÉSOLU » posé en continuation).
 *
 * @param {string} text
 * @param {Object} [opts]
 * @returns {Array<{lineNo, date, title, body, resolved, resolvedDate, anchors, externalAnchors}>}
 */
export function parseNoteItems(text, opts = {}) {
    const itemPattern = opts.itemPattern || DEFAULT_ITEM_PATTERN;
    const resolvedPattern = opts.resolvedPattern || DEFAULT_RESOLVED_PATTERN;
    const anchorPattern = opts.anchorPattern || DEFAULT_ANCHOR_PATTERN;
    const externalPattern = opts.externalAnchorPattern || DEFAULT_EXTERNAL_ANCHOR_PATTERN;

    const lines = String(text || '').split(/\r?\n/);
    const items = [];
    let current = null;

    const close = () => {
        if (!current) return;
        const res = current.body.match(resolvedPattern);
        current.resolved = Boolean(res);
        current.resolvedDate = res ? (res[1] || null) : null;
        const { internal, external } = extractAnchors(current.body, anchorPattern, externalPattern);
        current.anchors = internal;
        current.externalAnchors = external;
        items.push(current);
        current = null;
    };

    lines.forEach((line, i) => {
        const m = line.match(itemPattern);
        if (m) {
            close();
            current = {
                lineNo: i + 1,
                date: m[1],
                // Titre LISIBLE (affiché dans le rapport) : on retire le balisage markdown
                // mais on garde casse et accents. `normalize()` est pour la COMPARAISON
                // (empreinte de baseline) — l'appliquer ici rendait les rapports illisibles
                // (« vieux truc] ✅ resolu »).
                title: m[2].replace(/[~*`]/g, '').replace(/^\s*\[|\]\s*$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
                body: m[2],
            };
            return;
        }
        // Continuation : ligne indentée non vide sous un item ouvert.
        if (current && /^[ \t]+\S/.test(line)) current.body += '\n' + line;
        else if (current && line.trim() === '') { /* ligne vide : l'item peut continuer */ }
        else if (current && /^\S/.test(line)) close(); // retour en marge → l'item est fini
    });
    close();
    return items;
}

// ── Constats ──────────────────────────────────────────────────────────────────

/**
 * Empreinte stable d'un constat, pour la baseline.
 * VOLONTAIREMENT sans numéro de ligne : une ligne bouge à chaque édition du fichier,
 * une baseline indexée dessus deviendrait périmée au premier commit et re-signalerait
 * tout le stock comme « nouveau » — l'inverse du but.
 */
export function fingerprint(finding) {
    return `${finding.kind}|${finding.file}|${normalize(finding.title || '').slice(0, 80)}`;
}

/**
 * Le corps annonce-t-il lui-même que c'est terminé ?
 *
 * Deux pièges, tous deux vus en test :
 * 1. `\b` est ASCII en JS : `\bLIVRÉ\b` NE MATCHE PAS « LIVRÉ hier » (le `É` est non-word,
 *    donc pas de frontière après). Le marqueur le PLUS fréquent passait à travers en
 *    silence — un détecteur de faux qui rate le cas majoritaire. D'où les lookarounds
 *    Unicode explicites.
 * 2. Matching CASSE SENSIBLE, volontairement. La convention écrit ces marqueurs en
 *    capitales ; et en minuscules dépliées un « livre » (le nom commun, omniprésent dans
 *    un projet d'aides à l'édition) matcherait « LIVRÉ » dès qu'on retire les accents.
 */
function hasMarker(body, marker, flags = 'u') {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(marker)}(?![\\p{L}\\p{N}])`, flags).test(String(body || ''));
}

function claimsDone(body, markers, openWorkMarkers) {
    const done = markers.find(mk => hasMarker(body, mk)) || null;
    if (!done) return null;
    // Réserve explicite quelque part dans le corps → chantier partiellement livré, pas un
    // oubli de clôture. Insensible à la casse ici (« Reste à faire », « RESTE »).
    if (openWorkMarkers.some(mk => hasMarker(body, mk, 'ui'))) return null;
    return done;
}

/**
 * Une ancre interne résout-elle ?
 * @param {{file, locator}} anchor
 * @param {Map<string, {lineCount:number, text?:string}>} repoFiles — indexé par chemin repo-relatif
 * @returns {{ok:boolean, reason?:string, resolvedPath?:string}}
 */
function resolveAnchor(anchor, repoFiles) {
    // Résolution par suffixe : les notes citent souvent le basename (`FormWizard.tsx:43`)
    // là où le repo a un chemin complet. Ambiguïté (2+ candidats) = on ne conclut PAS
    // à un dangling : sur-signaler une ref valide est pire que la laisser passer ici.
    const candidates = repoFiles.has(anchor.file)
        ? [anchor.file]
        : [...repoFiles.keys()].filter(p => p === anchor.file || p.endsWith('/' + anchor.file));

    if (candidates.length === 0) return { ok: false, reason: `fichier introuvable : ${anchor.file}` };
    if (candidates.length > 1) return { ok: true, resolvedPath: candidates[0] };

    const meta = repoFiles.get(candidates[0]);
    if (/^\d/.test(anchor.locator)) {
        const end = Number(anchor.locator.split('-').pop());
        if (meta && Number.isFinite(meta.lineCount) && end > meta.lineCount) {
            return { ok: false, reason: `ligne ${end} hors bornes (${candidates[0]} = ${meta.lineCount} lignes)`, resolvedPath: candidates[0] };
        }
        return { ok: true, resolvedPath: candidates[0] };
    }
    // Ancre symbole — la forme préférée : on cherche le symbole, pas une position.
    if (meta && typeof meta.text === 'string') {
        const re = new RegExp(`(?<![\\w$])${escapeRegExp(anchor.locator)}(?![\\w$])`);
        if (!re.test(meta.text)) {
            return { ok: false, reason: `symbole \`${anchor.locator}\` absent de ${candidates[0]}`, resolvedPath: candidates[0] };
        }
    }
    return { ok: true, resolvedPath: candidates[0] };
}

/**
 * Audite un répertoire de notes.
 *
 * @param {Object} input
 * @param {Array<{path:string, text:string}>} input.notes — fichiers de notes (hors index/README)
 * @param {Array<{path:string, text:string, sources?:string[]}>} [input.indexes] — fichiers index auto-déclarés
 * @param {string[]} [input.planRefs] — chemins référencés par le plan (notes_ref aplatis)
 * @param {Map<string,{lineCount:number,text?:string}>} [input.repoFiles] — index du repo pour les ancres
 * @param {Object} [opts]
 * @param {string[]} [opts.doneMarkers]
 * @param {string[]} [opts.openWorkMarkers] — réserves qui DÉSARMENT self-declared-done
 * @param {Object}   [opts.severity] — surcharge de gravité par kind
 * @param {string[]} [opts.baseline] — empreintes connues → dégradées en `warn`
 * @returns {{findings:Array, summary:{total,errors,warnings,byKind}}}
 */
export function auditNotes(input = {}, opts = {}) {
    const notes = Array.isArray(input.notes) ? input.notes : [];
    const indexes = Array.isArray(input.indexes) ? input.indexes : [];
    const planRefs = Array.isArray(input.planRefs) ? input.planRefs : null;
    const repoFiles = input.repoFiles instanceof Map ? input.repoFiles : null;

    const doneMarkers = opts.doneMarkers || DEFAULT_DONE_MARKERS;
    const openWorkMarkers = opts.openWorkMarkers || DEFAULT_OPEN_WORK_MARKERS;
    const severity = { ...DEFAULT_SEVERITY, ...(opts.severity || {}) };
    const baseline = new Set(opts.baseline || []);
    const indexDatePattern = opts.indexDatePattern || DEFAULT_INDEX_DATE_PATTERN;

    const findings = [];
    const push = (kind, file, title, detail, lineNo) => {
        const f = { kind, file, title, detail, lineNo, severity: severity[kind] || 'warn' };
        f.fingerprint = fingerprint(f);
        if (baseline.has(f.fingerprint)) { f.baselined = true; f.severity = 'warn'; }
        findings.push(f);
    };

    // 1. orphan-file — un fichier qu'aucune étape ne référence n'est jamais relu.
    if (planRefs) {
        const refNorm = planRefs.map(r => normalize(r));
        for (const n of notes) {
            const base = normalize(n.path.split(/[\\/]/).pop());
            if (!refNorm.some(r => r.endsWith(base))) {
                push('orphan-file', n.path, '(fichier entier)', 'référencé par aucune étape du plan', 1);
            }
        }
    }

    // 2..4 — au fil des items.
    for (const n of notes) {
        for (const it of parseNoteItems(n.text, opts)) {
            if (!it.resolved) {
                const mk = claimsDone(it.body, doneMarkers, openWorkMarkers);
                if (mk) {
                    push('self-declared-done', n.path, it.title,
                        `le corps annonce « ${mk} » mais l'item n'est pas marqué RÉSOLU`, it.lineNo);
                }
                continue;
            }
            if (it.anchors.length === 0 && it.externalAnchors.length === 0) {
                push('unproven-resolution', n.path, it.title,
                    'RÉSOLU sans ancre code (la convention exige `fichier:ligne` ou `fichier:SYMBOLE`)', it.lineNo);
                continue;
            }
            if (!repoFiles) continue;
            for (const a of it.anchors) {
                const r = resolveAnchor(a, repoFiles);
                if (!r.ok) push('dangling-anchor', n.path, it.title, `${a.raw} — ${r.reason}`, it.lineNo);
            }
        }
    }

    // 5. stale-index — un index daté plus ancien qu'un item de ses sources ment sur son état.
    for (const idx of indexes) {
        const m = String(idx.text || '').match(indexDatePattern);
        if (!m) continue;
        const declared = m[1];
        const sources = idx.sources && idx.sources.length
            ? notes.filter(n => idx.sources.some(s => n.path.endsWith(s)))
            : notes;
        let newest = null;
        for (const n of sources) {
            for (const it of parseNoteItems(n.text, opts)) {
                for (const d of [it.date, it.resolvedDate]) {
                    if (d && (!newest || d > newest.date)) newest = { date: d, file: n.path };
                }
            }
        }
        if (newest && newest.date > declared) {
            push('stale-index', idx.path, '(index)',
                `se déclare à jour au ${declared} alors que ${newest.file} porte un item daté ${newest.date}`, 1);
        }
    }

    const byKind = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    return {
        findings,
        summary: {
            total: findings.length,
            errors: findings.filter(f => f.severity === 'error').length,
            warnings: findings.filter(f => f.severity !== 'error').length,
            baselined: findings.filter(f => f.baselined).length,
            byKind,
        },
    };
}

/**
 * Le DÉCLENCHEUR de clôture : quels items ouverts citent un fichier que ce push modifie ?
 *
 * C'est le chaînon manquant du cycle de vie. La règle RÉSOLU se déclenche « si un agent
 * re-surface l'item » — jamais, faute de chemin de lecture. Un push qui touche un fichier
 * cité par un item ouvert EST l'événement : à ce moment précis, quelqu'un sait si c'est fait.
 * Informatif par nature (on ne bloque pas un push parce qu'une note parle du fichier).
 *
 * @param {Array<{path,text}>} notes
 * @param {string[]} changedPaths — chemins repo-relatifs modifiés
 * @returns {Array<{file, lineNo, title, matched:string[]}>}
 */
export function relatedOpenItems(notes = [], changedPaths = [], opts = {}) {
    const changed = changedPaths.filter(Boolean);
    const bases = new Map(); // basename → chemins complets
    for (const p of changed) {
        const b = p.split(/[\\/]/).pop();
        bases.set(b, [...(bases.get(b) || []), p]);
    }
    const out = [];
    for (const n of notes) {
        for (const it of parseNoteItems(n.text, opts)) {
            if (it.resolved) continue;
            const matched = [];
            for (const [b, paths] of bases) {
                // Frontière de mot : `Form.tsx` ne doit pas matcher `MyForm.tsx`.
                if (new RegExp(`(?<![\\w/.-])${escapeRegExp(b)}(?![\\w])`).test(it.body)) matched.push(...paths);
            }
            if (matched.length) out.push({ file: n.path, lineNo: it.lineNo, title: it.title, matched: [...new Set(matched)] });
        }
    }
    return out;
}

// ── Rapport ───────────────────────────────────────────────────────────────────

const KIND_LABEL = {
    'self-declared-done': '🔴 Se déclare fait sans être marqué RÉSOLU',
    'stale-index': '🔴 Index périmé (se déclare à jour, ne l\'est pas)',
    'dangling-anchor': '🔴 Ancre code cassée sur un RÉSOLU',
    'unproven-resolution': '🟠 RÉSOLU sans preuve code',
    'orphan-file': '🟠 Fichier de notes jamais relu (aucun notes_ref)',
};

/** Rapport markdown lisible. */
export function formatAuditReport(result, related = []) {
    const { summary, findings } = result;
    const lines = [`# Audit du répertoire de notes`, ''];
    lines.push(`- Constats : **${summary.total}** — ${summary.errors} bloquant(s), ${summary.warnings} avertissement(s)`);
    if (summary.baselined) lines.push(`- Dont **${summary.baselined}** déjà dans la baseline (stock connu, non bloquant)`);
    lines.push('');

    for (const kind of Object.keys(KIND_LABEL)) {
        const group = findings.filter(f => f.kind === kind);
        if (!group.length) continue;
        lines.push(`## ${KIND_LABEL[kind]} — ${group.length}`);
        for (const f of group) {
            const tag = f.baselined ? ' _(baseline)_' : '';
            lines.push(`- \`${f.file}:${f.lineNo}\` — ${f.title}${tag}`);
            if (f.detail) lines.push(`  ${f.detail}`);
        }
        lines.push('');
    }

    if (related.length) {
        lines.push(`## 🟡 Items ouverts qui citent un fichier modifié — ${related.length}`);
        lines.push('_Le travail vient peut-être de les clore. Vérifier dans le code, puis marquer RÉSOLU._');
        for (const r of related) lines.push(`- \`${r.file}:${r.lineNo}\` — ${r.title} → ${r.matched.join(', ')}`);
        lines.push('');
    }

    if (!summary.total && !related.length) lines.push('Répertoire de notes cohérent. ✅');
    return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// isMain via pathToFileURL : robuste cross-OS (le naïf `file://${argv1}` casse sur
// Windows — file:///C:/ vs file://C:/ → CLI jamais déclenché). Cf. GOTCHAS.md.

/** Aplatit les `notes_ref` d'un plan JSON (steps + tracks, noms de clés surchargeables). */
export function flattenPlanRefs(plan, refKey = 'notes_ref') {
    const groups = [];
    for (const v of Object.values(plan || {})) if (Array.isArray(v)) groups.push(...v);
    return groups.flatMap(g => (g && Array.isArray(g[refKey]) ? g[refKey] : []));
}

function parseArgv(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [k, inline] = a.slice(2).split('=');
            out[k] = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
        } else out._.push(a);
    }
    return out;
}

async function readIfExists(p) {
    try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function main(argv) {
    const args = parseArgv(argv);
    const notesDir = args._[0];
    if (!notesDir || args.help) {
        process.stderr.write([
            'usage: notes-audit <notesDir> [options]',
            '',
            '  --plan <f.json>       plan portant les notes_ref (active orphan-file)',
            '  --ref-key <k>         clé des refs dans le plan (défaut: notes_ref)',
            '  --index <f.md>        fichier index auto-déclaré (répétable)',
            '  --exclude <a,b>       basenames à ignorer (défaut: README.md,INBOX.md)',
            '  --repo-files <f>      liste de chemins (un par ligne) pour résoudre les ancres',
            '                        ex: git ls-files > .cache/files.txt',
            '  --changed <f>         liste de fichiers modifiés → items ouverts concernés',
            '                        ex: git diff --name-only origin/main... > .cache/changed.txt',
            '  --baseline <f.json>   empreintes connues, dégradées en avertissement',
            '  --write-baseline <f>  écrit la baseline depuis les constats courants',
            '  --strict              toute gravité devient bloquante',
            '',
        ].join('\n'));
        return 2;
    }

    const exclude = String(args.exclude || 'README.md,INBOX.md').split(',').map(s => s.trim());
    const indexPaths = [].concat(args.index || []).filter(v => typeof v === 'string');
    const indexBases = indexPaths.map(p => p.split(/[\\/]/).pop());

    const entries = (await fs.readdir(notesDir)).filter(f => f.endsWith('.md'));
    const notes = [];
    for (const f of entries) {
        if (exclude.includes(f) || indexBases.includes(f)) continue;
        notes.push({ path: path.join(notesDir, f), text: await fs.readFile(path.join(notesDir, f), 'utf8') });
    }

    const indexes = [];
    for (const p of indexPaths) {
        const text = await readIfExists(p);
        if (text !== null) indexes.push({ path: p, text });
    }

    let planRefs = null;
    if (typeof args.plan === 'string') {
        const raw = await readIfExists(args.plan);
        if (raw !== null) planRefs = flattenPlanRefs(JSON.parse(raw), args['ref-key'] || 'notes_ref');
    }

    let repoFiles = null;
    if (typeof args['repo-files'] === 'string') {
        const raw = await readIfExists(args['repo-files']);
        if (raw !== null) {
            repoFiles = new Map();
            for (const p of raw.split(/\r?\n/).filter(Boolean)) {
                const text = await readIfExists(p);
                if (text === null) continue;
                repoFiles.set(p, { lineCount: text.split('\n').length, text });
            }
        }
    }

    let baseline = [];
    if (typeof args.baseline === 'string') {
        const raw = await readIfExists(args.baseline);
        if (raw !== null) baseline = JSON.parse(raw).fingerprints || [];
    }

    const severity = args.strict
        ? Object.fromEntries(Object.keys(DEFAULT_SEVERITY).map(k => [k, 'error']))
        : undefined;
    const result = auditNotes({ notes, indexes, planRefs, repoFiles }, { baseline, severity });

    let related = [];
    if (typeof args.changed === 'string') {
        const raw = await readIfExists(args.changed);
        if (raw !== null) related = relatedOpenItems(notes, raw.split(/\r?\n/).filter(Boolean));
    }

    if (typeof args['write-baseline'] === 'string') {
        const fps = [...new Set(result.findings.map(f => f.fingerprint))].sort();
        await fs.writeFile(args['write-baseline'], JSON.stringify({ fingerprints: fps }, null, 2) + '\n', 'utf8');
        process.stdout.write(`baseline écrite : ${fps.length} empreinte(s) → ${args['write-baseline']}\n`);
        return 0;
    }

    process.stdout.write(formatAuditReport(result, related) + '\n');
    // Gate : seuls les constats `error` (donc hors baseline) bloquent.
    return result.summary.errors > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main(process.argv.slice(2))
        .then(code => process.exit(code))
        .catch(e => { process.stderr.write(`[notes-audit] fatal: ${e.message}\n`); process.exit(2); });
}

export default auditNotes;
