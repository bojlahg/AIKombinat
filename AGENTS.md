# AGENTS.md

This file is the primary repository contract and guidance for coding agents working in this repository.

## Project Overview

AIKombinat is a full-stack app that automates AI-powered task execution. Users write TODO items in a web UI, and the system spawns isolated git worktrees for each task, running Claude/Antigravity/Codex CLI tools in parallel. Built with Express + React + SQLite + WebSocket.

## Commands

```bash
# Development (runs server + client concurrently)
npm run dev

# Build
npm run build                  # both client and server
npm run build:server           # server only (→ dist/server/)
npm run build:client           # client only (→ src/client/dist/)

# Tests
npm run test                   # all tests (server + client)
npm run test:server            # server tests only (vitest, node env)
npm run test:client            # client tests only (vitest, jsdom env)
npx vitest run src/server/path/to/file.test.ts   # single server test
cd src/client && npx vitest run src/path/to/file.test.tsx  # single client test

# Type checking
npm run typecheck              # server + client

# Desktop packaging
npm run electron:build         # current platform
npm run electron:build:win     # Windows
npm run electron:build:mac     # macOS
npm run electron:build:linux   # Linux
scripts/build-win.bat          # Windows helper; --skip-install/-s skips npm ci; --msix for appx target
```

## Architecture

### Monorepo Layout

- **`src/server/`** — Express backend (TypeScript, ESM). Entry: `src/server/index.ts`. DB: SQLite (`better-sqlite3`, WAL) in `src/server/db/`. Services in `src/server/services/`, routes in `src/server/routes/`, plugins in `src/server/plugins/`.
- **`src/client/`** — React frontend (Vite + TailwindCSS). Separate `package.json`. Entry: `src/client/src/main.tsx` → `App.tsx`.
- **`bin/aikombinat.js`** — npm CLI entry (`bin/clitrigger.js` compatibility wrapper).
- **`plugin/`** — Hecaton TUI plugin (CommonJS, Deno-compatible).

## Key Patterns & Gotchas

These encode constraints that aren't obvious from the code. Apply when touching related areas.

- **Sandbox Mode — Claude absolute path gotcha**: `.claude/settings.json` patterns MUST use absolute paths (`${workDir}/**`) — Claude resolves relative paths internally and the match fails. Also normalize `workDir` to forward slashes (`workDir.replace(/\\/g, '/')`) on Windows — mixed separators silently reject every Edit/Write match.
- **Wiki naming convention**: UI was renamed Memory→Wiki but DB tables, routes (`/api/projects/:id/memory/*`), files (`MemoryList.tsx`, `memory-injector.ts`), and the `<long_term_memory>` prompt tag intentionally retain "memory" — don't rename them. The XML tag is a semantic hint to LLMs.
- **Floating Window state gating**: `SessionWindowsHost` persists `OpenGroup[]` to `sessionGroups:{projectId}` localStorage. Persist must be **gated on `sessions` having loaded** so empty-during-load doesn't nuke restored state. Hydrate in `useState` initializer (synchronous), not a post-mount effect — a persist effect can race and write `[]` first.
- **Raw Binary Streaming**: **DB `session_raw_chunks` are the single source of truth for replay** — `session:subscribe` flushes the in-flight buffer then sends only DB chunks. Never replay from both ring buffer + DB (causes duplicate output).
- **Native Focus Handoff (Electron)**: React `element.focus()` doesn't reclaim native HWND focus from xterm.js. Use the IPC bridge: `electronAPI.imeReset()` → `mainWindow.webContents.focus()` in main process, then RAF twice before focusing the target.

## UI Guidelines

> Use `.claude/docs/design.md` as the reference for visual design decisions.

### Floating elements must render via portal

Tooltips, dropdowns, popovers, context menus, and "more" menus MUST use `createPortal(..., document.body)` with `position: fixed` + viewport clamping. Do NOT use `position: absolute` — parent containers have `overflow`/`transform` that clip.

Checklist:
- `createPortal` into `document.body`
- `position: fixed`, top/left from anchor's `getBoundingClientRect()`
- Clamp within viewport (flip/shift), ≥8px from edges
- Recompute on `scroll` (capture) and `resize`
- `z-tooltip` z-index class

## Environment

