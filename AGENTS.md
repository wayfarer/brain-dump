# Agent Guidelines

These instructions are for Codex and other agents working in this repository.

## Project Shape

- `cli/` is the primary product surface. It contains the interview REPL, chat backends, SQLite store, import/export logic, and tests.
- `src/app/` is currently a minimal Next.js splash page. It does not read from SQLite.
- `README.md`, `AGENTS.md`, and agent-specific docs such as `CLAUDE.md` are part of the maintainable project documentation.

## Scope

- It is OK to inspect and edit `cli/`, `src/`, `README.md`, `AGENTS.md`, and related project docs when the task calls for it.
- Do not inspect or edit generated/vendor outputs such as `node_modules/`, `.next/`, `package-lock.json`, `cli/tsconfig.tsbuildinfo`, `dump.db`, or exported dump artifacts unless the user explicitly asks.
- If a tool or build command rewrites generated framework metadata, keep that churn out of feature commits unless it is the requested change.

## Execution Policy

- Respect analysis-only requests: when the user asks only to analyze, review, or plan, do not edit files or commit.
- When the user explicitly asks to implement, fix, commit, or push, perform the requested action with a focused diff.
- Prefer the repository's existing patterns over new abstractions. Keep changes scoped to the requested behavior.
- Do not revert changes you did not make. If other agent or user work is present, avoid staging it unless the user asks.

## Verification

- For CLI/store/interview changes, run the focused Vitest file first when practical, then `npm test`.
- Run `npm run lint` for TypeScript changes.
- Run `npm run build` when changes may affect TypeScript compilation or the Next.js app.
- Live integration tests require credentials and should only be run when explicitly requested.

## Git Hygiene

- Make focused commits that include only the files relevant to the task.
- Before committing, check `git status --short` and review the staged diff.
- If adding Codex authorship, use:
  `Co-Authored-By: Codex <codex@openai.com>`
