# Copies vendorisées de notes-backlog

Ce package est **copié à la main** dans certains projets, parce qu'ils ne peuvent
pas le tirer en `file:`/`npm` au build distant. Ces copies divergent éditorialement
(headers, commentaires, imports, EOL) → **un diff texte est inutile**. Le garde-fou
est un check de **parité de capacités** : `npm run check:vendored` (aussi dans `npm test`).

## Registre des consommateurs

| Projet | Mode | Fichiers copiés | Se met à jour ? |
|---|---|---|---|
| **subvention_match** | vendoring manuel (Docker/Railway) | `scripts/lib/drainNotes.js`, `scripts/lib/categorize.js`, `server/modules/notes/lib/createNotesRouter.js`, `server/modules/notes/lib/memoryStore.js` | ❌ — propagation manuelle |
| **subvention_match** | store custom (pas une copie) | `server/modules/notes/drizzleStore.ts` (Postgres, implémente le contrat) | implémente `markProcessed`/`markAbandoned` à la main |
| **start-up-box** | `file:../../packages/notes-backlog` | — (import direct) | ✅ au `npm install` local · ⚠️ cassé si cloné seul |

## Règle de propagation (NON-NÉGOCIABLE)

Toute correction du package qui touche une feature présente dans une copie →
la propager **dans la même session** à chaque copie listée, puis `npm run check:vendored`.
Si tu ajoutes une feature critique, ajoute son marqueur dans `scripts/check-vendored.mjs`.

## Migration cible (tue le drift définitivement)

Le vendoring avec édition manuelle est un anti-pattern : chaque copie est un fork.
La sortie durable = **dépendance `github:`** : publier ce package dans
`oscardcstudio-cell/notes-backlog`, puis dans chaque consommateur
`"notes-backlog": "github:oscardcstudio-cell/notes-backlog#v1.4.0"`.
- Marche en **Docker/Railway** (npm install tire de GitHub au build) ET en clone-seul.
- subvention_match : retirer les 4 copies, recâbler les imports vers `notes-backlog/*`,
  garder `drizzleStore.ts` local (store custom du projet). À faire en **session dédiée**
  (recâblage d'imports + redéploiement d'un projet en prod = à ne pas bâcler).
