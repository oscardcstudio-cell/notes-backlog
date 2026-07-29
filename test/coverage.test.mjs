import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCoverage, parseItems, formatCoverageReport } from '../src/coverage/coverage.js';

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

// ── parseItems ───────────────────────────────────────────────────────────────
test('parseItems: capte puces -/*/+ et checkbox', () => {
    const items = parseItems(backlogMd);
    assert.equal(items.length, 6);
});

test('parseItems: extrait done=true sur [x]', () => {
    const items = parseItems(backlogMd);
    const done = items.filter(i => i.done);
    assert.equal(done.length, 1);
    assert.ok(done[0].title.includes('Vieux truc'));
});

test('parseItems: extrait les anchors [[..]], →, ref:', () => {
    const items = parseItems(backlogMd);
    const p4 = items.find(i => i.title.includes('pricing'));
    assert.deepEqual(p4.anchors, ['P4']);
    const logo = items.find(i => i.title.includes('logo'));
    assert.deepEqual(logo.anchors, ['identite-visuelle']);
    const auth = items.find(i => i.title.includes('auth'));
    assert.deepEqual(auth.anchors, ['auth-oauth']);
});

test('parseItems: anchors retirés du titre', () => {
    const items = parseItems(backlogMd);
    const p4 = items.find(i => i.title.includes('pricing'));
    assert.equal(p4.title.includes('[[P4]]'), false);
});

test('parseItems: input vide/null → []', () => {
    assert.deepEqual(parseItems(''), []);
    assert.deepEqual(parseItems(null), []);
    assert.deepEqual(parseItems(undefined), []);
});

test('parseItems: lignes non-liste ignorées (paragraphes, headings)', () => {
    const items = parseItems('# Titre\nParagraphe normal.\n- vrai item');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'vrai item');
});

test('parseItems: numérotation 1. / 1) supportée', () => {
    const items = parseItems('1. premier\n2) second');
    assert.equal(items.length, 2);
});

// ── checkCoverage ────────────────────────────────────────────────────────────
test('checkCoverage: anchor résolu → linked', () => {
    const cov = checkCoverage(backlogMd, planMd);
    assert.ok(cov.linked.some(i => i.title.includes('pricing')));
    assert.ok(cov.linked.some(i => i.title.includes('logo')));
});

test('checkCoverage: anchor introuvable → broken', () => {
    const cov = checkCoverage(backlogMd, planMd);
    assert.ok(cov.broken.some(i => i.missing.includes('auth-oauth')));
});

test('checkCoverage: sans anchor → unlinked', () => {
    const cov = checkCoverage(backlogMd, planMd);
    assert.ok(cov.unlinked.some(i => i.title.includes('orpheline')));
});

test('checkCoverage: done [x] exclu par défaut', () => {
    const cov = checkCoverage(backlogMd, planMd);
    assert.equal(cov.summary.total, 5);
});

test('checkCoverage: includeDone=true compte les cochés', () => {
    const cov = checkCoverage(backlogMd, planMd, { includeDone: true });
    assert.equal(cov.summary.total, 6);
});

test('checkCoverage: maybeInPlan=false quand aucun token partagé', () => {
    const cov = checkCoverage(backlogMd, planMd);
    const orph = cov.unlinked.find(i => i.title.includes('orpheline'));
    assert.equal(orph.maybeInPlan, false);
});

test('checkCoverage: maybeInPlan=true quand tokens présents dans le plan (suggestion)', () => {
    const cov = checkCoverage(backlogMd, planMd);
    const pg = cov.unlinked.find(i => i.title.includes('Postgres'));
    assert.equal(pg.maybeInPlan, true);
});

test('checkCoverage: orphans = broken + unlinked', () => {
    const cov = checkCoverage(backlogMd, planMd);
    assert.equal(cov.summary.orphans, cov.summary.broken + cov.summary.unlinked);
    assert.equal(cov.summary.orphans, 3);
});

test('checkCoverage: tout couvert → orphans=0 (gate verte)', () => {
    const cov = checkCoverage('- [ ] A [[X]]', '# plan\nX présent ici');
    assert.equal(cov.summary.orphans, 0);
});

test('checkCoverage: frontière de mot — [[P4]] NON résolu par P40/SP4', () => {
    const cov = checkCoverage('- [ ] feature [[P4]]', '# plan\nVoir P40 et SP4 plus loin.');
    assert.equal(cov.linked.length, 0);
    assert.ok(cov.broken.some(i => i.missing.includes('P4')));
});

test('checkCoverage: [[P4]] résolu sur frontière exacte', () => {
    const cov = checkCoverage('- [ ] feature [[P4]]', '# plan\nPhase P4 livrée.');
    assert.equal(cov.linked.length, 1);
});

test('checkCoverage: backlog vide → summary à zéro', () => {
    const cov = checkCoverage('', 'plan');
    assert.deepEqual(cov.summary, { total: 0, linked: 0, broken: 0, unlinked: 0, orphans: 0 });
});

test('checkCoverage: suggestMinTokens custom contrôle le seuil de suggestion', () => {
    // 1 seul token partagé : avec seuil 1 → maybeInPlan, avec seuil 3 → non
    const bl = '- [ ] migration database';
    const plan = '# plan\nmigration prévue';
    const low = checkCoverage(bl, plan, { suggestMinTokens: 1 });
    assert.equal(low.unlinked[0].maybeInPlan, true);
    const high = checkCoverage(bl, plan, { suggestMinTokens: 5 });
    assert.equal(high.unlinked[0].maybeInPlan, false);
});

// ── formatCoverageReport ─────────────────────────────────────────────────────
test('formatCoverageReport: rapport markdown contient les sections', () => {
    const cov = checkCoverage(backlogMd, planMd);
    const report = formatCoverageReport(cov);
    assert.ok(report.includes('Liens cassés'));
    assert.ok(report.includes('Non rattachés'));
    assert.ok(report.includes('mini-RTM'));
});

test('formatCoverageReport: tout couvert → message de gate verte', () => {
    const cov = checkCoverage('- [ ] A [[X]]', 'X présent');
    const report = formatCoverageReport(cov);
    assert.ok(report.includes('couvert par le plan'));
});
