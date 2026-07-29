import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseNoteItems, auditNotes, relatedOpenItems, fingerprint,
    formatAuditReport, flattenPlanRefs,
} from '../src/audit/audit.js';

const produitMd = `# Produit — notes

- [2026-06-12] **[PAGE /A-PROPOS — manifesto]** Vraie page à créer. [phases:B]
- [2026-06-11] ~~**[FORMULAIRE — régime social]**~~ ✅ **RÉSOLU [2026-07-22]** — \`client/src/pages/FormWizard.tsx:43-48\` sépare les régimes.
- [2026-06-15] **[LÉGAL — attribution]** Ajouté dans LegalPages. FAIT côté code.
- [2026-06-20] ~~**[VIEUX TRUC]**~~ ✅ **RÉSOLU [2026-07-01]** — confirmé par Oscar en chat.
`;

const techOpsMd = `# Tech & Ops — notes

- [2026-06-15] ~~**[FLUX video-studio]**~~ ✅ **RÉSOLU [2026-06-17]** — \`video-studio:server/index.ts:488-496\` porte le listing.
- [2026-07-04] **[WEBFETCH perd les href]** Lire le HTML brut, pas le markdown.
`;

const repoFiles = new Map([
    ['client/src/pages/FormWizard.tsx', { lineCount: 900, text: 'const STATUS_INDIVIDUS = [];' }],
]);

// ── parseNoteItems ────────────────────────────────────────────────────────────

test('parseNoteItems: capte les items datés et ignore les titres markdown', () => {
    const items = parseNoteItems(produitMd);
    assert.equal(items.length, 4);
    assert.equal(items[0].date, '2026-06-12');
});

test('parseNoteItems: détecte RÉSOLU et sa date', () => {
    const items = parseNoteItems(produitMd);
    assert.equal(items[1].resolved, true);
    assert.equal(items[1].resolvedDate, '2026-07-22');
    assert.equal(items[0].resolved, false);
});

test('parseNoteItems: rattache les lignes de continuation indentées', () => {
    const md = `- [2026-06-01] **Titre ouvert**
  - **[2026-07-02] mise à jour** ~~fini~~ ✅ RÉSOLU [2026-07-02] — \`src/a.ts:12\`
`;
    const items = parseNoteItems(md);
    assert.equal(items.length, 1, 'la sous-puce ne doit pas créer un 2e item');
    assert.equal(items[0].resolved, true, 'le RÉSOLU posé en continuation doit compter');
});

test('parseNoteItems: extrait les ancres internes fichier:ligne et fichier:SYMBOLE', () => {
    const items = parseNoteItems(produitMd);
    assert.deepEqual(items[1].anchors.map(a => a.file), ['client/src/pages/FormWizard.tsx']);
    assert.equal(items[1].anchors[0].locator, '43-48');

    const sym = parseNoteItems('- [2026-06-01] ~~x~~ RÉSOLU — `src/Form.tsx:STATUS_LIST`\n');
    assert.equal(sym[0].anchors[0].locator, 'STATUS_LIST');
});

// Le faux positif exact trouvé en auditant Mecene : une ancre vers un AUTRE repo
// (`video-studio:server/index.ts:488`) n'est pas une ancre cassée.
test('parseNoteItems: une ancre cross-repo est classée externe, pas interne', () => {
    const items = parseNoteItems(techOpsMd);
    assert.equal(items[0].externalAnchors.length, 1);
    assert.equal(items[0].anchors.length, 0, 'ne doit PAS être vue comme une ancre du repo courant');
});

// ── auditNotes ────────────────────────────────────────────────────────────────

test('auditNotes: self-declared-done sur un item ouvert qui annonce FAIT', () => {
    const { findings } = auditNotes({ notes: [{ path: 'notes/produit.md', text: produitMd }] });
    const f = findings.filter(x => x.kind === 'self-declared-done');
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /FAIT/);
    assert.equal(f[0].severity, 'error');
});

