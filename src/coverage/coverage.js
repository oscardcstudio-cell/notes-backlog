#!/usr/bin/env node
/**
 * coverage — mini-RTM (Requirements Traceability Matrix) en markdown.
 *
 * Croise un BACKLOG/notes ↔ un PLAN/ROADMAP et répond à UNE question :
 * « quelle idée du backlog n'est PAS reprise dans le plan ? » (≈ "lisseur d'idées").
 * C'est le pattern industriel de traçabilité bidirectionnelle (RTM) appliqué au
 * markdown : on détecte les *orphaned items*, ce qu'aucun outil markdown/git ne fait
 * off-the-shelf (Backlog.md = kanban, GSD = couverture des requirements formels).
 *
 * Le cœur reste AGNOSTIQUE (aucune taxonomie, aucun marker hardcodé) — comme
 * categorize/drain. Le caller fournit ses patterns ; les presets sont de la data.
 *
 * Sémantique d'un item de backlog (déterministe, anti-faux-positif) :
 *   - `linked`   : porte un anchor ([[P4]], → landing, ref:auth) résolu dans le plan → COUVERT.
 *   - `broken`   : porte un anchor introuvable dans le plan → lien cassé (priorité haute).
 *   - `unlinked` : aucun anchor → à rattacher (le matching flou ne fait que SUGGÉRER).
 * Le danger qu'on veut tuer (idée perdue) = broken + unlinked. On préfère sur-signaler
 * (faux orphelin = bruit) plutôt que sous-signaler (idée droppée en silence).
 *
 * Utilisable en module (`import { checkCoverage }`) ou en CLI :
 *   notes-coverage <backlog.md> <plan.md>   → rapport + exit 1 si orphelins.
 */

import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';

function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normalise pour comparaison : sans accents, minuscules, espaces compactés. */
function normalize(s) {
    return stripAccents(String(s || '').toLowerCase()).replace(/\s+/g, ' ').trim();
}

