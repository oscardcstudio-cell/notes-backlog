import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, categorizeByRules } from '../src/categorize/categorize.js';
import { companyPhases } from '../src/presets/companyPhases.js';

const cats = [
    { id: 'pricing', label: 'Pricing', marker: '## Pricing', keywords: ['prix', 'tarif', 'abonnement'] },
    { id: 'brand', label: 'Brand', marker: '## Brand', keywords: ['logo', 'charte', 'couleur'] },
    { id: 'misc', label: 'À trier', marker: '## À trier', keywords: [], default: true },
];

// ── categorizeByRules (synchrone, déterministe) ──────────────────────────────
test('categorizeByRules: match simple → meilleure catégorie + score', () => {
    const r = categorizeByRules('il faut revoir le prix', cats);
    assert.equal(r.id, 'pricing');
    assert.equal(r.score, 1);
    assert.equal(r.tie, false);
    assert.equal(r.marker, '## Pricing');
});

test('categorizeByRules: plusieurs keywords cumulent le score', () => {
    const r = categorizeByRules('refaire le logo, la charte et la couleur', cats);
    assert.equal(r.id, 'brand');
    assert.equal(r.score, 3);
});

test('categorizeByRules: insensible aux accents/casse (normalize)', () => {
    const r = categorizeByRules('revoir le TARIF', cats);
    assert.equal(r.id, 'pricing');
});

test('categorizeByRules: aucun match → id null, score 0', () => {
    const r = categorizeByRules('texte sans mot clé connu', cats);
    assert.equal(r.id, null);
    assert.equal(r.score, 0);
    assert.equal(r.tie, false);
});

test('categorizeByRules: égalité au sommet → tie=true', () => {
    const r = categorizeByRules('le prix du logo', cats);
    assert.equal(r.tie, true);
    assert.equal(r.score, 1);
});

test('categorizeByRules: substring volontaire matche les variantes morpho', () => {
    // "tarif" doit matcher "tarifs" / "tarification" (substring, pas frontière de mot)
    assert.equal(categorizeByRules('revoir les tarifs', cats).id, 'pricing');
    assert.equal(categorizeByRules('revoir la tarification', cats).id, 'pricing');
});

test('categorizeByRules: liste de catégories vide → id null', () => {
    const r = categorizeByRules('peu importe', []);
    assert.equal(r.id, null);
    assert.equal(r.score, 0);
});

// ── categorize (async, fallback LLM) ─────────────────────────────────────────
test('categorize: règle décisive → via=rules', async () => {
    const r = await categorize('il faut revoir le prix', cats);
    assert.equal(r.id, 'pricing');
    assert.equal(r.via, 'rules');
    assert.equal(r.marker, '## Pricing');
});

test('categorize: aucun match → défaut (via=default)', async () => {
    const r = await categorize('truc sans mot-clé connu', cats);
    assert.equal(r.id, 'misc');
    assert.equal(r.via, 'default');
});

test('categorize: catégories vides → résultat null/default', async () => {
    const r = await categorize('peu importe', []);
    assert.deepEqual(r, { id: null, label: null, marker: null, via: 'default' });
});

test('categorize: défaut = première marquée default, sinon dernière', async () => {
    // sans default explicite → dernière catégorie
    const noDefault = [
        { id: 'a', keywords: ['x'] },
        { id: 'z', keywords: ['y'] },
    ];
    const r = await categorize('rien ne matche', noDefault);
    assert.equal(r.id, 'z');
    assert.equal(r.via, 'default');
});

test('categorize: égalité sans LLM → garde le meilleur match (pas le défaut)', async () => {
    const r = await categorize('le prix du logo', cats);
    assert.equal(r.via, 'rules');
    assert.ok(r.id === 'pricing' || r.id === 'brand');
});

test('categorize: égalité avec LLM → le LLM tranche (via=llm)', async () => {
    let called = 0;
    const llm = async () => { called++; return 'brand'; };
    const r = await categorize('le prix du logo', cats, { llmClassifier: llm });
    assert.equal(called, 1);
    assert.equal(r.id, 'brand');
    assert.equal(r.via, 'llm');
});

test('categorize: règle décisive → LLM jamais appelé', async () => {
    let called = 0;
    const llm = async () => { called++; return 'brand'; };
    await categorize('il faut revoir le prix', cats, { llmClassifier: llm });
    assert.equal(called, 0);
});

test('categorize: LLM renvoie un id inconnu → ignoré, retombe défaut/meilleur', async () => {
    const llm = async () => 'inexistant';
    const r = await categorize('le prix du logo', cats, { llmClassifier: llm });
    // id inconnu → on retombe sur le meilleur match règles
    assert.equal(r.via, 'rules');
});

test('categorize: LLM throw → fail-soft, pas de crash', async () => {
    const throwing = async () => { throw new Error('LLM down'); };
    const r = await categorize('le prix du logo', cats, { llmClassifier: throwing });
    assert.equal(r.via, 'rules');
    const r2 = await categorize('aucun mot connu ici', cats, { llmClassifier: throwing });
    assert.equal(r2.via, 'default');
    assert.equal(r2.id, 'misc');
});

// ── preset companyPhases (data réelle consommée en prod) ─────────────────────
test('categorize preset: pricing freemium → Phase 4', async () => {
    const r = await categorize('tester le pricing freemium', companyPhases);
    assert.equal(r.id, 'p4-offre-gtm');
});

test('categorize preset: interview cibles → Phase 1', async () => {
    const r = await categorize('interviewer 5 cibles', companyPhases);
    assert.equal(r.id, 'p1-validation');
});

test('categorize preset: texte inconnu → À trier (default)', async () => {
    const r = await categorize('blabla random xyz', companyPhases);
    assert.equal(r.id, 'a-trier');
    assert.equal(r.via, 'default');
});

test('categorize preset: faux-positif keyword court — "ui" sur-match (gotcha documenté)', async () => {
    // GOTCHA: categorizeByRules utilise includes() (substring), pas containsWord.
    // "build" contient "ui" → Phase 6 a "ui" en keyword. On documente le comportement réel.
    const r = categorizeByRules('cuisine maison', companyPhases);
    // "cuisine" contient "ui" → match Phase 6 (sur-match assumé, recall > précision)
    assert.equal(r.id, 'p6-build');
});