Config via `.env` (see `.env.example`), `~/.aikombinat/config.json` (or legacy `~/.clitrigger/config.json`), or Electron `userData/config.json`.
Key vars: `PORT` (default 3000), `DB_PATH`, `TUNNEL_ENABLED`, `HEADLESS`, `DISABLE_AUTH`.

Runtime diagnostics go to the console **and** to a rotating log file (`<app data>/logs/aikombinat.log`, or `<repo>/logs/` in development). Use the shared logger in `src/server/logging/` — `logger.info('event.name', { msg, scope, ...fields })` — instead of adding `console.*` calls; it handles console/file formatting, secret redaction and output caps. `AIKOMBINAT_LOG_LEVEL` (default `info`) and `AIKOMBINAT_LOG_DIR` control it. Never log prompts or full provider output.

## Language

The UI supports English, Korean, and Russian. Add new UI strings through the existing i18n system and provide all required core locale keys; do not hardcode Korean, English, or Russian UI text. English is the canonical core locale: EN/KO/RU must always have identical key sets and identical placeholder sets for every key. Keep plugin translation fallback semantics separate from mandatory core locale parity. Code identifiers and comments remain in English. Commit messages may be in English or Korean.

## Task Execution Guidelines

### Repository sync before every task
- Before reading implementation details for a new task or modifying any repository file, check the working tree for unresolved conflicts and then run `git pull --ff-only` for the current branch.
- If the repository already contains unmerged/conflicted paths, **stop immediately**. Do not edit files, stage changes, commit, reset, stash, merge, rebase, or attempt to resolve the conflict.
- If `git pull --ff-only` does not complete successfully for any reason, **stop the task and report the Git state/error**. Do not continue on a stale checkout.
- Never use automatic conflict resolution, `git reset --hard`, force checkout, force push, or destructive cleanup to make the pull succeed.
- Only begin task implementation after the pull completed successfully and the repository has no unresolved conflicts.

### Intentional upstream integration
- These rules apply only when the task **explicitly asks to integrate changes from an upstream repository**. They are a narrow exception to the normal rule that agents must stop on conflicted paths.
- First complete the normal clean-state check and successful `git pull --ff-only` above. Never begin upstream integration from a dirty, conflicted, or stale checkout.
- Perform upstream integration on a dedicated temporary/sync branch created from the freshly updated target branch. Do not experiment with upstream integration directly on `main`.
- Fetch the requested upstream remote/ref first. Integrate only the upstream branch or specific upstream commits requested by the task, using a normal merge or cherry-pick as appropriate.
- If that intentional merge/cherry-pick itself creates conflicts, the agent **may resolve only the conflicts created by that integration operation**. Inspect the base, our current AIKombinat code, and the upstream change before choosing the final content.
- Preserve AIKombinat-specific behavior and repository contracts unless the task explicitly asks to replace them. Do not discard local functionality merely to make upstream apply cleanly.
- Never use blanket conflict strategies such as `-X ours`, `-X theirs`, automatic whole-file conflict resolution, rebase, `git reset --hard`, force checkout, force push, or history rewriting.
- If a conflict cannot be resolved confidently and locally, abort the intentional integration with `git merge --abort` or `git cherry-pick --abort` as appropriate, then report the conflicting files and the reason. Do not guess.
- After resolving integration conflicts, review the resulting diff for accidental loss of local changes, run the validation requested by the task, commit the integration, and push the sync branch normally.
- The usual completion rule still applies: the task is not complete until the resulting commit/merge has been pushed successfully.

### Efficiency
- Use grep/glob to find relevant files FIRST. Do NOT read files one by one to explore.
- Only read files you intend to modify or that are directly needed.
- Do NOT launch subagents for simple tasks. Use direct grep → read → edit.
- Make all related edits in a single pass. Prefer `replace_all: true` for repetitive changes.
- Aim for under 15 tool calls for simple tasks, under 30 for complex ones.

### Completion
- Once the requested work and validation are complete, commit the changes and then immediately run a normal `git push` for the current branch.
- A task is not complete until the commit has been pushed successfully to the configured remote branch.
- If `git push` fails for any reason, **stop and report the exact Git error/state**. Do not claim completion and do not use force push, rebase, reset, or other destructive/history-rewriting commands to make the push succeed.
- After a successful push, stop immediately. Do not perform additional refactoring, optimization, or testing beyond what was requested.
- Do not add comments, docstrings, or type annotations to unchanged code.
