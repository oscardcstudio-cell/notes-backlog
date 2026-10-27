# Consommateurs de notes-backlog

Règle d'or meta : **le vendoring (copie du code) est INTERDIT** — un outil partagé se
consomme en dépendance versionnée. Ce fichier trace les consommateurs et la dette
résiduelle de liaison. Cf. `C:\dev\claude\CLAUDE.md` §no-vendoring + `GOTCHAS.md` §Vendoring.

## Registre des consommateurs

| Projet | Mode | État |
|---|---|---|
| **subvention_match** | dépendance `github:oscardcstudio-cell/notes-backlog#v1.6.0` | ✅ débranché du vendoring (2026-06-15). Store custom Postgres `server/modules/notes/drizzleStore.ts` (implémente le contrat). Bumpé v1.5.0 le 2026-06-23 (lock resolved `1244ab7`) via worktree isolé pendant qu'une autre session tournait — commit `ddc4514`, Railway deploy `184a0a27` SUCCESS, prod live. **Bumpé v1.6.0 le 2026-07-29** pour `./audit` : `npm run check:notes` branché au pre-push étape 0/4 et au CI. Repassé sur le tag `#v1.6.0` le 2026-07-30 (PR #500) : le pin provisoire au SHA `9e7fcb0` visait un commit de branche de PR, invalidé par le squash-merge. |
| **start-up-box** | dépendance `github:oscardcstudio-cell/notes-backlog#v1.6.0` | ✅ débranché du `file:` (2026-06-15). Plus aucune copie texte. Bumpé v1.5.0 le 2026-06-23, **v1.6.0 le 2026-07-29** (PR #1), repassé du SHA au tag le 2026-07-30 (`765adc8`). `npm ci` résout depuis github, nécessaire car la box est clonée en standalone par des tiers. N'a pas de `.planning/notes/` (consomme `drain` seul) → pas de `check:notes` ici ; en revanche la skill `build-company` recommande désormais les **deux** moitiés aux nouveaux projets, au lieu de la capture seule. |

**Les deux consommateurs sont alignés sur la même version.** La dérive de version entre
consommateurs est le mode d'échec que ce registre existe pour attraper : c'est exactement
ainsi que les copies vendorisées d'avant juin forkaient en silence (le statut `abandoned`
et le fix d'idempotency avaient été oubliés dans l'une d'elles).

**Leçon du bump v1.6.0 : ne jamais pinner sur le SHA d'une branche de PR.** Le tag n'ayant
pas pu être poussé depuis la session remote (proxy git : 403 sur les refs de tags), les deux
consommateurs ont été pinnés sur `9e7fcb0`, le commit de la branche. La PR a été mergée en
**squash** : `9e7fcb0` n'est dans l'historique d'aucune branche, et sa branche a été supprimée.
Le commit reste joignable (GitHub conserve `refs/pull/N/head`, vérifié par fetch direct) donc
rien n'a cassé — mais c'était de la dette à retardement, du genre qui tombe des mois plus tard
au `npm ci` d'un déploiement, sans qu'aucun repo ait changé. Un pin doit viser une **ref
permanente** : un tag, ou à défaut un commit de la branche par défaut.

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
