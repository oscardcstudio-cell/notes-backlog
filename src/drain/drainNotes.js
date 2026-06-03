#!/usr/bin/env node
/**
 * drainNotes — pont notes (API) → BACKLOG.md.
 *
 * 1. GET  {baseUrl}{notesPath}?status=pending   (headers d'auth optionnels)
 * 2. Append chaque note au BACKLOG.md sous une section marqueur, en item TODO
 * 3. POST {baseUrl}{notesPath}/:id/processed     → marque traité côté serveur
 *
 * Fail-soft : si le serveur est down ou le token absent, on log et on sort
 * proprement (les notes restent pending, drainées au prochain run).
 *
 * Utilisable en module (`import { drainNotes }`) ou en CLI (`notes-drain`).
 * Config via options OU variables d'env (NOTES_BASE_URL, NOTES_PATH,
 * NOTES_AUTH_HEADER, NOTES_AUTH_VALUE, NOTES_BACKLOG_PATH).
 *
 * Extrait d'Auto-Polymarket (scripts/drain_notes.js).
 */

import { promises as fs } from 'fs';
import { categorize } from '../categorize/categorize.js';

function log(msg) {
    process.stdout.write(`[${new Date().toISOString()}] [notes-drain] ${msg}\n`);
}

// Insère un bloc d'item juste après la ligne marqueur du BACKLOG.
// `phaseLabel` (optionnel) annote la note avec sa catégorie/phase de rangement.
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
 * @param {Object} opts
 * @param {string} opts.baseUrl       — ex: 'https://app.example.com'
 * @param {string} [opts.notesPath]   — défaut '/api/notes'
 * @param {string} opts.backlogPath   — chemin absolu du BACKLOG.md
 * @param {string} [opts.marker]      — section où insérer (défaut '## À faire')
 * @param {Object} [opts.authHeaders] — headers d'auth (ex: { 'x-admin-token': '…' })
 * @param {number} [opts.timeoutMs]   — défaut 8000
 * @param {Array}  [opts.categories]  — buckets de rangement (ex: presets/companyPhases).
 *        Si fourni, chaque note est classée et insérée sous le `marker` de sa catégorie.
 *        Absent → comportement historique (tout sous le marker global).
 * @param {Function} [opts.llmClassifier] — fallback async (text, categories)=>id, appelé
 *        seulement quand les règles ne tranchent pas. Aucun client LLM embarqué.
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
    // Plus anciennes → plus récentes pour un ordre BACKLOG cohérent.
    for (const note of pending.slice().reverse()) {
        try {
            // Catégorisation optionnelle → marker de la phase, sinon marker global.
            let targetMarker = marker;
            let phaseLabel = null;
            if (categories) {
                const cat = await categorize(note.text, categories, { llmClassifier });
                if (cat.marker) { targetMarker = cat.marker; phaseLabel = `${cat.label} (${cat.via})`; }
            }
            try {
                await appendToBacklog(backlogPath, targetMarker, note, phaseLabel);
            } catch (e) {
                // Section de phase absente du BACKLOG → repli sur le marker global.
                if (targetMarker !== marker) await appendToBacklog(backlogPath, marker, note, phaseLabel);
                else throw e;
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
