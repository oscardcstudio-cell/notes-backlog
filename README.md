# notes-backlog

Widget de prise de notes (idée / bug / observation) qui alimente un `BACKLOG.md`.
Extrait du dashboard Auto-Polymarket, rendu réutilisable et **storage-agnostic**.

Trois briques indépendantes :

| Brique | Import | Rôle |
|---|---|---|
| **Backend** | `notes-backlog/server` | Routeur Express (POST/GET note, mark processed/abandoned) |
| **Widget** | `notes-backlog/client` | Composant React flottant autonome (sans dépendance UI) |
| **Drain** | `notes-backlog/drain` | CLI/fonction : notes pending → `BACKLOG.md` → marque traité |
| **Coverage** | `notes-backlog/coverage` | CLI/fonction : croise `BACKLOG.md` ↔ `ROADMAP.md`, signale les idées orphelines (mini-RTM) |
| **Categorize** | `notes-backlog/categorize` | Range une note dans une catégorie (règles + LLM injecté), agnostique |
| **Presets** | `notes-backlog/presets/company-phases` | Data optionnelle : 8 phases du `COMPANY_PLAYBOOK.md` |

Flux : on saisit une note dans le widget → POST stockée (`pending`) → un cron lance le drain → la note atterrit dans `BACKLOG.md` et passe `processed`.

## Installation

Consommé en dépendance versionnée (jamais vendorisé — cf. `VENDORED.md`) :

```bash
# recommandé (marche en Docker/Railway ET en clone standalone) :
npm install github:oscardcstudio-cell/notes-backlog#v1.5.0
# ou, en dev local depuis un projet voisin :
npm install file:../packages/notes-backlog
```

`express` (≥4) et `react` (≥17) sont des peerDependencies optionnelles — chaque brique n'en charge qu'une.

## Backend

Endpoints montés (relatifs au mount point) :

```
POST   /                { text }                   → crée une note (status=pending)
GET    /                ?status=pending|processed|abandoned → liste (status validé)
POST   /:id/processed   { backlog_ref? }           → marque traitée
POST   /:id/abandoned   { reason? }                → marque abandonnée (rejetée sans drain)
```

```js
import { createNotesRouter } from 'notes-backlog/server';
import { createJsonFileStore } from 'notes-backlog/server/stores/json-file';

const store = createJsonFileStore('./data/notes.json');
app.use('/api/notes', createNotesRouter({
    store,
    auth: requireAdmin,        // middleware Express — SANS lui les endpoints sont publics (warn)
    enforceAuth: true,         // optionnel : throw au montage si `auth` absent
    maxNoteLen: 2000,
    maxNotesKept: 100,
    onCreate: (note) => {/* flush DB, log, … */},  // appelé AVANT prune
}));
```

