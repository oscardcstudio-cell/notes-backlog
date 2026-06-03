# notes-backlog

Widget de prise de notes (idée / bug / observation) qui alimente un `BACKLOG.md`.
Extrait du dashboard Auto-Polymarket, rendu réutilisable et **storage-agnostic**.

Trois briques indépendantes :

| Brique | Import | Rôle |
|---|---|---|
| **Backend** | `notes-backlog/server` | Routeur Express (POST/GET note, mark processed) |
| **Widget** | `notes-backlog/client` | Composant React flottant autonome (sans dépendance UI) |
| **Drain** | `notes-backlog/drain` | CLI/fonction : notes pending → `BACKLOG.md` → marque traité |

Flux : on saisit une note dans le widget → POST stockée (`pending`) → un cron lance le drain → la note atterrit dans `BACKLOG.md` et passe `processed`.

## Installation

Pas encore publié sur npm. Consommation locale :

```bash
npm install file:../packages/notes-backlog      # depuis un projet voisin
# ou, une fois poussé sur GitHub perso :
npm install github:oscardcstudio-cell/notes-backlog
```

`express` (≥4) et `react` (≥17) sont des peerDependencies optionnelles — chaque brique n'en charge qu'une.

## Backend

```js
import { createNotesRouter } from 'notes-backlog/server';
import { createJsonFileStore } from 'notes-backlog/server/stores/json-file';

const store = createJsonFileStore('./data/notes.json');
app.use('/api/notes', createNotesRouter({
    store,
    auth: requireAdmin,        // middleware Express optionnel
    maxNoteLen: 2000,
    maxNotesKept: 100,
    onCreate: (note) => {/* flush DB, log, … */},
}));
```

### Contrat `store` (adaptateur de stockage)

Branche n'importe quelle persistance en implémentant :

```
list()                 → Note[]      (plus récentes en premier)
add(note)              → void        (insère en tête)
markProcessed(id, ref) → Note|null   (status→processed + processed_at + backlog_ref)
prune(max)             → void        (optionnel)
```

Stores fournis : `notes-backlog/server/stores/memory` (volatile) et `.../json-file`
(fichier JSON atomique). Pour une DB (Postgres/Supabase/Drizzle…), écris un store
qui respecte ce contrat — c'est ~30 lignes.

> ⚠ Le `jsonFileStore` est perdu au redeploy sur un host éphémère sans volume.
> Pour de la durabilité, utilise un store DB.

### Forme d'une note

```json
{ "id": "note_...", "text": "...", "created_at": "ISO",
  "status": "pending|processed", "processed_at": null, "backlog_ref": "..." }
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
import { companyPhases } from 'notes-backlog/presets/company-phases'; // preset 7 phases

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

Le preset `company-phases` mappe les notes sur les 7 phases du `COMPANY_PLAYBOOK.md`
(start-up-box) → une note connaît la phase à laquelle la traiter.

## Origine

Extrait d'Auto-Polymarket où le module relie le dashboard (Railway) au `BACKLOG.md`
local — voir `.orchestrator/README.md` §notes du projet d'origine.
