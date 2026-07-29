import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/server/stores/memoryStore.js';
import { createJsonFileStore } from '../src/server/stores/jsonFileStore.js';

// ── memoryStore ──────────────────────────────────────────────────────────────
test('memoryStore: add insère en tête (newest-first), list copie défensive', () => {
    const s = createMemoryStore();
    s.add({ id: 'a', text: 'x', status: 'pending' });
    s.add({ id: 'b', text: 'y', status: 'pending' });
    const list = s.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'b');
    // list() doit retourner une copie : muter le retour ne casse pas le store
    list.push({ id: 'fake' });
    assert.equal(s.list().length, 2);
});

test('memoryStore: markProcessed met status + processed_at + backlog_ref', () => {
    const s = createMemoryStore();
    s.add({ id: 'a', text: 'x', status: 'pending' });
    const n = s.markProcessed('a', 'BACKLOG.md#x');
    assert.equal(n.status, 'processed');
    assert.equal(n.backlog_ref, 'BACKLOG.md#x');
    assert.ok(n.processed_at);
});

test('memoryStore: markProcessed sans ref ne pose pas backlog_ref', () => {
    const s = createMemoryStore();
    s.add({ id: 'a', text: 'x', status: 'pending' });
    const n = s.markProcessed('a');
    assert.equal(n.status, 'processed');
    assert.equal('backlog_ref' in n, false);
});

test('memoryStore: markProcessed id inconnu → null', () => {
    const s = createMemoryStore();
    assert.equal(s.markProcessed('zzz'), null);
});

test('memoryStore: markAbandoned met status + reason', () => {
    const s = createMemoryStore();
    s.add({ id: 'a', text: 'x', status: 'pending' });
    const n = s.markAbandoned('a', 'doublon');
    assert.equal(n.status, 'abandoned');
    assert.equal(n.reason, 'doublon');
    assert.ok(n.abandoned_at);
    assert.equal(s.markAbandoned('zzz'), null);
});

test('memoryStore: prune tronque aux N plus récents', () => {
    const s = createMemoryStore();
    for (let i = 0; i < 5; i++) s.add({ id: `n${i}`, text: 'x', status: 'pending' });
    s.prune(2);
    const list = s.list();
    assert.equal(list.length, 2);
    // newest-first : n4, n3 conservés
    assert.equal(list[0].id, 'n4');
});

test('memoryStore: prune au-dessus du seuil = no-op', () => {
    const s = createMemoryStore();
    s.add({ id: 'a', text: 'x', status: 'pending' });
    s.prune(100);
    assert.equal(s.list().length, 1);
});

// ── jsonFileStore (temp dir, nettoyé) ────────────────────────────────────────
function tmpFile() {
    return join(tmpdir(), `nb_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

test('jsonFileStore: filePath requis sinon throw', () => {
    assert.throws(() => createJsonFileStore(), /filePath requis/);
});

test('jsonFileStore: add + list persiste après reload (durabilité)', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        await s.add({ id: 'n1', text: 'hello', status: 'pending', created_at: new Date().toISOString() });
        await s.add({ id: 'n2', text: 'world', status: 'pending', created_at: new Date().toISOString() });
        assert.equal((await s.list()).length, 2);
        // re-open : relit le fichier sur disque
        const s2 = createJsonFileStore(f);
        assert.equal((await s2.list()).length, 2);
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: list sur fichier absent → [] (ENOENT toléré)', async () => {
    const f = tmpFile();
    const s = createJsonFileStore(f);
    assert.deepEqual(await s.list(), []);
});

test('jsonFileStore: markProcessed persiste le statut après reload', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        await s.add({ id: 'n1', text: 'x', status: 'pending', created_at: new Date().toISOString() });
        const mp = await s.markProcessed('n1', 'BACKLOG.md#x');
        assert.equal(mp.status, 'processed');
        assert.equal(mp.backlog_ref, 'BACKLOG.md#x');
        const s2 = createJsonFileStore(f);
        assert.equal((await s2.list()).find(n => n.id === 'n1').status, 'processed');
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: markAbandoned persiste reason après reload', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        await s.add({ id: 'n1', text: 'x', status: 'pending', created_at: new Date().toISOString() });
        const ma = await s.markAbandoned('n1', 'doublon');
        assert.equal(ma.status, 'abandoned');
        assert.equal(ma.reason, 'doublon');
        const s2 = createJsonFileStore(f);
        assert.equal((await s2.list()).find(n => n.id === 'n1').reason, 'doublon');
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: mark* sur id inconnu → null', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        await s.add({ id: 'n1', text: 'x', status: 'pending', created_at: new Date().toISOString() });
        assert.equal(await s.markProcessed('zzz'), null);
        assert.equal(await s.markAbandoned('zzz'), null);
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: no-op (id inconnu) ne réécrit pas le fichier (mtime inchangé)', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        await s.add({ id: 'x1', text: 'x', status: 'pending', created_at: new Date().toISOString() });
        const mtime1 = (await fs.stat(f)).mtimeMs;
        await new Promise(r => setTimeout(r, 25));
        assert.equal(await s.markProcessed('inconnu'), null);
        const mtime2 = (await fs.stat(f)).mtimeMs;
        assert.equal(mtime1, mtime2);
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: 20 add concurrents → aucune note perdue (sérialisation)', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        await Promise.all(Array.from({ length: 20 }, (_, i) =>
            s.add({ id: `c${i}`, text: `note ${i}`, status: 'pending', created_at: new Date().toISOString() })));
        assert.equal((await s.list()).length, 20);
        const s2 = createJsonFileStore(f);
        assert.equal((await s2.list()).length, 20);
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: prune persiste la troncature', async () => {
    const f = tmpFile();
    try {
        const s = createJsonFileStore(f);
        for (let i = 0; i < 5; i++) {
            await s.add({ id: `n${i}`, text: 'x', status: 'pending', created_at: new Date().toISOString() });
        }
        await s.prune(2);
        assert.equal((await s.list()).length, 2);
        const s2 = createJsonFileStore(f);
        assert.equal((await s2.list()).length, 2);
    } finally {
        await fs.rm(f, { force: true });
    }
});

test('jsonFileStore: fichier corrompu/non-array → [] (parse défensif)', async () => {
    const f = tmpFile();
    try {
        await fs.writeFile(f, '{"not":"an array"}', 'utf8');
        const s = createJsonFileStore(f);
        assert.deepEqual(await s.list(), []);
    } finally {
        await fs.rm(f, { force: true });
    }
});