> ⚠ Sans `auth`, tous les endpoints (dont l'écriture disque) sont **publics**. Le montage
> émet un warn ; passe `enforceAuth: true` pour refuser un montage non protégé en prod.

### Contrat `store` (adaptateur de stockage)

Branche n'importe quelle persistance en implémentant :

```
list()                     → Note[]      (plus récentes en premier)
add(note)                  → void        (insère en tête)
markProcessed(id, ref)     → Note|null   (status→processed + processed_at + backlog_ref)
markAbandoned(id, reason?) → Note|null   (status→abandoned + abandoned_at + reason)
prune(max)                 → void        (optionnel)
```

Stores fournis : `notes-backlog/server/stores/memory` (volatile) et `.../json-file`
(fichier JSON atomique). Pour une DB (Postgres/Supabase/Drizzle…), écris un store
qui respecte ce contrat — c'est ~30 lignes.

> ⚠ Le `jsonFileStore` est perdu au redeploy sur un host éphémère sans volume.
> Pour de la durabilité, utilise un store DB.

### Forme d'une note

```json
{ "id": "note_...", "text": "...", "created_at": "ISO",
  "status": "pending|processed|abandoned",
  "processed_at": null, "backlog_ref": "...",
  "abandoned_at": null, "reason": "..." }
```

## Widget React

```jsx
import { NotesWidget } from 'notes-backlog/client';

<NotesWidget
    apiBase="/api/notes"
    authHeaders={() => ({ 'x-admin-token': adminToken })}
    title="📝 Note → Backlog"
    accentColor="#6366f1"
/>
```

Autonome (styles inline, aucune lib UI). Bouton flottant en haut à droite, panneau
avec textarea (Ctrl/Cmd+Enter pour envoyer) + historique des 12 dernières notes.

## Drain → BACKLOG.md

Le `BACKLOG.md` cible doit contenir une ligne marqueur (défaut `## À faire`) ;
les items sont insérés juste en-dessous.

```js
import { drainNotes } from 'notes-backlog/drain';

await drainNotes({
    baseUrl: 'https://app.example.com',
    notesPath: '/api/notes',
    backlogPath: '/abs/path/BACKLOG.md',
    marker: '## À faire',
    authHeaders: { 'x-admin-token': process.env.ADMIN_TOKEN },
});
```

En CLI (binaire `notes-drain`), config par env :

```bash
NOTES_BASE_URL=https://app.example.com \
NOTES_BACKLOG_PATH=/abs/path/BACKLOG.md \
NOTES_AUTH_HEADER=x-admin-token NOTES_AUTH_VALUE=$ADMIN_TOKEN \
node node_modules/notes-backlog/src/drain/drainNotes.js
```

À lancer périodiquement (cron, scheduler applicatif, tâche planifiée). Fail-soft :
serveur down ⇒ les notes restent `pending`, drainées au run suivant.

## Catégorisation automatique (par phase)

Optionnel. En passant `categories`, chaque note est **classée** et insérée sous le
`marker` de sa catégorie (au lieu du marker global). Le BACKLOG doit alors contenir
une section par catégorie.

Moteur **hybride, config-driven** (le package ne hardcode aucune taxonomie) :
1. **Règles** d'abord — score par mots-clés (gratuit, instantané) ;
2. **LLM en fallback** — seulement si les règles ne tranchent pas (zéro match ou
   égalité). Aucun client LLM embarqué : tu injectes `llmClassifier`.

```js
import { drainNotes } from 'notes-backlog/drain';
import { companyPhases } from 'notes-backlog/presets/company-phases'; // preset 8 phases

await drainNotes({
    baseUrl, backlogPath, marker: '## À trier',
    categories: companyPhases,                 // ou tes propres buckets
    llmClassifier: async (text, cats) => {     // optionnel
        // appelle TON LLM, renvoie l'id d'une catégorie
        return 'p4-offre-gtm';
    },
});
```

Une catégorie : `{ id, label?, keywords?: string[], marker?: string, default?: boolean }`.
`default: true` = repli si rien ne matche. Si la section d'une phase est absente du
BACKLOG, le drain retombe sur le marker global (fail-soft).

Classement seul (hors drain) :

```js
import { categorize } from 'notes-backlog/categorize';
const { id, marker, via } = await categorize('tester le pricing', companyPhases);
// → { id: 'p4-offre-gtm', via: 'rules', ... }
```

Le preset `company-phases` mappe les notes sur les 8 phases du `COMPANY_PLAYBOOK.md`
(start-up-box) → une note connaît la phase à laquelle la traiter.

### Double-write `notes/<sujet>.md` (réservoir par sujet, optionnel)

En plus du BACKLOG, le drain peut déposer chaque note dans un fichier-réservoir par
sujet (`notes/<sujet>.md`), où la note est *invoquée* par le plan quand sa phase démarre :

```js
await drainNotes({
    baseUrl, backlogPath, marker: '## À trier',
    subjects: [{ id: 'tech-ops', filePath: 'tech-ops.md', keywords: ['api', 'infra'] }],
    notesDir: '/abs/path/.planning/notes',     // les filePath sont résolus SOUS ce dossier
    subjectAliasMap: { infra: 'tech-ops', ops: 'tech-ops' },  // alias du préfixe "note <alias>:"
});
```

Routage : préfixe explicite `note <alias>:` d'abord (résolu via `subjectAliasMap`), sinon
keyword matching. Fichier sujet absent → skip (BACKLOG seul). `filePath` qui s'échappe de
`notesDir` (`..`, absolu) → rejeté (anti path-traversal).

## Couverture backlog ↔ plan (mini-RTM, "lisseur d'idées")

Vérifie qu'aucune idée du backlog n'est **perdue** : croise un backlog/notes markdown
avec un plan/roadmap markdown et liste ce qui n'y est pas repris. C'est le pattern
industriel de **traçabilité (RTM, requirements traceability matrix)** — détection des
*orphaned items* — appliqué au markdown (ce qu'aucun outil markdown/git ne fait off-the-shelf).

Sémantique d'un item (déterministe, anti-faux-positif) :

| Classe | Quand | Verdict |
|---|---|---|
| `linked` | porte un anchor (`[[P4]]`, `→ landing`, `ref:auth`) **résolu** dans le plan | ✅ couvert |
| `broken` | porte un anchor **introuvable** dans le plan | 🔴 lien cassé |
| `unlinked` | aucun anchor | 🟠 à rattacher (matching flou = simple *suggestion*) |

Le danger ciblé (idée droppée en silence) = `broken` + `unlinked`. On préfère sur-signaler
(faux orphelin = bruit) plutôt que sous-signaler. Le matching flou ne fait que **suggérer**
une présence possible (`maybeInPlan`), jamais affirmer "couvert".

```js
import { checkCoverage, formatCoverageReport } from 'notes-backlog/coverage';

const { summary, broken, unlinked } = checkCoverage(backlogMd, planMd);
// summary: { total, linked, broken, unlinked, orphans }
console.log(formatCoverageReport({ summary, broken, unlinked, linked: [] }));
```

En CLI (binaire `notes-coverage`) — **gate** : exit 1 si une idée risque d'être perdue
(utilisable en hook/CI) :

```bash
node node_modules/notes-backlog/src/coverage/coverage.js BACKLOG.md ROADMAP.md
```

Agnostique : aucun marker/taxonomie hardcodé. Patterns surchargeables
(`itemPattern`, `anchorPattern`, `includeDone`, `suggestMinTokens`).

## Cycle de vie complet d'une note

Une note passe par 4 états dans `.planning/notes/<sujet>.md` :

| État | Marqueur | Qui | Quand |
|---|---|---|---|
| **déposée** | `- [date] texte…` | drain automatique | note saisie dans le widget |
| **actionnée** | → issue / BACKLOG / phase GSD | agent/Oscar | décision "on revoit X" |
| **en cours** | item dans une phase GSD ou BACKLOG avec `[ ]` | agent | pendant l'implémentation |
| **résolue** | `✅ **RÉSOLU [date]** — fichier:ligne` | agent (après vérif code) | implémentation confirmée dans le code |

### Convention RÉSOLU

Quand un item est confirmé implémenté (grep/glob dans le code réel, jamais sur la mémoire) :

```markdown
- [2026-06-01] ~~**Titre de l'item**~~ ✅ **RÉSOLU [2026-06-05]** — `src/pages/Form.tsx:386`
```

**Règle de déclenchement** : si un agent re-surface un item comme "à faire" → vérifier dans le code → si implémenté → RÉSOLU immédiatement + propager dans `MASTER.md`/`ROADMAP.md`.

Sans ce marqueur, les items résolus restent indiscernables des items ouverts et les agents les re-surfacent à chaque session.

⚠️ **Cette règle ne suffit pas seule, et on l'a vérifié à ses dépens.** Elle se déclenche « si un agent
re-surface l'item » — donc si quelqu'un **relit** le répertoire. Dans un projet réel où rien ne lit les notes,
la relecture n'arrive jamais : sur trois mois, **32 clôtures sur 37 sont tombées le même jour** (une passe
d'audit manuelle), une seule le jour où le travail a été fait, délai médian **40 jours**. Un agent a fini par
recommander un chantier livré cinq semaines plus tôt. La capture a un déclencheur d'événement, la clôture
n'en avait aucun. D'où le module ci-dessous.

## Audit du répertoire (la moitié SORTIE)

`coverage` vérifie qu'aucune idée n'est perdue **du plan**. `audit` vérifie que les items **fermés le sont
vraiment** et que les items **ouverts le sont encore** — et donne à la clôture les déclencheurs qui lui
manquaient.

| Constat | Ce qu'il attrape | Gravité |
|---|---|---|
| `self-declared-done` | item ouvert dont le corps annonce « LIVRÉ / FAIT / ABANDONNÉ / PÉRIMÉ » — l'agent **savait**, il ne l'a pas dit au bon endroit | 🔴 |
| `stale-index` | fichier index qui se déclare à jour au ↔ date pendant qu'une source porte un item plus récent | 🔴 |
| `dangling-anchor` | RÉSOLU dont l'ancre code ne résout pas (fichier absent, ligne hors bornes, symbole introuvable) | 🔴 |
| `unproven-resolution` | RÉSOLU sans aucune ancre code | 🟠 |
| `orphan-file` | fichier de notes qu'aucune étape du plan ne référence → jamais relu | 🟠 |

```js
import { auditNotes, relatedOpenItems, formatAuditReport } from 'notes-backlog/audit';

const { findings, summary } = auditNotes({ notes, indexes, planRefs, repoFiles });
// summary: { total, errors, warnings, baselined, byKind }
```

En CLI (binaire `notes-audit`) — **gate** : exit 1 s'il reste un constat bloquant :

```bash
git ls-files > .cache/files.txt
notes-audit .planning/notes \
  --plan .planning/launch-plan.json \
  --index .planning/notes/CROSS-REF.md \
  --repo-files .cache/files.txt \
  --baseline .planning/notes-audit-baseline.json
```

### Ancres code : trois formes

```markdown
`src/Form.tsx:386`            fichier + ligne
`src/Form.tsx:STATUS_LIST`    fichier + SYMBOLE — PRÉFÉRÉ : survit au drift des lignes
`video-studio:src/index.ts:488`  ancre EXTERNE (autre repo) — jamais comptée cassée
```

Une ancre `fichier:ligne` reste « valide » longtemps après que le code visé a bougé : le numéro dérive, la
vérif ne dit plus rien. L'ancre symbole est cherchée dans le fichier, donc elle casse quand la chose casse.
La forme préfixée existe parce qu'une ref vers un autre repo est autrement indistinguable d'une ref cassée.

### Baseline — pourquoi le gate part vert

Un répertoire vivant a déjà un stock de constats le jour où on branche le gate. Le rendre rouge d'emblée
garantit le `--no-verify`, donc un gate mort, donc le problème d'origine. `--write-baseline` fige le stock
connu (dégradé en avertissement) : **seules les régressions échouent**. On draine le stock ensuite, en
retirant des lignes de la baseline.

L'empreinte d'un constat **exclut volontairement le numéro de ligne** — sinon la baseline périmerait au
premier commit et re-signalerait tout le stock comme nouveau.

### Le déclencheur de clôture

`relatedOpenItems(notes, changedPaths)` répond à : *quels items ouverts citent un fichier que ce push
modifie ?* C'est le chaînon manquant — au moment d'un push, quelqu'un sait si c'est fait.

```bash
git diff --name-only origin/main... > .cache/changed.txt
notes-audit .planning/notes --changed .cache/changed.txt
```

Informatif par nature : on ne bloque pas un push parce qu'une note parle du fichier.

## Origine

Extrait d'Auto-Polymarket où le module relie le dashboard (Railway) au `BACKLOG.md`
local — voir `.orchestrator/README.md` §notes du projet d'origine.
