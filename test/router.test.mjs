import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createNotesRouter } from '../src/server/createNotesRouter.js';
import { createMemoryStore } from '../src/server/stores/memoryStore.js';

// Aide : monte un router sur un serveur http éphémère, renvoie base url + close.
async function mount(opts) {
    const app = express();
    app.use('/api/notes', createNotesRouter(opts));
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}/api/notes`;
    return { base, close: () => new Promise(r => srv.close(r)) };
}

const jpost = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

// ── validation au montage ────────────────────────────────────────────────────
test('createNotesRouter: store manquant → throw', () => {
    assert.throws(() => createNotesRouter({}), /`store` requis/);
});

test('createNotesRouter: enforceAuth sans auth → throw', () => {
    assert.throws(
        () => createNotesRouter({ store: createMemoryStore(), enforceAuth: true }),
        /`auth` requis/,
    );
});

// ── cycle de vie HTTP complet ────────────────────────────────────────────────
test('createNotesRouter: parcours HTTP complet (create/list/processed/abandoned)', async (t) => {
    const store = createMemoryStore();
    const { base, close } = await mount({ store, maxNotesKept: 5 });
    t.after(close);

    // POST / crée une note
    let rr = await jpost(base, { text: 'ma note http' });
    let jd = await rr.json();
    assert.equal(rr.status, 200);
    assert.equal(jd.ok, true);
    assert.ok(jd.note.id);
    assert.equal(jd.note.status, 'pending');
    const createdId = jd.note.id;

    // texte vide → 400
    rr = await jpost(base, { text: '' });
    assert.equal(rr.status, 400);

    // texte whitespace-only (trim) → 400
    rr = await jpost(base, { text: '   ' });
    assert.equal(rr.status, 400);

    // text non-string (objet) → 400 type strict (pas de coercion '[object Object]')
    rr = await jpost(base, { text: { evil: 1 } });
    assert.equal(rr.status, 400);

    // text number → 400
    rr = await jpost(base, { text: 12345 });
    assert.equal(rr.status, 400);

    // GET ?status=pending → 1 note (la valide créée)
    rr = await fetch(`${base}?status=pending`);
    jd = await rr.json();
    assert.equal(rr.status, 200);
    assert.equal(jd.notes.length, 1);
    assert.equal(jd.total, 1);

    // GET ?status invalide → 400 (whitelist)
    rr = await fetch(`${base}?status=bogus`);
    assert.equal(rr.status, 400);

    // POST /:id/processed
    rr = await jpost(`${base}/${createdId}/processed`, { backlog_ref: 'BACKLOG.md' });
    jd = await rr.json();
    assert.equal(rr.status, 200);
    assert.equal(jd.note.status, 'processed');
    assert.equal(jd.note.backlog_ref, 'BACKLOG.md');

    // id inconnu → 404
    rr = await jpost(`${base}/nope/processed`, {});
    assert.equal(rr.status, 404);

    // abandoned
    const ab = await jpost(base, { text: 'à abandonner' });
    const abId = (await ab.json()).note.id;
    rr = await jpost(`${base}/${abId}/abandoned`, { reason: 'doublon' });
    jd = await rr.json();
    assert.equal(rr.status, 200);
    assert.equal(jd.note.status, 'abandoned');
    assert.equal(jd.note.reason, 'doublon');

    rr = await jpost(`${base}/nope/abandoned`, {});
    assert.equal(rr.status, 404);
});

test('createNotesRouter: GET sans filtre renvoie tout + total', async (t) => {
    const store = createMemoryStore();
    const { base, close } = await mount({ store });
    t.after(close);
    await jpost(base, { text: 'a' });
    await jpost(base, { text: 'b' });
    const rr = await fetch(base);
    const jd = await rr.json();
    assert.equal(jd.notes.length, 2);
    assert.equal(jd.total, 2);
});

test('createNotesRouter: status array (?status=a&status=b) normalisé en scalaire', async (t) => {
    const store = createMemoryStore();
    const { base, close } = await mount({ store });
    t.after(close);
    await jpost(base, { text: 'a' });
    // ?status=pending&status=processed → Express donne un array, on prend le 1er
    const rr = await fetch(`${base}?status=pending&status=processed`);
    const jd = await rr.json();
    assert.equal(rr.status, 200);
    assert.equal(jd.notes.length, 1); // filtré sur 'pending'
});

test('createNotesRouter: maxNoteLen dépassé → 400', async (t) => {
    const store = createMemoryStore();
    const { base, close } = await mount({ store, maxNoteLen: 10 });
    t.after(close);
    const rr = await jpost(base, { text: 'x'.repeat(50) });
    assert.equal(rr.status, 400);
});

test('createNotesRouter: onCreate appelé pour chaque note AVANT prune', async (t) => {
    const seen = [];
    const store = createMemoryStore();
    const { base, close } = await mount({ store, maxNotesKept: 1, onCreate: (n) => seen.push(n.id) });
    t.after(close);
    await jpost(base, { text: 'note A' });
    await jpost(base, { text: 'note B' }); // prune à 1 après chaque add
    assert.equal(seen.length, 2);
    // après prune à 1, le store ne garde qu'une note
    assert.equal(store.list().length, 1);
});

test('createNotesRouter: backlog_ref tronqué à 200 chars', async (t) => {
    const store = createMemoryStore();
    const { base, close } = await mount({ store });
    t.after(close);
    const { note } = await (await jpost(base, { text: 'x' })).json();
    const rr = await jpost(`${base}/${note.id}/processed`, { backlog_ref: 'r'.repeat(500) });
    const jd = await rr.json();
    assert.equal(jd.note.backlog_ref.length, 200);
});
