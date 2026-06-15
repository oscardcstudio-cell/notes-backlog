#!/usr/bin/env node
/**
 * check-vendored — garde-fou anti-drift des copies vendorisées de notes-backlog.
 *
 * POURQUOI : ce package est copié à la main (vendorisé) dans des projets qui ne
 * peuvent pas le tirer en `file:`/`npm` au build distant (ex: subvention_match sur
 * Railway/Docker — le dossier packages/ n'est pas dans leur repo). Ces copies sont
 * des FORKS éditoriaux (headers réécrits, commentaires strippés, imports ajustés,
 * EOL CRLF) → un diff texte est inutilisable, et une correction du package peut être
 * oubliée dans une copie en silence (c'est arrivé : le statut `abandoned` + le fix
 * d'idempotency étaient dans le package mais pas dans subvention_match).
 *
 * STRATÉGIE : on ne compare pas le texte (il diverge légitimement) — on vérifie la
 * PARITÉ DE CAPACITÉS : chaque copie déclarée doit contenir les marqueurs des features
 * critiques. Si une copie a raté une correction, le marqueur manque → exit 1.
 *
 * USAGE : `node scripts/check-vendored.mjs` (lancé par `npm test`).
 * Chemins relatifs à la machine d'Oscar (outil de dev local, pas de CI).
 * Une cible absente (projet pas cloné) est SKIP, pas FAIL.
 *
 * Quand tu ajoutes une feature au package → ajoute son marqueur ici ET propage-la
 * dans chaque copie listée. Registre des copies : voir VENDORED.md.
 */

import { readFile, access } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // packages/notes-backlog/scripts → C:\dev\claude

// Registre des copies vendorisées + capacités attendues (marqueurs texte présents
// quelle que soit la mise en forme). `mustContain` = features critiques à propager.
const TARGETS = [
    {
        label: 'subvention_match · drain CLI',
        file: 'oscardcstudio/subvention_match/scripts/lib/drainNotes.js',
        mustContain: [
            ['raw.includes(', 'idempotency guard (re-drain ne duplique pas le BACKLOG)'],
            ['return false', 'appendToBacklog retourne false si déjà présent'],
        ],
    },
    {
        label: 'subvention_match · router Express',
        file: 'oscardcstudio/subvention_match/server/modules/notes/lib/createNotesRouter.js',
        mustContain: [
            ['/:id/abandoned', 'endpoint POST abandoned'],
            ['markAbandoned', 'appel store.markAbandoned'],
        ],
    },
    {
        label: 'subvention_match · memoryStore',
        file: 'oscardcstudio/subvention_match/server/modules/notes/lib/memoryStore.js',
        mustContain: [['markAbandoned', 'méthode markAbandoned']],
    },
    {
        label: 'subvention_match · drizzleStore (prod Postgres)',
        file: 'oscardcstudio/subvention_match/server/modules/notes/drizzleStore.ts',
        mustContain: [
            ['markAbandoned', 'méthode markAbandoned'],
            ['"abandoned"', 'status abandoned écrit en DB'],
        ],
    },
];

let fail = 0;
let skipped = 0;

for (const t of TARGETS) {
    const abs = path.join(repoRoot, t.file);
    try {
        await access(abs);
    } catch {
        console.log(`  ⊘ SKIP  ${t.label} (absent: ${t.file})`);
        skipped++;
        continue;
    }
    const src = await readFile(abs, 'utf8');
    const missing = t.mustContain.filter(([needle]) => !src.includes(needle));
    if (missing.length === 0) {
        console.log(`  ✓ OK    ${t.label}`);
    } else {
        fail++;
        console.log(`  ✗ DRIFT ${t.label}`);
        for (const [needle, desc] of missing) {
            console.log(`          manque: ${desc}  [marqueur: ${needle}]`);
        }
    }
}

console.log('');
if (fail > 0) {
    console.log(`${fail} copie(s) vendorisée(s) en retard sur le package — propager la correction (voir VENDORED.md).`);
    process.exit(1);
}
console.log(`Parité OK${skipped ? ` (${skipped} cible(s) absente(s), skip)` : ''}.`);
process.exit(0);
