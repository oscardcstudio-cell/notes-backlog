import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainNotes, categorizeBySubject } from '../src/drain/drainNotes.js';

function tmp(prefix, ext = 'md') {
    return join(tmpdir(), `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

// Serveur mock API notes (jamais d'appel réseau réel) : GET pending + POST /processed.
function mockServer(notes) {
    const processed = [];
    const srv = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/api/notes')) {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ notes: notes.filter(n => n.status === 'pending') }));
        }
        const m = req.url.match(/^\/api\/notes\/([^/]+)\/processed$/);
        if (req.method === 'POST' && m) {
            const n = notes.find(x => x.id === decodeURIComponent(m[1]));
            if (n) { n.status = 'processed'; processed.push(n.id); }
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ ok: !!n }));
        }
        res.statusCode = 404; res.end('{}');
    });
    return { srv, processed };
}

async function listen(srv) {
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${srv.address().port}`;
}

// ── categorizeBySubject (pur, sans I/O) ──────────────────────────────────────
test('categorizeBySubject: préfixe "note <alias>:" → via prefix', () => {
    const r = categorizeBySubject("note tech-ops: revoir l'infra", [{ id: 'tech-ops', filePath: 'tech-ops.md', keywords: [] }]);
    assert.equal(r.via, 'prefix');
    assert.equal(r.id, 'tech-ops');
});

test('categorizeBySubject: préfixe alphanumérique "note p4:"', () => {
    const r = categorizeBySubject('note p4: pricing', [{ id: 'p4', filePath: 'p4.md', keywords: [] }]);
    assert.equal(r.id, 'p4');
    assert.equal(r.via, 'prefix');
});

test('categorizeBySubject: aliasMap résout alias → id', () => {
    const r = categorizeBySubject('note infra: serveur', [{ id: 'tech-ops', filePath: 't.md', keywords: [] }], { infra: 'tech-ops' });
    assert.equal(r.id, 'tech-ops');
    assert.equal(r.via, 'prefix');
});

test('categorizeBySubject: fallback keywords quand pas de préfixe', () => {
    const r = categorizeBySubject('blabla infra serveur', [{ id: 'tech-ops', filePath: 't.md', keywords: ['infra'] }]);
    assert.equal(r.via, 'keywords');
    assert.equal(r.id, 'tech-ops');
});

test('categorizeBySubject: aucun match → null', () => {
    assert.equal(categorizeBySubject('rien', [{ id: 'x', filePath: 'x.md', keywords: ['zzz'] }]), null);
});

test('categorizeBySubject: préfixe accentué capté via stripAccents (éco → eco)', () => {
    // stripAccents est appliqué AVANT le match préfixe → "note éco:" matche l'id "eco".
    const r = categorizeBySubject('note éco: budget', [{ id: 'eco', filePath: 'e.md', keywords: [] }]);
    assert.equal(r.id, 'eco');
    assert.equal(r.via, 'prefix');
});

// ── drainNotes — garde-fous early-return (pas d'I/O) ─────────────────────────
test('drainNotes: baseUrl absent → drained 0', async () => {
    const r = await drainNotes({ backlogPath: '/x.md' });
    assert.deepEqual(r, { drained: 0, pending: 0 });
});

test('drainNotes: backlogPath absent → drained 0', async () => {
    const r = await drainNotes({ baseUrl: 'http://127.0.0.1:1' });
    assert.deepEqual(r, { drained: 0, pending: 0 });
});

// ── drainNotes — flux complet vers BACKLOG temp ──────────────────────────────
test('drainNotes: insère les notes sous le marker, newest-first, marque processed', async () => {
    const backlog = tmp('BACKLOG');
    const { srv, processed } = mockServer([
        { id: 's2', text: 'deuxième', status: 'pending', created_at: '2026-05-31T11:00:00.000Z' },
        { id: 's1', text: 'première note\nligne2', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' },
    ]);
    try {
        await fs.writeFile(backlog, '# Backlog\n\n## À faire\n\n## Done\n', 'utf8');
        const base = await listen(srv);
        const result = await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire' });
        assert.equal(result.drained, 2);
        assert.equal(processed.length, 2);
        const bl = await fs.readFile(backlog, 'utf8');
        assert.ok(bl.includes('📝 Note — première note'));
        assert.ok(bl.includes('  > ligne2'));
        assert.ok(bl.indexOf('## À faire') < bl.indexOf('📝 Note'));
        assert.ok(bl.indexOf('📝 Note') < bl.indexOf('## Done'));
        // newest-first : s2 (deuxième) au-dessus de s1 (première)
        assert.ok(bl.indexOf('deuxième') < bl.indexOf('première'));
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: idempotent — note déjà présente non dupliquée mais re-marquée', async () => {
    const backlog = tmp('BACKLOG_IDEM');
    const { srv } = mockServer([{ id: 's3', text: 'déjà drainée', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    try {
        await fs.writeFile(backlog, [
            '# Backlog', '', '## À faire', '',
            '- ingérée depuis le widget (note s3)', '', '## Done', '',
        ].join('\n'), 'utf8');
        const base = await listen(srv);
        const r = await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire' });
        assert.equal(r.drained, 1); // re-marquée processed
        const bl = await fs.readFile(backlog, 'utf8');
        assert.equal((bl.match(/note s3/g) || []).length, 1); // non dupliquée
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: collision de préfixe d\'ID (s3 vs s30) — pas de faux skip', async () => {
    const backlog = tmp('BACKLOG_PFX');
    const { srv } = mockServer([{ id: 's3', text: 'note courte', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    try {
        await fs.writeFile(backlog, [
            '# Backlog', '', '## À faire', '',
            '- ingérée depuis le widget (note s30)', '', '## Done', '',
        ].join('\n'), 'utf8');
        const base = await listen(srv);
        const r = await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire' });
        assert.equal(r.drained, 1);
        const bl = await fs.readFile(backlog, 'utf8');
        assert.ok(bl.includes('(note s3)') && bl.includes('(note s30)'));
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: poison-pill — note sans texte ne crashe pas, titre fallback', async () => {
    const backlog = tmp('BACKLOG_POISON');
    const { srv } = mockServer([{ id: 'p1', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    try {
        await fs.writeFile(backlog, '# Backlog\n\n## À faire\n\n## Done\n', 'utf8');
        const base = await listen(srv);
        const r = await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire' });
        assert.equal(r.drained, 1);
        const bl = await fs.readFile(backlog, 'utf8');
        assert.ok(bl.includes('📝 Note — (sans titre)'));
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: BACKLOG absent → drained 0, note reste pending', async () => {
    const notes = [{ id: 'a1', text: 'note', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }];
    const { srv } = mockServer(notes);
    try {
        const base = await listen(srv);
        const r = await drainNotes({ baseUrl: base, backlogPath: tmp('NOPE'), marker: '## À faire' });
        assert.equal(r.drained, 0);
        assert.equal(notes[0].status, 'pending');
    } finally {
        srv.close();
    }
});

test('drainNotes: marker absent → drained 0, note jamais marquée processed', async () => {
    const backlog = tmp('NOMARK');
    const notes = [{ id: 'm1', text: 'note', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }];
    const { srv } = mockServer(notes);
    try {
        await fs.writeFile(backlog, '# Backlog\n\n## Autre section\n', 'utf8');
        const base = await listen(srv);
        const r = await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire' });
        assert.equal(r.drained, 0);
        assert.equal(notes[0].status, 'pending');
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: catégorisé — note rangée sous la section de phase', async () => {
    const backlog = tmp('BACKLOG_CAT');
    const { srv } = mockServer([{ id: 'c1', text: 'revoir le tarif', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    const cats = [
        { id: 'pricing', label: 'Pricing', marker: '## Pricing', keywords: ['tarif'] },
        { id: 'misc', marker: '## À trier', keywords: [], default: true },
    ];
    try {
        await fs.writeFile(backlog, '# Backlog\n\n## À faire\n\n## Pricing\n\n## Brand\n\n## Done\n', 'utf8');
        const base = await listen(srv);
        await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire', categories: cats });
        const bl = await fs.readFile(backlog, 'utf8');
        assert.ok(bl.indexOf('## Pricing') < bl.indexOf('📝 Note'));
        assert.ok(bl.indexOf('📝 Note') < bl.indexOf('## Brand'));
        assert.ok(bl.includes('- **Phase** : Pricing'));
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: fallback — section de phase absente → repli sur marker global', async () => {
    const backlog = tmp('BACKLOG_FB');
    const { srv } = mockServer([{ id: 'fb1', text: 'revoir le tarif', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    const cats = [
        { id: 'pricing', label: 'Pricing', marker: '## Pricing', keywords: ['tarif'] },
        { id: 'misc', marker: '## À trier', keywords: [], default: true },
    ];
    try {
        await fs.writeFile(backlog, '# Backlog\n\n## À trier\n', 'utf8'); // pas de ## Pricing
        const base = await listen(srv);
        const r = await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À trier', categories: cats });
        const bl = await fs.readFile(backlog, 'utf8');
        assert.equal(r.drained, 1);
        assert.ok(bl.includes('📝 Note — revoir le tarif'));
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: injection markdown — un marker dans le texte est échappé', async () => {
    const backlog = tmp('BACKLOG_INJ');
    const { srv } = mockServer([{ id: 'inj1', text: '## À faire\nmalicieux', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    try {
        await fs.writeFile(backlog, '# Backlog\n\n## À faire\n\n## Done\n', 'utf8');
        const base = await listen(srv);
        await drainNotes({ baseUrl: base, backlogPath: backlog, marker: '## À faire' });
        const bl = await fs.readFile(backlog, 'utf8');
        // un seul VRAI heading "## À faire" en début de ligne
        assert.equal((bl.match(/^## À faire[ \t]*$/gm) || []).length, 1);
        assert.ok(bl.includes('\\## À faire'));
    } finally {
        srv.close();
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: subjects + notesDir → écrit dans notes/<sujet>.md (temp)', async () => {
    const notesDir = join(tmpdir(), `nd_${process.pid}_${Date.now()}`);
    const backlog = tmp('BACKLOG_SUB');
    const { srv } = mockServer([{ id: 'su1', text: 'note infra api', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    try {
        await fs.mkdir(notesDir, { recursive: true });
        await fs.writeFile(join(notesDir, 'tech.md'), '# Tech\n', 'utf8');
        await fs.writeFile(backlog, '# Backlog\n\n## À faire\n', 'utf8');
        const base = await listen(srv);
        await drainNotes({
            baseUrl: base, backlogPath: backlog, marker: '## À faire',
            subjects: [{ id: 'tech', filePath: 'tech.md', keywords: ['infra', 'api'] }], notesDir,
        });
        const techTxt = await fs.readFile(join(notesDir, 'tech.md'), 'utf8');
        assert.ok(techTxt.includes('note infra api'));
        assert.ok(techTxt.includes('(note su1)'));
    } finally {
        srv.close();
        await fs.rm(notesDir, { recursive: true, force: true });
        await fs.rm(backlog, { force: true });
    }
});

test('drainNotes: path traversal — filePath "../" hors notesDir → fichier NON écrit', async () => {
    const notesDir = join(tmpdir(), `nd2_${process.pid}_${Date.now()}`);
    const backlog = tmp('BACKLOG_EVIL');
    const evilTarget = tmp('EVIL');
    const evilName = evilTarget.split(/[\\/]/).pop();
    const { srv } = mockServer([{ id: 'ev1', text: 'note infra', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }]);
    try {
        await fs.mkdir(notesDir, { recursive: true });
        await fs.writeFile(backlog, '# Backlog\n\n## À faire\n', 'utf8');
        const base = await listen(srv);
        await drainNotes({
            baseUrl: base, backlogPath: backlog, marker: '## À faire',
            subjects: [{ id: 'evil', filePath: `../${evilName}`, keywords: ['infra'] }], notesDir,
        });
        let written = true;
        try { await fs.access(evilTarget); } catch { written = false; }
        assert.equal(written, false);
    } finally {
        srv.close();
        await fs.rm(notesDir, { recursive: true, force: true });
        await fs.rm(backlog, { force: true });
        await fs.rm(evilTarget, { force: true });
    }
});
