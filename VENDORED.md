# Consommateurs de notes-backlog

Règle d'or meta : **le vendoring (copie du code) est INTERDIT** — un outil partagé se
consomme en dépendance versionnée. Ce fichier trace les consommateurs et la dette
résiduelle de liaison. Cf. `C:\dev\claude\CLAUDE.md` §no-vendoring + `GOTCHAS.md` §Vendoring.

## Registre des consommateurs

| Projet | Mode | État |
|---|---|---|
| **subvention_match** | dépendance `github:oscardcstudio-cell/notes-backlog#v1.4.0` | ✅ débranché du vendoring (2026-06-15). Plus aucune copie texte. Store custom Postgres `server/modules/notes/drizzleStore.ts` conservé (implémente le contrat). |
| **start-up-box** | dépendance `github:oscardcstudio-cell/notes-backlog#v1.4.0` | ✅ débranché du `file:` (2026-06-15). Plus aucune copie texte. `npm ci` résout depuis github (lockfile épinglé au commit `9b6eba`), nécessaire car la box est clonée en standalone par des tiers. |

## Store custom (pas une copie — un adaptateur du contrat)

`subvention_match/server/modules/notes/drizzleStore.ts` implémente le contrat du package
(`list / add / markProcessed / markAbandoned / prune`) sur Postgres. Ce n'est pas du code
dupliqué du package : c'est un store spécifique au projet, légitime. Le check `npm run
check:vendored` vérifie qu'il reste aligné sur le contrat (présence de `markAbandoned` +
écriture du statut `abandoned`).

## Historique

Avant 2026-06-15, subvention_match vendorisait 4 fichiers à la main (Docker/Railway ne
pouvait pas tirer `file:../../packages/`). Ces copies forkaient en silence — le statut
`abandoned` + le fix d'idempotency avaient été oubliés dans les copies jusqu'à vérification
manuelle. La sortie : publier le package en repo github dédié (`oscardcstudio-cell/notes-backlog`,
public, tag `v1.4.0`) et dépendre de `github:#tag` (marche en Docker/Railway ET en clone-seul).