// Sans ce filtre, mesuré sur un repertoire reel : 18 signalements, 0 actionnable — que
// des notes de gros chantier qui relatent du livre tout en gardant un reste ouvert.
// Un gate qui crie au loup 18 fois se fait baseliner en bloc, donc ne sert plus a rien.
test('auditNotes: une réserve (« reste ») désarme self-declared-done', () => {
    const md = '- [2026-06-01] **[CHANTIER]** Autosave LIVRÉ. Reste à faire : brancher le cron.\n';
    const { findings } = auditNotes({ notes: [{ path: 'n.md', text: md }] });
    assert.equal(findings.filter(f => f.kind === 'self-declared-done').length, 0);
});

test('auditNotes: sans réserve, self-declared-done mord toujours', () => {
    const md = '- [2026-06-01] **[CHANTIER]** Autosave LIVRÉ, endpoint en place.\n';
    const { findings } = auditNotes({ notes: [{ path: 'n.md', text: md }] });
    assert.equal(findings.filter(f => f.kind === 'self-declared-done').length, 1);
});

test('auditNotes: la réserve est détectée quelle que soit la casse', () => {
    for (const reserve of ['Reste à faire : X', 'RESTE : X', 'Différé', 'à trancher', 'NEXT']) {
        const md = `- [2026-06-01] **[C]** LIVRÉ. ${reserve}\n`;
        const { findings } = auditNotes({ notes: [{ path: 'n.md', text: md }] });
        assert.equal(findings.filter(f => f.kind === 'self-declared-done').length, 0, reserve);
    }
});

test('auditNotes: openWorkMarkers est surchargeable (cœur agnostique)', () => {
    const md = '- [2026-06-01] **[C]** DONE. still pending review.\n';
    const opts = { doneMarkers: ['DONE'], openWorkMarkers: ['pending'] };
    assert.equal(auditNotes({ notes: [{ path: 'n.md', text: md }] }, opts).findings.length, 0);
    assert.equal(auditNotes({ notes: [{ path: 'n.md', text: md }] }, { ...opts, openWorkMarkers: ['zzz'] })
        .findings.filter(f => f.kind === 'self-declared-done').length, 1);
});

// `\b` est ASCII en JS : `\bLIVRÉ\b` ne matche pas « LIVRÉ hier ». Le marqueur le PLUS
// frequent passait a travers — un detecteur de faux qui rate le cas majoritaire.
test('auditNotes: un marqueur accentué est bien détecté (piège \\b ASCII)', () => {
    const md = '- [2026-06-01] **[C]** Le module a été LIVRÉ hier soir.\n';
    const { findings } = auditNotes({ notes: [{ path: 'n.md', text: md }] });
    assert.equal(findings.filter(f => f.kind === 'self-declared-done').length, 1);
});

// Matching casse-sensible : en minuscules dépliées, « livre » (le nom commun, omnipresent
// dans un projet d'aides a l'edition) matcherait « LIVRÉ ».
test('auditNotes: « livre » en minuscules ne déclenche pas « LIVRÉ »', () => {
    const md = "- [2026-06-01] **[C]** L'artiste a écrit un livre et cherche une bourse.\n";
    const { findings } = auditNotes({ notes: [{ path: 'n.md', text: md }] });
    assert.equal(findings.filter(f => f.kind === 'self-declared-done').length, 0);
});

test('auditNotes: unproven-resolution sur un RÉSOLU sans ancre code', () => {
    const { findings } = auditNotes({ notes: [{ path: 'notes/produit.md', text: produitMd }] });
    const f = findings.filter(x => x.kind === 'unproven-resolution');
    assert.equal(f.length, 1);
    assert.match(f[0].title, /VIEUX TRUC/);
});

