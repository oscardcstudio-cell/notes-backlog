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
        const tmp = `${filePath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(notes, null, 2), 'utf8');
        await fs.rename(tmp, filePath);
    }

    // Mutation sérialisée : lit l'état courant, applique `mutator`, réécrit.
    function mutate(mutator) {
        const next = writeChain.then(async () => {
            const notes = await read();
            const result = await mutator(notes);
            await writeAtomic(notes);
            return result;
        });
        writeChain = next.then(() => {}, () => {}); // ne casse pas la chaîne sur erreur
        return next;
    }

    return {
        list: () => read(),
        add: (note) => mutate(notes => { notes.unshift(note); }),
        markProcessed: (id, ref) => mutate(notes => {
            const n = notes.find(x => x.id === id);
            if (!n) return null;
            n.status = 'processed';
            n.processed_at = new Date().toISOString();
            if (ref) n.backlog_ref = ref;
            return n;
        }),
        prune: (max) => mutate(notes => { if (notes.length > max) notes.length = max; }),
    };
}

export default createJsonFileStore;
