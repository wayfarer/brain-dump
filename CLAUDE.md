# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dump              # Run the CLI (interactive interview REPL)
npm test                  # Run tests (Vitest)
npm test -- --watch       # Watch mode
npm run lint              # ESLint
npm run format            # Prettier (write)
npm run format:check      # Prettier (check only)
npm run dev               # Next.js dev server (web splash page only)
```

Run a single test file:
```bash
npx vitest run cli/store.test.ts
```

Live backend integration tests (requires real API keys):
```bash
BRAINDUMP_LIVE_TESTS=1 npx vitest run cli/backends/openai.integration.test.ts
```

The CLI can also be installed globally via `npm link`, exposing the `braindump` command.

## Architecture

Brain Dump is a **reverse chatbot**: it interviews the user to extract and persist structured memories. The system prompt is built dynamically using retrieved context from prior entries, then the LLM response is parsed to extract `ExtractedNode` objects which are saved to SQLite.

### Data flow for a single interview turn

```
user input
  → embed with text-embedding-3-small
  → vector search + FTS5 fallback (cli/store.ts)
  → build context-aware system prompt with bounded prior-node excerpts (cli/interview.ts: buildSystemPrompt)
  → ChatSession.sendMessage() (cli/backends/index.ts)
      → Codex app-server OR OpenAI API (with seamless fallback)
      → LLM returns extracted nodes via tool call / structured output
  → persistNodes() writes to SQLite (nodes + embeddings)
```

### Key modules

**`cli/interview.ts`** — The core of the application. `runTurn()` owns one interview exchange. `buildSystemPrompt()` retrieves up to 10 segment nodes (vector + FTS5) and formats them as truncated excerpts (tag, date, content preview) under a section char budget. `persistNodes()` calculates `depth` and `parentId` before insert.

**`cli/backends/index.ts`** — `ChatSession` selects between Codex (subscription) and OpenAI API backends. Detects Codex login via `codex login status`. Maintains a shared transcript so mid-session backend fallback is transparent to the user. Fallback triggers when Codex hits a usage limit.

**`cli/backends/openai.ts` / `codex.ts`** — Both implement `ChatBackend`. OpenAI uses streaming + the `extract_memory_node` tool call. Codex uses the `codex app-server` v2 protocol with `turn/start.outputSchema` for structured JSON output.

**`cli/store.ts`** — All SQLite access. `openDb()` runs schema migrations automatically on startup (versioned with `PRAGMA user_version`). Provides vector search (`sqlite-vec`, 1536-dim) and FTS5 full-text search. Embeddings always use OpenAI's `text-embedding-3-small`.

**`cli/index.ts`** — The REPL loop. Parses slash commands (`/list`, `/tags`, `/search`, `/export`, `/help`, `/exit`) and delegates interview turns to `runTurn()`.

### Data model

`DumpNode` is the core record:
- `tag` — 1–4 word thematic label (LLM-extracted, drives aggregation)
- `content` — raw user response text (FTS5-indexed)
- `segment` — coarse interview domain (`life_story`, `dream_journal`); configured in `SEGMENTS` in `interview.ts`
- `capturedAt` — when the interview happened (ordering sessions)
- `memoryDate` / `memoryDateGranularity` — when the remembered event occurred (ordering the life narrative)
- `depth` — distance from branch root (computed at insert, not stored by LLM)
- `parentId` — links follow-up answers within an interview branch

### Storage

- Database file: `./dump.db` (relative to CWD where `npm run dump` is invoked)
- WAL mode + foreign keys enabled
- FTS5 sync is automatic via triggers; do not manually manage the `nodes_fts` table
- Schema migrations run on every `openDb()` call; newer DB versions are rejected with a clear error

### Web layer

`src/app/` is a static Next.js splash page with no database access. All meaningful logic is in `cli/`.

### Auth

- `OPENAI_API_KEY` is required for embeddings and as the API fallback for chat
- Codex (ChatGPT subscription) is the preferred chat backend when `codex login` is active
- `BRAINDUMP_BACKEND=openai` forces the API backend regardless of Codex login state
