# Brain Dump

A reverse chatbot that interviews you to build a structured, queryable record of your life — not a transcript, but a tagged chronology of moments, memories, and facts that can be searched, grouped, and exported.

## Concept

Most chat interfaces let the user drive. Brain Dump inverts that: the model is the interviewer, asking one good question at a time. The user remembers and responds. Out of that exchange a structured record accumulates.

## Segments

A **segment** is an interview domain — a configured opening question, system prompt, and tag style. Different segments capture different kinds of material but share the same underlying schema.

- **Life Story** (default, always available) — opens with the hardcoded question `"What is your first memory?"`. Its record serves as the user's foundational memory context that other segments can draw on as background.
- **Future segments** — dream journals, project retrospectives, family history, medical history, and other directed-interview domains. Each carries its own prompt configuration but writes into the same data model.

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

### Segment vs. tag

`segment` is the interview domain: coarse, configured before the session starts (e.g. `life_story`, `dream_journal`). `tag` is the thematic label the LLM assigns to a specific node: fine-grained and assigned per response (e.g. `"fierce belonging"`, `"quiet shame"`). Segment is the container; tag is the lens.

### Tags

A tag is a short normalized label — `"sudden loss"`, `"fierce belonging"`, `"quiet shame"`. Tags drive aggregation: every appearance of a tag across all branches and all sessions forms a theme view. The chronology stays linear; tags are the lens through which it's queried.

The inverse query also matters: starting from a free-text phrase (`"grandmother"`, `"the cabin"`) and pulling back the *set of tags* whose nodes mention it. The LLM uses this during an interview to surface relevant prior themes without the user having to name them. Full-text search over `content` is what enables that pattern.

## Storage

SQLite via `better-sqlite3` — single file (`dump.db`), no server, WAL mode. Indexed lookups on `id`, `parent_id`, `tag`, `captured_at`, and `segment`. FTS5 full-text search on `content`, kept in sync via insert/update/delete triggers.

JSON is the canonical **export/import** format. `exportToJson` serializes the full database to a `DumpRecord` (version 2). `importFromJson` loads a v1 or v2 JSON record into SQLite — idempotent, runs in a transaction. On first startup, if a legacy `dump.json` is present and the database is empty, it is migrated automatically and renamed to `dump.json.migrated`.

## Layout

```
cli/      Interview REPL — OpenAI streaming + tool-call node extraction
study/    Data model comparison study (current focus)
src/app/  Splash page (Next.js, static for now)
```

The CLI is the primary capture interface. The web app is a splash; a graph/timeline UI is out of current scope.

## Running

```sh
npm run dump   # Start an interview session
npm test       # Run the test suite (CLI unit + integration)
```

Requires `OPENAI_API_KEY` in `.env` (see `.env.example`).

### REPL commands

During a session, lines starting with `/` are handled locally without calling the LLM:

| Command | Description |
|---|---|
| `/search <query>` | Full-text search across all captured nodes. Prints matching nodes with their tag, memory date (if known), and a content preview. |
