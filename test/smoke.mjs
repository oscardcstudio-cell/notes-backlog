import http from 'http';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMemoryStore } from '../src/server/stores/memoryStore.js';
import { createJsonFileStore } from '../src/server/stores/jsonFileStore.js';
import { drainNotes } from '../src/drain/drainNotes.js';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗', m); } else console.log('  ✓', m); };

// 1) memoryStore
console.log('memoryStore');
const ms = createMemoryStore();
ms.add({ id: 'a', text: 'x', status: 'pending' });
ms.add({ id: 'b', text: 'y', status: 'pending' });
ok(ms.list().length === 2, 'add x2');
ok(ms.list()[0].id === 'b', 'newest first');
ok(ms.markProcessed('a').status === 'processed', 'markProcessed');
ok(ms.markProcessed('zzz') === null, 'unknown id → null');
ms.prune(1);
ok(ms.list().length === 1, 'prune');

// 2) jsonFileStore
console.log('jsonFileStore');
const f = join(tmpdir(), `nb_${Date.now()}.json`);
const js = createJsonFileStore(f);
await js.add({ id: 'n1', text: 'hello', status: 'pending', created_at: new Date().toISOString() });
await js.add({ id: 'n2', text: 'world', status: 'pending', created_at: new Date().toISOString() });
ok((await js.list()).length === 2, 'persisted x2');
const mp = await js.markProcessed('n1', 'BACKLOG.md#x');
ok(mp && mp.status === 'processed' && mp.backlog_ref === 'BACKLOG.md#x', 'markProcessed + ref');
const js2 = createJsonFileStore(f); // re-open → durabilité
ok((await js2.list()).find(n => n.id === 'n1').status === 'processed', 'reload persists state');

// 3) drainNotes contre un mock serveur + vrai BACKLOG.md
console.log('drainNotes → BACKLOG.md');
const backlog = join(tmpdir(), `BACKLOG_${Date.now()}.md`);
await fs.writeFile(backlog, '# Backlog\n\n## À faire\n\n## Done\n', 'utf8');
// Comme la vraie API (unshift) : newest-first.
const serverNotes = [
    { id: 's2', text: 'deuxième', status: 'pending', created_at: '2026-05-31T11:00:00.000Z' },
    { id: 's1', text: 'première note\nligne2', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' },
];
const processed = [];
const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/notes')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ notes: serverNotes.filter(n => n.status === 'pending'), total: serverNotes.length }));
    }
    const m = req.url.match(/^\/api\/notes\/([^/]+)\/processed$/);
    if (req.method === 'POST' && m) {
        const n = serverNotes.find(x => x.id === decodeURIComponent(m[1]));
        if (n) { n.status = 'processed'; processed.push(n.id); }
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: !!n, note: n || null }));
    }
    res.statusCode = 404; res.end('{}');
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;
const result = await drainNotes({ baseUrl: `http://127.0.0.1:${port}`, backlogPath: backlog, marker: '## À faire' });
srv.close();
ok(result.drained === 2, 'drained 2');
ok(processed.length === 2, 'both marked processed');
const bl = await fs.readFile(backlog, 'utf8');
ok(bl.includes('📝 Note — première note'), 'BACKLOG contient note 1 (titre = 1re ligne)');
ok(bl.includes('  > ligne2'), 'note multiligne quotée');
ok(bl.indexOf('## À faire') < bl.indexOf('📝 Note') && bl.indexOf('📝 Note') < bl.indexOf('## Done'), 'inséré entre marqueur et Done');
ok(bl.indexOf('deuxième') < bl.indexOf('première'), 'plus récente en haut (newest-first)');

// cleanup
await fs.rm(f, { force: true }); await fs.rm(`${f}.tmp`, { force: true }); await fs.rm(backlog, { force: true });
console.log(fail === 0 ? '\nALL GREEN' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
