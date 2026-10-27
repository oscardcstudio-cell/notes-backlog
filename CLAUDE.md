> Hiérarchie : hérite de C:\dev\claude\CLAUDE.md et C:\dev\claude\oscardcstudio\CLAUDE.md

# notes-backlog

Package partagé (widget de notes, drain vers BACKLOG.md, coverage, audit). Consommé uniquement en `github:oscardcstudio-cell/notes-backlog#<tag>`, jamais copié (cf. [VENDORED.md](VENDORED.md)).

- Test : `npm install && npm test` (smoke, suites `node:test`, puis `scripts/check-vendored.mjs`). Tout doit passer.
- Tout changement de `src/` = bump de version dans `package.json` + tag `vX.Y.Z` poussé, puis bump des consommateurs listés dans VENDORED.md.
- Un pin de consommateur vise un tag, jamais le SHA d'une branche de PR (invalidé par le squash-merge).
- `check-vendored.mjs` lit le store de subvention_match par un chemin relatif à `C:\dev\claude` : cible absente = SKIP, pas échec.
- Le noyau (`categorize`, `drain`, `coverage`, `audit`) est agnostique et sans I/O : les patterns et presets viennent de l'appelant.
- Carte des fichiers : [llms.txt](llms.txt).
