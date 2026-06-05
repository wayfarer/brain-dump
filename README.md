# Brain Dump

A reverse chatbot that interviews you to build a structured, queryable record of a subject — not a transcript, but a tagged chronology of moments, memories, facts, decisions, and ideas that can be searched, grouped, and exported.

## Concept

Most chat interfaces let the user drive. Brain Dump inverts that: the model is the interviewer, asking one good question at a time. The user remembers, explains, or reasons aloud. Out of that exchange a structured record accumulates.

## Product Thesis

Brain Dump starts with autobiographical memory because it is the hardest capture
problem: broad scope, fuzzy chronology, emotional context, recurring themes,
partial dates, and long-range connections across a lifetime. If the model can
handle that, narrower subjects like product design sessions, meeting outcomes,
project retrospectives, research notes, family history, dream journals, medical
history, and synthetic logs become simpler variants of the same structured
interview pattern.

The goal is not a generic assistant chat. Free text is interview material. New
capabilities should preserve that capture contract by adding subjects, segments,
or interview skills that alter the path of questioning while still producing a
portable structured dump.

## Segments

A **segment** is an interview domain — a configured opening question, system prompt, and tag style. Different segments capture different kinds of material but share the same underlying schema.

- **Life Story** (default, always available) — opens with the hardcoded question `"What is your first memory?"`. Its record serves as the user's foundational memory context that other segments can draw on as background.
- **Dream Journal** (`dream_journal`) — opens with `"Tell me about a dream you remember."` Uses a dream-focused interviewer prompt and pulls relevant `life_story` captures as background context during interviews.
- **Future segments** — project retrospectives, product design sessions, meeting outcomes, family history, medical history, and other directed-interview domains. Each carries its own prompt configuration but writes into the same data model.

## Data Model

Each node captures one response — one moment, fact, or memory.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `tag` | string | 1–4 word LLM-extracted label. Indexed. |
| `content` | string | The user's response text. Full-text searchable. |
| `parent_id` | UUID \| null | Follow-up chain within an interview branch. |
| `captured_at` | timestamp | Always precise. When the interview recorded the node. |
| `memory_date` | string \| null | When the remembered event occurred. May be partial. |
| `memory_date_granularity` | enum \| null | See below. |
| `segment` | string | The segment this node belongs to. |
| `depth` | int | Distance from the root of the current branch. |

### Two timestamps

`captured_at` orders the interview sessions. `memory_date` orders the life narrative — the user's recollection of when the actual event occurred. Sorting by one or the other gives you the chronology of *capture* versus the chronology of *life*.

### Granularity

Human memory rarely surfaces with time-of-day precision. The granularity ladder reflects what memory actually carries:

- `decade` — "the 80s"
- `year` — "1987"
- `season` — "summer 1987"
- `month` — "June 1987"
- `date` — "June 14, 1987"
- `datetime` — reserved for imported synthetic data (logs, calendar entries, tooling exports). The interview pathway never produces `datetime` nodes.

`memory_date_granularity: null` means no date information was captured for this node. `memory_date` will also be null in that case. The two fields are always null together.

### Depth

`depth` is stored at insert time by the caller. Nodes are append-only — `parent_id` never changes after insert — so the stored value cannot drift from the actual tree structure.

### Branching

Within a segment, the interview continues the most recent branch by default.
When a backend extracts a node without a valid explicit parent, the CLI attaches
it to the session's `lastParentId` and increments `depth`. A node becomes a new
branch root only when there is no available parent, such as the first captured
node in a segment.

The interviewer may ask to continue an open thread or move to a new area, but
branch selection is currently implicit in the persisted chain rather than a
separate user command.

### Segment vs. tag

`segment` is the interview domain: coarse, configured before the session starts (e.g. `life_story`, `dream_journal`). `tag` is the thematic label the LLM assigns to a specific node: fine-grained and assigned per response (e.g. `"fierce belonging"`, `"quiet shame"`). Segment is the container; tag is the lens.

### Tags

A tag is a short normalized label — `"sudden loss"`, `"fierce belonging"`, `"quiet shame"`. Tags drive aggregation: every appearance of a tag across all branches and all sessions forms a theme view. The chronology stays linear; tags are the lens through which it's queried.

The inverse query also matters: starting from a free-text phrase (`"grandmother"`, `"the cabin"`) and pulling back the *set of tags* whose nodes mention it. The LLM uses this during an interview to surface relevant prior themes without the user having to name them. Full-text search over `content` is what enables that pattern.

During an interview, prior captures in the active segment are retrieved (vector search with FTS5 fallback) and injected into the system prompt as **truncated excerpts** — tag, optional memory date, depth, and a capped content preview — so the interviewer can ask informed follow-ups across sessions, not only within the current transcript.

Segments that declare a **background segment** (today: `dream_journal` → `life_story`) also retrieve a small bounded set of life-story excerpts so the interviewer can connect dreams to known people, places, and themes without mixing segment data in storage.

## Storage

SQLite via `better-sqlite3` — single file (`dump.db`), no server, WAL mode. Indexed lookups on `id`, `parent_id`, `tag`, `captured_at`, and `segment`. FTS5 full-text search on `content`, kept in sync via insert/update/delete triggers.

The database schema is versioned with SQLite `PRAGMA user_version`. Startup runs
the migration path before any reads or writes, so existing databases are brought
up to the current schema in place. Databases from newer app versions are refused
with a clear error rather than opened unsafely.

JSON is the canonical **export/import** format. `exportToJson` serializes the full database to a `DumpRecord` (version 2). `importFromJson` loads a v1 or v2 JSON record into SQLite — idempotent, runs in a transaction. On first startup, if a legacy `dump.json` is present and the database is empty, it is migrated automatically and renamed to `dump.json.migrated`.