test('auditNotes: ancre valide (ligne dans les bornes) ne produit aucun dangling', () => {
    const { findings } = auditNotes({ notes: [{ path: 'notes/produit.md', text: produitMd }], repoFiles });
    assert.equal(findings.filter(x => x.kind === 'dangling-anchor').length, 0);
});

test('auditNotes: dangling-anchor quand la ligne dépasse la taille du fichier', () => {
    const petit = new Map([['client/src/pages/FormWizard.tsx', { lineCount: 20, text: '' }]]);
    const { findings } = auditNotes({ notes: [{ path: 'notes/produit.md', text: produitMd }], repoFiles: petit });
    const f = findings.filter(x => x.kind === 'dangling-anchor');
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /hors bornes/);
});

test('auditNotes: dangling-anchor quand le symbole est absent du fichier', () => {
    const md = '- [2026-06-01] ~~x~~ RÉSOLU — `Form.tsx:ABSENT_SYMBOL`\n';
    const rf = new Map([['src/Form.tsx', { lineCount: 10, text: 'const AUTRE = 1;' }]]);
    const { findings } = auditNotes({ notes: [{ path: 'n.md', text: md }], repoFiles: rf });
    assert.equal(findings.filter(x => x.kind === 'dangling-anchor').length, 1);
});

test('auditNotes: une ancre cross-repo ne déclenche jamais dangling-anchor', () => {
    const { findings } = auditNotes({ notes: [{ path: 'notes/tech-ops.md', text: techOpsMd }], repoFiles });
    assert.equal(findings.filter(x => x.kind === 'dangling-anchor').length, 0);
    assert.equal(findings.filter(x => x.kind === 'unproven-resolution').length, 0,
        'une ancre externe compte comme preuve, elle ne doit pas passer pour absente');
});

test('auditNotes: orphan-file quand aucun notes_ref ne cite le fichier', () => {
    const notes = [
        { path: '.planning/notes/produit.md', text: produitMd },
        { path: '.planning/notes/dreamy-hero-audit.md', text: '- [2026-06-01] truc\n' },
    ];
    const { findings } = auditNotes({ notes, planRefs: ['.planning/notes/produit.md'] });
    const f = findings.filter(x => x.kind === 'orphan-file');
    assert.equal(f.length, 1);
    assert.match(f[0].file, /dreamy-hero-audit/);
});

// Le mécanisme exact de l'incident : l'index dit 2026-06-12, la source a bougé le 2026-07-22.
test('auditNotes: stale-index compare la date déclarée au plus récent item des sources', () => {
    const idx = { path: 'notes/CROSS-REF.md', text: '> Index auto-maintenu.\n\n*Dernière mise à jour : 2026-06-12*\n' };
    const { findings } = auditNotes({ notes: [{ path: 'notes/produit.md', text: produitMd }], indexes: [idx] });
    const f = findings.filter(x => x.kind === 'stale-index');
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /2026-06-12/);
    assert.match(f[0].detail, /2026-07-22/);
    assert.equal(f[0].severity, 'error');
});

test('auditNotes: un index à jour ne produit aucun constat', () => {
    const idx = { path: 'notes/CROSS-REF.md', text: '*Dernière mise à jour : 2026-08-01*\n' };
    const { findings } = auditNotes({ notes: [{ path: 'notes/produit.md', text: produitMd }], indexes: [idx] });
    assert.equal(findings.filter(x => x.kind === 'stale-index').length, 0);
});

// ── Baseline ──────────────────────────────────────────────────────────────────

test('baseline: un constat connu est dégradé en warn et ne bloque plus', () => {
    const notes = [{ path: 'notes/produit.md', text: produitMd }];
    const first = auditNotes({ notes });
    const known = first.findings.filter(f => f.kind === 'self-declared-done').map(f => f.fingerprint);

    const second = auditNotes({ notes }, { baseline: known });
    const f = second.findings.find(x => x.kind === 'self-declared-done');
    assert.equal(f.baselined, true);
    assert.equal(f.severity, 'warn');
    assert.equal(second.summary.errors, 0, 'le stock connu ne doit pas rendre le gate rouge');
});

