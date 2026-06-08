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

// 4) categorize — règles, défaut, égalité, fallback LLM
console.log('categorize');
const { categorize, categorizeByRules } = await import('../src/categorize/categorize.js');
const { companyPhases } = await import('../src/presets/companyPhases.js');

const cats = [
    { id: 'pricing', label: 'Pricing', marker: '## Pricing', keywords: ['prix', 'tarif', 'abonnement'] },
    { id: 'brand', label: 'Brand', marker: '## Brand', keywords: ['logo', 'charte', 'couleur'] },
    { id: 'misc', label: 'À trier', marker: '## À trier', keywords: [], default: true },
];
ok((await categorize('il faut revoir le prix', cats)).id === 'pricing', 'règle simple → pricing');
ok((await categorize('il faut revoir le prix', cats)).via === 'rules', 'via=rules');
ok((await categorize('refaire le logo et la charte', cats)).id === 'brand', 'multi-mots → brand');
ok((await categorize('truc sans mot-clé connu', cats)).id === 'misc', 'aucun match → défaut');
ok((await categorize('truc sans mot-clé connu', cats)).via === 'default', 'via=default');
ok(categorizeByRules('le prix du logo', cats).tie === true, 'égalité détectée (prix=1, logo=1)');
// fallback LLM seulement quand les règles ne tranchent pas
let llmCalled = 0;
const llm = async () => { llmCalled++; return 'brand'; };
const amb = await categorize('le prix du logo', cats, { llmClassifier: llm });
ok(llmCalled === 1 && amb.id === 'brand' && amb.via === 'llm', 'égalité → LLM tranche');
llmCalled = 0;
await categorize('il faut revoir le prix', cats, { llmClassifier: llm });
ok(llmCalled === 0, 'règle décisive → LLM jamais appelé');
// preset companyPhases
ok((await categorize('tester le pricing freemium', companyPhases)).id === 'p4-offre-gtm', 'preset: pricing → Phase 4');
ok((await categorize('interviewer 5 cibles', companyPhases)).id === 'p1-validation', 'preset: interview → Phase 1');
ok((await categorize('blabla random', companyPhases)).id === 'a-trier', 'preset: inconnu → À trier');

// 5) drainNotes avec categories → routage par section de phase
console.log('drainNotes catégorisé');
const backlog2 = join(tmpdir(), `BACKLOG2_${Date.now()}.md`);
await fs.writeFile(backlog2, '# Backlog\n\n## À faire\n\n## Pricing\n\n## Brand\n\n## Done\n', 'utf8');
const notes2 = [{ id: 'c1', text: 'revoir le tarif', status: 'pending', created_at: '2026-05-31T10:00:00.000Z' }];
const srv2 = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/notes')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ notes: notes2.filter(n => n.status === 'pending') }));
    }
    const m = req.url.match(/^\/api\/notes\/([^/]+)\/processed$/);
    if (req.method === 'POST' && m) { const n = notes2.find(x => x.id === decodeURIComponent(m[1])); if (n) n.status = 'processed'; res.end('{}'); return; }
    res.statusCode = 404; res.end('{}');
});
await new Promise(r => srv2.listen(0, r));
const port2 = srv2.address().port;
await drainNotes({ baseUrl: `http://127.0.0.1:${port2}`, backlogPath: backlog2, marker: '## À faire', categories: cats });
srv2.close();
const bl2 = await fs.readFile(backlog2, 'utf8');
ok(bl2.indexOf('## Pricing') < bl2.indexOf('📝 Note') && bl2.indexOf('📝 Note') < bl2.indexOf('## Brand'), 'note "tarif" rangée sous ## Pricing');
ok(bl2.includes('- **Phase** : Pricing'), 'bloc annoté de la phase');
await fs.rm(backlog2, { force: true });

// 6) coverage — mini-RTM backlog ↔ plan
console.log('coverage');
const { checkCoverage, parseItems, formatCoverageReport } = await import('../src/coverage/coverage.js');

const backlogMd = `# Backlog
- [ ] Tester le pricing freemium [[P4]]
- [ ] Refaire le logo → identite-visuelle
- [ ] Brancher l'auth OAuth ref:auth-oauth
- [ ] Idée orpheline jamais planifiée
- [x] Vieux truc déjà fait [[P0]]
* Migration base de données vers Postgres
`;
const planMd = `# Roadmap
## Phase 4 — Offre
Landing + pricing freemium. tag: P4
## Identité
Charte et identite-visuelle complète.
## Build
Migration base de données + dashboard.
`;
const cov = checkCoverage(backlogMd, planMd);
ok(parseItems(backlogMd).length === 6, 'parseItems: 6 items (puces -/*/+, checkbox)');
ok(cov.summary.total === 5, 'done [x] exclu par défaut (5/6)');
ok(cov.linked.some(i => i.title.includes('pricing')), 'anchor [[P4]] résolu → linked');
ok(cov.linked.some(i => i.title.includes('logo')), 'anchor → identite-visuelle résolu → linked');
ok(cov.broken.some(i => i.missing.includes('auth-oauth')), 'ref:auth-oauth absent du plan → broken');
ok(cov.unlinked.some(i => i.title.includes('orpheline')), 'sans anchor → unlinked');
ok(cov.unlinked.find(i => i.title.includes('orpheline')).maybeInPlan === false, 'orpheline: maybeInPlan=false (aucun token partagé)');
ok(cov.unlinked.find(i => i.title.includes('Postgres')).maybeInPlan === true, 'Postgres sans anchor mais tokens dans le plan → maybeInPlan=true (suggestion)');
ok(cov.summary.orphans === 3, 'orphans = broken(1) + unlinked(2)');
const fullCov = checkCoverage('- [ ] A [[X]]', '# plan\nX présent ici');
ok(fullCov.summary.orphans === 0, 'tout couvert → orphans=0 (gate verte)');
ok(checkCoverage(backlogMd, planMd, { includeDone: true }).summary.total === 6, 'includeDone=true → 6 items');
ok(formatCoverageReport(cov).includes('Liens cassés'), 'rapport markdown généré');

// cleanup
await fs.rm(f, { force: true }); await fs.rm(`${f}.tmp`, { force: true }); await fs.rm(backlog, { force: true });
console.log(fail === 0 ? '\nALL GREEN' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