Both `dump.db` and exported JSON are written relative to your **current working directory** — not the project install path. If you use `npm link`, run export from the directory where you keep your data.

### Export & portability

Brain Dump is designed so your record stays **yours**: a plain JSON file you can back up, move between machines, inspect, share selectively, and plug into other tools or agent harnesses. That matters because the value compounds over time — tags, follow-up chains, dates, and subject-specific segments form structured context that is far more useful for personalization and collaboration than a raw chat transcript.

What you can do with an export:

- **Back up** before migrating machines or reinstalling
- **Personalize other AI tools** — paste tagged memories or subject notes into a system prompt, feed the JSON into a RAG pipeline, or build a custom context loader
- **Analyze outside the app** — query by tag, sort by `memory_date`, visualize branches, or summarize decisions in your own UI
- **Share selectively** — hand someone a redacted JSON slice of a brainstorming session, meeting, project, or life-history branch without giving up your live database

The export includes every node across all segments, with stable UUIDs, so re-importing into a fresh `dump.db` is safe and idempotent (`INSERT OR IGNORE`).

### Export & import

Export the full record to JSON (no API key required):

```sh
braindump --export                        # writes ./dump-export.json
braindump --export ~/backups/my-dump.json
npm run dump -- --export backup.json
```

Import happens automatically on first startup: place a v1 or v2 JSON file at `./dump.json` before `dump.db` exists, and the CLI migrates it into SQLite and renames the file to `dump.json.migrated`. To merge an export into an existing database programmatically, use `importFromJson` from `cli/store.ts` — it skips nodes whose IDs are already present.

## Layout

```
cli/      Interview REPL — Codex-subscription or OpenAI chat backend, node extraction
cli/backends/  Chat-backend seam: Codex app-server, OpenAI API, fallback session
study/    Small type-model study for possible future web graph work
src/app/  Splash page (Next.js, static for now)
```

The CLI is the primary capture interface. The web app is a splash; a graph/timeline UI is out of current scope.

## Current Status

The project is CLI-first. The README describes the intended capture, storage,
search, import, and export behavior for the interview system. The `src/app`
surface is intentionally minimal right now: it renders a static splash page and
does not read from the SQLite database.

The web app should not be treated as the primary product surface yet. Future web
work can add graph, timeline, search, or export views, but those are not part of
the current scope.

## Documentation Notes

The schema rules below are the source of truth for the current data model:

- `captured_at` records when the interview captured the node.
- `memory_date` records when the remembered event occurred, if known.
- `memory_date` and `memory_date_granularity` are always null together.
- `depth` is stored at insert time because nodes are append-only.
- `parent_id` continues the current branch by default using the session's last captured node.
- `segment` is the configured interview domain.
- `tag` is the per-node thematic label extracted from the response.

## Running

### Install

```sh
npm install && npm link   # exposes `braindump` in your PATH
```

Then from anywhere:

```sh
braindump                             # Start a life_story session (default)
braindump --segment dream_journal     # Start a dream_journal session
braindump --export my-backup.json     # Export all nodes to JSON (no API key)
```

Or without installing, from inside the project:

```sh
npm run dump
npm run dump -- --segment dream_journal
npm run dump -- --export backup.json
```

```sh
npm test                              # Run the test suite
BRAINDUMP_LIVE_TESTS=1 npm test       # Also run live backend checks when credentials are available
```

### Authentication

The interview can run on either of two chat backends:

- **Codex subscription** — sign in once with `codex login` (a ChatGPT Plus/Pro account). Brain Dump drives the local `codex app-server`, so chat rides your subscription with no API billing. The Codex CLI must be installed and logged in.
- **OpenAI API key** — set `OPENAI_API_KEY` in `.env` (see `.env.example`). Used for chat when Codex isn't available, and **always** for embeddings (vector search) — the subscription doesn't expose embeddings.

Selection is automatic: Codex is used when you're logged in, otherwise the API key. Override with `--backend codex|openai|auto` or `BRAINDUMP_BACKEND`.
When `--backend codex` is forced, the CLI checks `codex login status` before starting and exits with a clear error if the Codex CLI is unavailable or not signed in.

| Codex login | API key | Behavior |
|---|---|---|
| ✅ | ✅ | Codex chat; embeddings + automatic fallback on the API key |
| ✅ | — | Codex chat; retrieval degrades to full-text search (no embeddings) |
| — | ✅ | OpenAI API for everything |
| — | — | Error — run `codex login` or set `OPENAI_API_KEY` |

If the subscription hits its usage limit mid-session and an API key is set, Brain Dump prints a one-line notice and continues on the API key for the rest of the session (the subscription is retried on next launch).

### Segments

| Segment | Opening question |
|---|---|
| `life_story` | What is your first memory? |
| `dream_journal` | Tell me about a dream you remember. |

Each session writes only to its own segment. Context surfaced to the interviewer is scoped to the active segment, with optional background from `life_story` for segments that declare it. When extraction fails (malformed tool output), the CLI prints a warning so you know nothing was saved.

### REPL commands

During a session, lines starting with `/` are handled locally without calling the LLM. Commands that read back nodes (`/search`, `/list`, `/tags`) are scoped to the active segment. An unrecognized `/` command prints a hint rather than being sent to the LLM.

| Command | Description |
|---|---|
| `/search <query>` | Full-text search across captured nodes in the active segment. Prints matching nodes with their tag, memory date (if known), and a content preview. |
| `/list [n]` | Show the `n` most recent captured nodes in the active segment (default 10). |
| `/tags` | List the active segment's tags with occurrence counts, sorted by frequency. |
| `/help` | Show the list of available commands. |
| `/exit` | End the session (equivalent to Ctrl+C). |
