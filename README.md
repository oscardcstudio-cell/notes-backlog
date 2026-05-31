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

## Origine

Extrait d'Auto-Polymarket où le module relie le dashboard (Railway) au `BACKLOG.md`
local — voir `.orchestrator/README.md` §notes du projet d'origine.
