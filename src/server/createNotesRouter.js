/**
 * createNotesRouter — fabrique un routeur Express pour la prise de notes.
 *
 * Storage-agnostic : tu fournis un `store` qui implémente le contrat (voir
 * ./stores/memoryStore.js). Le routeur n'assume rien sur la persistance.
 *
 * Endpoints montés (relatifs au mount point, ex: app.use('/api/notes', router)) :
 *   POST   /            { text }                 → crée une note (status=pending)
 *   GET    /            ?status=pending|processed|abandoned → liste les notes
 *   POST   /:id/processed  { backlog_ref? }       → marque une note traitée
 *   POST   /:id/abandoned  { reason? }            → marque une note abandonnée (rejetée)
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

const VALID_STATUS = new Set(['pending', 'processed', 'abandoned']);

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
 * @param {boolean}  [opts.enforceAuth]    — si true, throw au montage quand `auth` absent
 *        (refuse de monter des endpoints d'écriture disque non protégés). Défaut false
 *        (rétro-compat) mais un warn est émis si `auth` manque.
 * @returns {import('express').Router}
 *
 * Contrat `store` (toutes méthodes async-friendly, peuvent retourner une Promise) :
 *   list()                      → Note[]    (plus récentes en premier)
 *   add(note)                   → void      (insère en tête)
 *   markProcessed(id, ref)      → Note|null (passe status→processed, set processed_at + backlog_ref)
 *   markAbandoned(id, reason?)  → Note|null (passe status→abandoned, set abandoned_at + reason)
 *   prune(max)                  → void      (optionnel ; tronque à `max`)
 */
export function createNotesRouter(opts = {}) {
    const { store, auth, onCreate } = opts;
    if (!store) throw new Error('createNotesRouter: `store` requis');

    // Sans `auth`, TOUS les endpoints (création, liste, processed/abandoned) sont publics
    // et exposent l'écriture disque du store. `enforceAuth` refuse alors le montage ;
    // sinon on émet un warn explicite (le silence faisait passer ça inaperçu en prod).
    if (!auth) {
        if (opts.enforceAuth) throw new Error('createNotesRouter: `auth` requis (enforceAuth=true) — endpoints non protégés refusés');
        console.warn('[notes-backlog] ⚠ createNotesRouter monté SANS `auth` — endpoints publics (écriture disque exposée). Passe un middleware `auth` ou enforceAuth:true.');
    }

    const maxNoteLen = opts.maxNoteLen ?? DEFAULTS.maxNoteLen;
    const maxNotesKept = opts.maxNotesKept ?? DEFAULTS.maxNotesKept;

    const router = express.Router();
    if (auth) router.use(auth);

    // POST / — créer une note
    router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
        try {
            // Type strict : un body { text: {...} } / number / array était coercé via
            // .toString() ('[object Object]', '1,2'…) et accepté comme note valide.
            if (typeof req.body?.text !== 'string') {
                return res.status(400).json({ error: 'text required (string)' });
            }
            const text = req.body.text.trim();
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
            // onCreate AVANT prune : sinon un maxNotesKept bas (ou un ajout concurrent)
            // peut évincer la note avant le hook → flush/drain d'une note déjà absente.
            if (onCreate) { try { await onCreate(note); } catch { /* non bloquant */ } }
            if (store.prune) await store.prune(maxNotesKept);
            res.json({ ok: true, note });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET / — lister
    router.get('/', async (req, res) => {
        try {
            const notes = (await store.list()) || [];
            // ?status=a&status=b → Express donne un ARRAY → n.status === [array] est
            // toujours false → liste vide silencieuse. On normalise en string (1er élément
            // si array) pour garder une comparaison scalaire fiable.
            const rawStatus = req.query.status;
            const status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
            if (status && !VALID_STATUS.has(String(status))) {
                return res.status(400).json({ error: `invalid status (expected ${[...VALID_STATUS].join('|')})` });
            }
            const filtered = status ? notes.filter(n => n.status === String(status)) : notes;
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

    // POST /:id/abandoned — marquer abandonnée (rejetée sans drain)
    router.post('/:id/abandoned', express.json({ limit: '4kb' }), async (req, res) => {
        try {
            const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : undefined;
            const note = await store.markAbandoned(req.params.id, reason);
            if (!note) return res.status(404).json({ error: `unknown note id "${req.params.id}"` });
            res.json({ ok: true, note });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

export default createNotesRouter;
