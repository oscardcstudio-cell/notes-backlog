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

function log(msg) {
    process.stdout.write(`[${new Date().toISOString()}] [notes-drain] ${msg}\n`);
}

function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalize(s) {
    return stripAccents(String(s || '').toLowerCase());
}

/**
 * Catégorise une note — deux passes :
 * 1. Préfixe explicite "note <alias>: …" → résolution directe (via: 'prefix').
 * 2. Keyword matching en fallback (via: 'keywords').
 * Retourne le sujet gagnant enrichi de `via`, ou null.
 *
 * @param {string} text
 * @param {Array<{id, keywords?, filePath?, marker?}>} subjects
 */
export function categorizeBySubject(text, subjects) {
    // Passe 1 — préfixe "note <alias>: …"
    const prefixMatch = text.match(/^note\s+([a-z\-]+)\s*:/i);
    if (prefixMatch) {
        const alias = normalize(prefixMatch[1]);
        const aliasMap = {
            'produit': 'produit', 'ux': 'produit', 'ui': 'produit', 'design': 'produit',
            'offre': 'offre', 'pricing': 'offre', 'tarif': 'offre',
            'catalogue': 'catalogue', 'cat': 'catalogue', 'data': 'catalogue',
            'monetisation': 'monetisation', 'money': 'monetisation', 'prix': 'monetisation',
            'acquisition': 'acquisition', 'acq': 'acquisition', 'marketing': 'acquisition',
            'tech': 'tech-ops', 'ops': 'tech-ops', 'tech-ops': 'tech-ops', 'infra': 'tech-ops',
            'marque': 'marque', 'brand': 'marque', 'identite': 'marque',
            'vision': 'vision', 'long-terme': 'vision',
        };
        const targetId = aliasMap[alias] || alias;
        const found = subjects.find(s => s.id === targetId);
        if (found) return { ...found, via: 'prefix' };
    }

    // Passe 2 — keyword matching
    const hay = normalize(text);
    let best = null;
    let bestScore = 0;
    for (const s of subjects) {
        let score = 0;
        for (const kw of s.keywords || []) {
            if (hay.includes(normalize(kw))) score++;
        }
        if (score > bestScore) { bestScore = score; best = s; }
    }
    return bestScore > 0 ? { ...best, via: 'keywords' } : null;
}

/** Insère un item TODO juste après le marker dans BACKLOG.md. */
async function appendToBacklog(backlogPath, marker, note, phaseLabel) {
    const raw = await fs.readFile(backlogPath, 'utf8');
    const idx = raw.indexOf(marker);
    if (idx === -1) throw new Error(`"${marker}" introuvable dans ${backlogPath}`);

    const date = (note.created_at || new Date().toISOString()).slice(0, 10);
    const firstLine = (note.text || '').split('\n')[0].slice(0, 80).trim();
    const block = [
        ``,
        `### [LOW][TODO] 📝 Note — ${firstLine}`,
        `- **Découvert** : ${date} — saisie via le widget de notes`,
        ...(phaseLabel ? [`- **Phase** : ${phaseLabel}`] : []),
        `- **Note** :`,
        ...note.text.split('\n').map(l => `  > ${l}`),
        `- **Action** : trier — convertir en item structuré, traiter, ou archiver`,
        `- **Dernière maj** : ${date} — ingérée depuis le widget (note ${note.id})`,
        ``,
    ].join('\n');

    const insertAt = idx + marker.length;
    const updated = raw.slice(0, insertAt) + '\n' + block + raw.slice(insertAt);
    await fs.writeFile(backlogPath, updated, 'utf8');
}

/**
 * Append note dans notes/<sujet>.md (format réservoir : une ligne datée).
 * Multi-lignes → jointes par " / ".
 * Retourne false si le fichier est absent (skip silencieux).
 */
async function appendToNotesFile(filePath, note) {
    try { await fs.access(filePath); } catch {
        log(`⚠ ${path.basename(filePath)} absent — skip (BACKLOG seul)`);
        return false;
    }
    const date = (note.created_at || new Date().toISOString()).slice(0, 10);
    const text = note.text.replace(/\r?\n+/g, ' / ').trim();
    await fs.appendFile(filePath, `- [${date}] ${text} — _(source: widget)_\n`, 'utf8');
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

    let done = 0;
    for (const note of pending.slice().reverse()) {
        try {
            // Catégorisation BACKLOG (legacy companyPhases — marker-based)
            let targetMarker = marker;
            let phaseLabel = null;
            if (categories) {
                const { categorize } = await import('../categorize/categorize.js');
                const cat = await categorize(note.text, categories, { llmClassifier });
                if (cat.marker) { targetMarker = cat.marker; phaseLabel = `${cat.label} (${cat.via})`; }
            }

            // 1. BACKLOG.md
            try {
                await appendToBacklog(backlogPath, targetMarker, note, phaseLabel);
            } catch (e) {
                if (targetMarker !== marker) await appendToBacklog(backlogPath, marker, note, phaseLabel);
                else throw e;
            }

            // 2. notes/<sujet>.md (subjects filePath-based)
            if (subjects && notesDir) {
                const subject = categorizeBySubject(note.text, subjects);
                if (subject) {
                    const filePath = path.join(notesDir, subject.filePath);
                    const ok = await appendToNotesFile(filePath, note);
                    if (ok) log(`  → notes/${subject.filePath} (${subject.id}, via: ${subject.via})`);
                } else {
                    log(`  → sujet non détecté, BACKLOG seul`);
                }
            }

            // 3. Marquer processed
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
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
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