/** Échappe les métacaractères regex d'une chaîne (ancre = data arbitraire). */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Une ancre est-elle présente dans le plan sur des FRONTIÈRES d'ancre ?
 * `includes` brut donnait des faux positifs : "p4" matchait "p40"/"sp4" → faux "linked"
 * (l'échec exact que ce module prétend détecter). On exige que l'ancre ne soit pas
 * collée à un caractère alphanumérique de part et d'autre (lookaround sur [a-z0-9]).
 */
function anchorInPlan(anchor, planNorm) {
    const a = normalize(anchor);
    if (!a) return false;
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(a)}(?![a-z0-9])`);
    return re.test(planNorm);
}

// Item de liste markdown, indentation tolérée : -, *, +, 1. ; checkbox [ ]/[x] optionnelle.
const DEFAULT_ITEM_PATTERN = /^[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;

// Anchors explicites : [[token]], → token, -> token, ref:token.
const DEFAULT_ANCHOR_PATTERN = /\[\[([^\]]+)\]\]|(?:→|->|ref:)\s*([^\s,;]+)/gi;

/** Extrait tous les anchors d'un texte d'item. */
function extractAnchors(text, pattern) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const val = (m[1] || m[2] || '').trim();
        if (val) out.push(val);
        if (m.index === re.lastIndex) re.lastIndex++; // garde-fou anti-boucle
    }
    return out;
}

/** Retire les anchors du texte → titre lisible de l'item. */
function stripAnchors(text, pattern) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Parse un markdown de backlog en items.
 * @returns {Array<{raw, title, done, anchors:string[]}>}
 */
export function parseItems(backlogText, opts = {}) {
    const itemPattern = opts.itemPattern || DEFAULT_ITEM_PATTERN;
    const anchorPattern = opts.anchorPattern || DEFAULT_ANCHOR_PATTERN;
    const items = [];
    for (const line of String(backlogText || '').split(/\r?\n/)) {
        const m = line.match(itemPattern);
        if (!m) continue;
        const body = m[2];
        const anchors = extractAnchors(body, anchorPattern);
        const title = stripAnchors(body, anchorPattern);
        if (!title && anchors.length === 0) continue; // ligne vide / puce sans contenu
        items.push({ raw: line.trim(), title, done: (m[1] || '').toLowerCase() === 'x', anchors });
    }
    return items;
}

/** Tokens significatifs d'un titre (≥4 chars, hors stopwords FR/EN courants). */
const STOPWORDS = new Set('avec dans pour sur les des une un le la de du et ou est sont cette ces que qui quoi mais donc plus pas faire fait this that with from have will into your then than been about'.split(' '));
function tokens(s) {
    return normalize(s).split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

/**
 * Croise backlog ↔ plan.
 * @param {string} backlogText
 * @param {string} planText
 * @param {Object} [opts]
 * @param {RegExp} [opts.itemPattern]      — extraction des items (défaut: liste markdown)
 * @param {RegExp} [opts.anchorPattern]    — extraction des anchors (défaut: [[..]] / → / ref:)
 * @param {boolean}[opts.includeDone=false]— compter aussi les items cochés [x]
 * @param {number} [opts.suggestMinTokens=2] — n tokens partagés pour SUGGÉRER (pas affirmer) une présence
 * @returns {{linked:[], broken:[], unlinked:[], summary:{total,linked,broken,unlinked,orphans}}}
 */
export function checkCoverage(backlogText, planText, opts = {}) {
    const includeDone = opts.includeDone === true;
    const suggestMinTokens = Number.isFinite(opts.suggestMinTokens) ? opts.suggestMinTokens : 2;
    const planNorm = normalize(planText);

    const all = parseItems(backlogText, opts).filter(it => includeDone || !it.done);
    const linked = [], broken = [], unlinked = [];

    for (const it of all) {
        if (it.anchors.length > 0) {
            const resolved = it.anchors.filter(a => anchorInPlan(a, planNorm));
            const missing = it.anchors.filter(a => !anchorInPlan(a, planNorm));
            if (resolved.length > 0 && missing.length === 0) {
                linked.push({ ...it, resolved });
            } else {
                broken.push({ ...it, resolved, missing });
            }
        } else {
            // Pas d'anchor : on classe orphelin, mais on SUGGÈRE une présence possible.
            const titleInPlan = it.title && planNorm.includes(normalize(it.title));
            const shared = tokens(it.title).filter(t => planNorm.includes(t));
            const maybeInPlan = Boolean(titleInPlan) || shared.length >= suggestMinTokens;
            unlinked.push({ ...it, maybeInPlan, sharedTokens: shared });
        }
    }

    return {
        linked, broken, unlinked,
        summary: {
            total: all.length,
            linked: linked.length,
            broken: broken.length,
            unlinked: unlinked.length,
            orphans: broken.length + unlinked.length,
        },
    };
}

/** Rapport markdown lisible. */
export function formatCoverageReport(result) {
    const { summary, broken, unlinked } = result;
    const lines = [];
    lines.push(`# Couverture backlog ↔ plan (mini-RTM)`);
    lines.push('');
    lines.push(`- Items analysés : **${summary.total}**`);
    lines.push(`- ✅ Couverts (anchor résolu) : **${summary.linked}**`);
    lines.push(`- 🔴 Liens cassés (anchor introuvable) : **${summary.broken}**`);
    lines.push(`- 🟠 Non rattachés (aucun anchor) : **${summary.unlinked}**`);
    lines.push('');
    if (broken.length) {
        lines.push(`## 🔴 Liens cassés — anchor déclaré mais absent du plan`);
        for (const it of broken) lines.push(`- ${it.title || it.raw} — manquant : ${it.missing.map(a => `\`${a}\``).join(', ')}`);
        lines.push('');
    }
    if (unlinked.length) {
        lines.push(`## 🟠 Non rattachés — à relier au plan (ajouter un anchor [[…]])`);
        for (const it of unlinked) {
            const hint = it.maybeInPlan ? ` _(peut-être déjà dans le plan : ${it.sharedTokens.slice(0, 4).join(', ') || 'titre exact'})_` : '';
            lines.push(`- ${it.title || it.raw}${hint}`);
        }
        lines.push('');
    }
    if (summary.orphans === 0) lines.push(`Tout le backlog est couvert par le plan. ✅`);
    return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// isMain via pathToFileURL : robuste cross-OS (le naïf `file://${argv1}` casse sur
// Windows — file:///C:/ vs file://C:/ → CLI jamais déclenché). Cf. GOTCHAS.md.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const [backlogPath, planPath] = process.argv.slice(2);
    if (!backlogPath || !planPath) {
        process.stderr.write('usage: notes-coverage <backlog.md> <plan.md>\n');
        process.exit(2);
    }
    const [backlogText, planText] = await Promise.all([
        fs.readFile(backlogPath, 'utf8'),
        fs.readFile(planPath, 'utf8'),
    ]);
    const result = checkCoverage(backlogText, planText);
    process.stdout.write(formatCoverageReport(result) + '\n');
    // Gate : exit 1 si une idée risque d'être perdue (broken ou unlinked).
    process.exit(result.summary.orphans > 0 ? 1 : 0);
}

export default checkCoverage;
