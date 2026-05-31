/**
 * memoryStore — store en mémoire (dev, tests, process unique non-redémarré).
 * Perd tout au restart. Voir jsonFileStore pour de la persistance fichier.
 */
export function createMemoryStore() {
    let notes = [];
    return {
        list: () => notes.slice(),
        add: (note) => { notes.unshift(note); },
        markProcessed: (id, ref) => {
            const n = notes.find(x => x.id === id);
            if (!n) return null;
            n.status = 'processed';
            n.processed_at = new Date().toISOString();
            if (ref) n.backlog_ref = ref;
            return n;
        },
        prune: (max) => { if (notes.length > max) notes.length = max; },
    };
}

export default createMemoryStore;
