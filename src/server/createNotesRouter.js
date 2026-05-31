/**
 * createNotesRouter — fabrique un routeur Express pour la prise de notes.
 *
 * Storage-agnostic : tu fournis un `store` qui implémente le contrat (voir
 * ./stores/memoryStore.js). Le routeur n'assume rien sur la persistance.
 *
 * Endpoints montés (relatifs au mount point, ex: app.use('/api/notes', router)) :
 *   POST   /            { text }                 → crée une note (status=pending)
 *   GET    /            ?status=pending|processed → liste les notes
 *   POST   /:id/processed  { backlog_ref? }       → marque une note traitée
 *
 * Forme d'une note :
 *   { id, text, created_at, status: 'pending'|'processed', processed_at, backlog_ref? }
 *
 * Extrait d'Auto-Polymarket (src/routes/orchestratorRoutes.js).
 */

import express from 'express';

const DEFAULTS = {
    maxNoteLen: 2000,   // longueur max d'une note
    maxNotesKept: 100,  // garde les N plus récentes (évite la croissance infinie)
};

function newId() {
    return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {Object}   opts
 * @param {Object}   opts.store            — adaptateur de stockage (contrat ci-dessous)
 * @param {Function} [opts.auth]           — middleware Express optionnel (ex: requireAdmin)
 * @param {number}   [opts.maxNoteLen]     — défaut 2000
 * @param {number}   [opts.maxNotesKept]   — défaut 100
 * @param {Function} [opts.onCreate]       — hook(note) appelé après création (sync flush, log…)
 * @returns {import('express').Router}
 *
 * Contrat `store` (toutes méthodes async-friendly, peuvent retourner une Promise) :
 *   list()                 → Note[]      (plus récentes en premier)
 *   add(note)              → void        (insère en tête)
 *   markProcessed(id, ref) → Note|null   (passe status→processed, set processed_at + backlog_ref)
 *   prune(max)             → void        (optionnel ; tronque à `max`)
 */
export function createNotesRouter(opts = {}) {
    const { store, auth, onCreate } = opts;
    if (!store) throw new Error('createNotesRouter: `store` requis');

    const maxNoteLen = opts.maxNoteLen ?? DEFAULTS.maxNoteLen;
    const maxNotesKept = opts.maxNotesKept ?? DEFAULTS.maxNotesKept;

    const router = express.Router();
    if (auth) router.use(auth);

    // POST / — créer une note
    router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
        try {
            const text = (req.body?.text || '').toString().trim();
            if (!text) return res.status(400).json({ error: 'text required (non-empty)' });
            if (text.length > maxNoteLen) {
                return res.status(400).json({ error: `text too long (max ${maxNoteLen} chars)` });
            }
            const note = {
                id: newId(),
                text,
                created_at: new Date().toISOString(),
                status: 'pending',
                processed_at: null,
            };
            await store.add(note);
            if (store.prune) await store.prune(maxNotesKept);
            if (onCreate) { try { await onCreate(note); } catch { /* non bloquant */ } }
            res.json({ ok: true, note });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET / — lister
    router.get('/', async (req, res) => {
        try {
            const notes = (await store.list()) || [];
            const status = req.query.status;
            const filtered = status ? notes.filter(n => n.status === status) : notes;
            res.json({ notes: filtered, total: notes.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /:id/processed — marquer traité
    router.post('/:id/processed', express.json({ limit: '4kb' }), async (req, res) => {
        try {
            const ref = req.body?.backlog_ref ? String(req.body.backlog_ref).slice(0, 200) : undefined;
            const note = await store.markProcessed(req.params.id, ref);
            if (!note) return res.status(404).json({ error: `unknown note id "${req.params.id}"` });
            res.json({ ok: true, note });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

export default createNotesRouter;
