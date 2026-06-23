/**
 * jsonFileStore — persistance fichier JSON (zéro DB requise).
 *
 * Écrit les notes dans un fichier JSON (atomique : write tmp + rename).
 * Convient aux projets sans base, ou avec un volume persistant monté.
 *
 * ⚠ Sur un host éphémère (Railway-like sans volume), le fichier est perdu au
 *   redeploy. Pour de la durabilité forte, écris un store sur ta DB (Postgres,
 *   Supabase…) en respectant le même contrat (list/add/markProcessed/prune).
 *
 * Sérialisation : les écritures sont chaînées (queue) pour éviter les races.
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

export function createJsonFileStore(filePath) {
    if (!filePath) throw new Error('createJsonFileStore: filePath requis');
    let writeChain = Promise.resolve();

    async function read() {
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
    }

    async function writeAtomic(notes) {
        await fs.mkdir(dirname(filePath), { recursive: true });
        // tmp à nom UNIQUE (pid + uuid + timestamp) : la chaîne writeChain ne sérialise
        // que DANS ce process. Deux process (PID recyclés en conteneur) partageant un tmp
        // à nom fixe le corrompraient — l'uuid l'évite. Hypothèse de design : single-writer ;
        // le rename reste atomique.
        const tmp = `${filePath}.${process.pid}.${randomUUID()}.${Date.now()}.tmp`;
        try {
            await fs.writeFile(tmp, JSON.stringify(notes, null, 2), 'utf8');
            await fs.rename(tmp, filePath);
        } catch (e) {
            // stringify/writeFile/rename a throw → nettoyer le tmp orphelin.
            await fs.unlink(tmp).catch(() => {});
            throw e;
        }
    }

    // Mutation sérialisée : lit l'état courant, applique `mutator`, réécrit SI muté.
    // `mutator` retourne { value, changed } — on n'écrit pas le fichier sur un no-op
    // (markProcessed/markAbandoned sur id inconnu) : évite une réécriture inutile et
    // une fenêtre d'I/O sans raison à chaque 404.
    function mutate(mutator) {
        const next = writeChain.then(async () => {
            const notes = await read();
            const { value, changed } = await mutator(notes);
            if (changed) await writeAtomic(notes);
            return value;
        });
        writeChain = next.then(() => {}, () => {}); // ne casse pas la chaîne sur erreur
        return next;
    }

    return {
        // list chaîné sur writeChain : reflète l'état COMMITÉ (un list() juste après un
        // add() non-attendu voit bien la note, plutôt qu'un état d'avant rename).
        list: () => writeChain.then(() => read()),
        add: (note) => mutate(notes => { notes.unshift(note); return { value: undefined, changed: true }; }),
        markProcessed: (id, ref) => mutate(notes => {
            const n = notes.find(x => x.id === id);
            if (!n) return { value: null, changed: false };
            n.status = 'processed';
            n.processed_at = new Date().toISOString();
            if (ref) n.backlog_ref = ref;
            return { value: n, changed: true };
        }),
        markAbandoned: (id, reason) => mutate(notes => {
            const n = notes.find(x => x.id === id);
            if (!n) return { value: null, changed: false };
            n.status = 'abandoned';
            n.abandoned_at = new Date().toISOString();
            if (reason) n.reason = reason;
            return { value: n, changed: true };
        }),
        prune: (max) => mutate(notes => {
            if (notes.length > max) { notes.length = max; return { value: undefined, changed: true }; }
            return { value: undefined, changed: false };
        }),
    };
}

export default createJsonFileStore;