test('baseline: un NOUVEAU constat échoue même si le stock est baseliné', () => {
    const notes = [{ path: 'notes/produit.md', text: produitMd }];
    const known = auditNotes({ notes }).findings.map(f => f.fingerprint);
    const withNew = [{ path: 'notes/produit.md', text: produitMd + '\n- [2026-08-01] **[NOUVEAU]** truc LIVRÉ hier.\n' }];
    const res = auditNotes({ notes: withNew }, { baseline: known });
    assert.equal(res.summary.errors, 1, 'la régression doit mordre');
});

test('fingerprint: stable quand la ligne bouge (sinon la baseline périme au 1er commit)', () => {
    const a = fingerprint({ kind: 'self-declared-done', file: 'n.md', title: 'Mon item', lineNo: 12 });
    const b = fingerprint({ kind: 'self-declared-done', file: 'n.md', title: 'Mon item', lineNo: 480 });
    assert.equal(a, b);
});

test('strict: toute gravité devient bloquante', () => {
    const notes = [{ path: 'notes/produit.md', text: produitMd }];
    const sev = { 'unproven-resolution': 'error', 'orphan-file': 'error' };
    const res = auditNotes({ notes }, { severity: sev });
    assert.ok(res.summary.errors >= 2);
});

// ── relatedOpenItems (le déclencheur de clôture) ──────────────────────────────

test('relatedOpenItems: remonte les items OUVERTS citant un fichier modifié', () => {
    const notes = [{ path: 'notes/produit.md', text: produitMd + '\n- [2026-06-05] Revoir `FormWizard.tsx` pour l\'âge.\n' }];
    const rel = relatedOpenItems(notes, ['client/src/pages/FormWizard.tsx']);
    assert.equal(rel.length, 1);
    assert.match(rel[0].title, /âge/);
});

test('relatedOpenItems: ignore les items déjà RÉSOLU', () => {
    const notes = [{ path: 'notes/produit.md', text: produitMd }];
    const rel = relatedOpenItems(notes, ['client/src/pages/FormWizard.tsx']);
    assert.equal(rel.length, 0, 'le seul item citant FormWizard est résolu');
});

test('relatedOpenItems: frontière de mot (Form.tsx ne matche pas MyForm.tsx)', () => {
    const notes = [{ path: 'n.md', text: '- [2026-06-01] Revoir `MyForm.tsx` un jour.\n' }];
    assert.equal(relatedOpenItems(notes, ['src/Form.tsx']).length, 0);
});

// ── Divers ────────────────────────────────────────────────────────────────────

test('flattenPlanRefs: aplatit steps + tracks sans connaître leurs noms', () => {
    const plan = {
        updated: '2026-07-18',
        steps: [{ id: 'A', notes_ref: ['notes/a.md'] }, { id: 'B', notes_ref: ['notes/b.md'] }],
        tracks: [{ id: 'Cat', notes_ref: ['notes/c.md'] }],
    };
    assert.deepEqual(flattenPlanRefs(plan).sort(), ['notes/a.md', 'notes/b.md', 'notes/c.md']);
});

test('formatAuditReport: rapport vert quand tout est cohérent', () => {
    const out = formatAuditReport({ findings: [], summary: { total: 0, errors: 0, warnings: 0, byKind: {} } }, []);
    assert.match(out, /cohérent/);
});

test('formatAuditReport: liste les items à clore quand des fichiers ont bougé', () => {
    const out = formatAuditReport(
        { findings: [], summary: { total: 0, errors: 0, warnings: 0, byKind: {} } },
        [{ file: 'n.md', lineNo: 3, title: 'Item', matched: ['src/a.ts'] }],
    );
    assert.match(out, /Vérifier dans le code/);
});
