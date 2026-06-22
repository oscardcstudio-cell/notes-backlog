#!/usr/bin/env node
/**
 * check-vendored — vérifie l'alignement du store custom des consommateurs sur le
 * contrat du package.
 *
 * CONTEXTE : le vendoring (copie texte du code) est désormais INTERDIT — subvention_match
 * a été débranché vers la dépendance `github:#tag` (2026-06-15), il n'y a plus aucune
 * copie vendorisée à surveiller. Ne reste qu'un couplage légitime : le store custom
 * Postgres `drizzleStore.ts` de subvention_match, qui IMPLÉMENTE le contrat du package
 * (il ne le duplique pas). Si le package ajoute une capacité au contrat, le store custom
 * doit suivre — ce check le rappelle (parité de capacités, pas égalité texte).
 *
 * USAGE : `node scripts/check-vendored.mjs` (lancé par `npm test`).
 * Chemins relatifs à la machine d'Oscar (outil de dev local, pas de CI).
 * Une cible absente (projet pas cloné) est SKIP, pas FAIL.
 *
 * Registre des consommateurs : voir VENDORED.md.
 */

import { readFile, access } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // packages/notes-backlog/scripts → C:\dev\claude

// Stores customs des consommateurs (adaptateurs du contrat, pas des copies du package).
// `mustContain` = capacités du contrat que le store doit implémenter.
const TARGETS = [
    {
        label: 'subvention_match · drizzleStore (prod Postgres, dépendance github:)',
        file: 'oscardcstudio/subvention_match/server/modules/notes/drizzleStore.ts',
        // Couvre les 5 méthodes du contrat (VENDORED.md) + le status — pas seulement
        // markAbandoned. Le drift qui avait mordu historiquement (idempotency de `add`
        // oubliée) passerait VERT si on ne checkait que 2 marqueurs. Regex robustes au
        // style de quote (' vs ") et aux espaces, pour ne pas faux-DRIFT sur un refactor.
        mustContain: [
            [/\blist\s*\(/, 'méthode list()'],
            [/\badd\s*\(/, 'méthode add()'],
            [/\bmarkProcessed\s*\(/, 'méthode markProcessed()'],
            [/\bmarkAbandoned\s*\(/, 'méthode markAbandoned()'],
            [/\bprune\s*\(/, 'méthode prune()'],
            [/['"]abandoned['"]/, 'status abandoned écrit en DB'],
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
    const missing = t.mustContain.filter(([re]) => !re.test(src));
    if (missing.length === 0) {
        console.log(`  ✓ OK    ${t.label}`);
    } else {
        fail++;
        console.log(`  ✗ DRIFT ${t.label}`);
        for (const [re, desc] of missing) {
            console.log(`          manque: ${desc}  [motif: ${re.source}]`);
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
