# Project: Sentinal

**Last Updated:** 2026-04-08

## Overview

Sentinal is a quality enforcement plugin for TypeScript, Angular, and NestJS projects that ships as extensions for both **Claude Code** and **OpenCode**. It runs as an intelligent hook pipeline that checks every file edit, enforces TDD, tracks specs, and provides a `/spec` plan-implement-verify workflow. See `README.md` for user-facing docs.

**Package:** `@endpoint/sentinal` (private registry: `https://npm.cloud.endpoint.gg/`)

## Technology Stack

- **Language:** TypeScript (strict mode, `noImplicitAny`, ES2022, `moduleResolution: bundler`)
- **Runtime:** **Bun ≥ 1.0** (NOT plain Node.js — many features depend on Bun APIs)
- **Test Runner:** `bun test` (bun:test, NOT jest)
- **Package Manager:** `bun` (see `bun.lock`)
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.27.1
- **Native deps:** `sqlite-vec` (loaded via Homebrew SQLite in tests), `@xenova/transformers` (384-dim embeddings)
- **Validation:** `zod` 4.x
- **CLI framework:** `commander` 14.x
- **Release:** `semantic-release` (automated versioning via `.releaserc.json`)

## Directory Structure

```
src/                       # Shared TypeScript (consumed by BOTH targets)
├── analysis/              # check_diagnostics, impact_analysis, quality_report MCP tools
├── checkers/              # typescript, angular, nestjs, detect — framework validation
├── cli/                   # Unified `sentinal` CLI (commander dispatcher + commands/)
├── config/                # Config loading
├── dashboard/             # TUI dashboard (10 files)
├── hooks/                 # Claude Code lifecycle hooks (stdin/stdout JSON I/O)
├── mcp/server.ts          # Universal MCP server — registers all tool modules
├── memory/                # SQLite + sqlite-vec vector store + embeddings + MCP tools
├── project/               # project_context MCP tool
├── session/ sessions/     # Session tracking, context window estimation
├── sidecar/               # Long-running HTTP sidecar (Unix socket preferred)
├── spec/                  # Spec workflow engine + MCP tools (spec_*)
├── tdd/                   # TDD cycle state + MCP tools
├── utils/                 # hook-output, file-length, tdd, git, shell
└── worktree/              # Git worktree management + MCP tools

targets/                   # Target-specific wrappers (SHIPPED TO USERS — see sentinal-targets-vs-src.md)
├── claude-code/           # Compiled hooks, rules, commands, agents, .mcp.json
└── opencode/              # Native TS plugin, rules, commands, opencode.json

templates/                 # Command templates with {{placeholders}} — generated into targets/
scripts/                   # generate-commands.js, install.sh, release-build.mjs, embed-assets.mjs
docs/plans/                # /spec workflow plan files (YYYY-MM-DD-<slug>.md)
bin/sentinal.sh            # CLI shim
```

## Key Files

- `src/index.ts` — Barrel exports (the `@endpoint/sentinal` public API)
- `src/cli/index.ts` — CLI entry point (compiled to `dist/sentinal`)
- `src/mcp/server.ts` — MCP server factory (`createSentinalServer`)
- `src/sidecar/client.ts` — `SidecarClient.connect()` (Unix socket + HTTP fallback)
- `targets/claude-code/hooks/hooks.json` — Claude Code hook pipeline definition
- `targets/opencode/plugins/sentinal.ts` — OpenCode plugin entry point
- `targets/opencode/opencode.json` — OpenCode config template (MCP, LSP, permissions)
- `bunfig.toml` — Test preload for sqlite-vec (`src/memory/test-preload.ts`)

## Development Commands

| Task                       | Command                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| Install deps               | `bun install`                                                     |
| Run all tests              | `bun test`                                                        |
| Watch tests                | `bun test:watch`                                                  |
| Run single test file       | `bun test src/path/to/file.test.ts`                               |
| Build Claude Code hooks    | `bun run build:claude` (→ `targets/claude-code/hooks/dist/`)      |
| Build OpenCode plugin      | `bun run build:opencode` (→ `targets/opencode/dist/sentinal.mjs`) |
| Build both targets         | `bun run build:all`                                               |
| Build CLI binary           | `bun run build:cli` (→ `dist/sentinal`)                           |
| Install to Claude Code     | `bun run install:claude-code`                                     |
| Install to OpenCode        | `bun run install:opencode`                                        |
| Deploy plugin to ~/.config | `bun run deploy:opencode`                                         |
| Run MCP server (stdio)     | `bun run mcp`                                                     |
| Memory CLI                 | `bun run memory`                                                  |

## Architecture Notes

- **Dual-target architecture** — shared `src/`, with target-specific wrappers in `targets/claude-code/` and `targets/opencode/`. Most changes need to land in both. See `sentinal-dual-target.md`.
- **Sidecar pattern** — `src/sidecar/server.ts` runs a long-lived HTTP server (Unix socket preferred). Hooks, the MCP server, and the OpenCode plugin all connect via `SidecarClient` to avoid per-invocation SQLite cold starts. See `sentinal-sidecar.md`.
- **Hook I/O protocol** — Claude Code hooks read JSON from stdin, write JSON to stdout. Exit code 2 with stderr = block. See `sentinal-hooks-development.md`.
- **MCP server** — single `sentinal` server exposing 28 tools across 6 domains (memory, spec, tdd, worktree, analysis, project). See `sentinal-mcp-servers.md`.
- **`.sentinal/` sidecar state** — runtime state (`compact-state.json`, `project-memory.json`) lives here, NOT in `.claude/` or `.opencode/`.
- **File length limits** — Sentinal enforces its own rules on itself: warn at 400 lines, block at 600 lines. Test files exempt.

## ⛔ Project Identity vs Workspace Root

Sentinal answers two **different** questions about "where am I", and conflating
them is a real bug that has shipped more than once. Both resolvers live in
`src/project/identity.ts`, are synchronous, never throw, and can never return
`""`:

| Function                      | Answers                     | Use for                                                           |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `resolveProjectIdentity(cwd)` | the **main checkout** path  | **STORAGE KEYS ONLY** — memory/spec/session rows, sidecar filters |
| `resolveWorkspaceRoot(cwd)`   | the **local checkout** root | **FILESYSTEM WRITES ONLY** — `.sentinal/` state, plans, artifacts |

**The one-line rule: identity → storage keys ONLY; workspace → filesystem
writes ONLY. A call site that needs both must call both.**

Why it matters in each direction:

- Using **workspace as a key** fragments a project's records — every linked
  worktree gets its own key, so observations recorded in a worktree are
  invisible from the main checkout (and vice versa).
- Using **identity as a write path** leaks state across checkouts — every
  worktree would write into the main checkout's `.sentinal/`.

### Audited worktree-local write sites (all four confirmed workspace-scoped)

| #   | Site                                                                   | Root it uses                                     | Verdict                          |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| 1   | `src/hooks/post-compact-restore.ts:33` (`compact-state.json`)          | `resolveWorkspaceRoot(input.cwd)`                | ✅ (changed — was `findGitRoot`) |
| 2   | `src/runtime/pidfile.ts:105-107` (`runtime.pid`)                       | explicit `worktreePath` param                    | ✅ unchanged                     |
| 3   | `src/worktree/slots.ts:49` → `worktree-config.ts:356` (`worktree.env`) | explicit `worktreePath` param                    | ✅ unchanged                     |
| 4   | `src/memory/shared.ts:37-39` (`project-memory.json`)                   | caller-supplied `project` (raw, never canonical) | ✅ unchanged                     |

Site 1 was **already worktree-scoped by accident**: `findGitRoot` ran
`git rev-parse --show-toplevel`, which answers "the worktree I am standing in".
It now says so explicitly, and additionally gains the non-empty-absolute
guarantee that `?? input.cwd` did not provide.

### Known conflation sites (follow-up needed)

One call site genuinely uses **one** parameter as both a storage key and an
on-disk prefix. Splitting its signature is deferred:

- `mergeSharedObservations` (`src/memory/restore.ts:152-156`) — the same
  `projectPath` feeds `getRecentForProject` (key) and `readSharedMemory`
  (disk). Read-only and currently benign because `project-memory.json` is
  git-tracked and therefore identical in every checkout at the same commit.

`handleCompactionAutocontinue` was the other one; since v1.38.0 it takes
`{ identity, workspace }` and filters with `isInside()`.

### Known limitations of the identity migration

1. **Orphaned pre-migration rows.** Rows written before v1.37.1 were keyed by
   the checkout they were recorded in. ⚠️ _Corrected 2026-09-24:_ the two
   clusters previously reported here as "110 and 81 observations" were
   **sessions**, not observations — under deleted `.sentinal/worktrees/spec-*`
   paths there are 0 observations and ~300 ended sessions, which neither
   conflict detection nor ownership reads. The only stranded **observations**
   found were 97 under one Orca worktree on the maintainer's machine, repaired
   by hand (re-keyed with their vectors; plan
   `docs/plans/2026-09-24-orca-support-followups.md`, Task 1). No shipped
   backfill exists. List candidates with:

   ```bash
   # DB lives at $SENTINAL_HOME/memory.db, defaulting to ~/.sentinal/memory.db
   # (see src/memory/db-path.ts:34-52)
   sqlite3 "${SENTINAL_HOME:-$HOME/.sentinal}/memory.db" \
     "SELECT project_path, COUNT(*) FROM observations
       GROUP BY project_path ORDER BY 2 DESC;"
   ```

   Re-keying observations by hand must also update the vec0 auxiliary column
   `observation_vectors.project` (sqlite-vec supports `UPDATE` of an auxiliary
   column in place; `changes()` is unreliable on vec0 — verify with counts).
   Vectors are several chunk rows per observation, linked by the auxiliary
   `observation_id`, **not** by rowid. `/usr/bin/sqlite3` cannot load vec0; use
   Homebrew SQLite with `.load node_modules/sqlite-vec-darwin-arm64/vec0`.

2. **`specs.id` is not project-qualified.** The spec row id is the bare plan
   filename (`slugFromFilename`, `src/spec/parser.ts:74`), so two **different**
   projects that both contain e.g. `docs/plans/2026-01-01-add-auth.md` collide
   on a single row. A composite `(project_path, id)` key is deferred because
   five foreign keys reference `specs(id)` — `src/memory/migrations.ts:217`,
   `:268`, `:289`, `:305`, `:363`.

### Worktree slot pool is keyed on the canonical project

Since the orca-support follow-ups, `worktree_create` bases new worktrees off the
**main checkout** (`<main>/.sentinal/worktrees/spec-…`) from any checkout, and
every reader and writer of the slot pool uses the canonical project:

- `resolveSlotScope(projectPath)` (`src/worktree/slots.ts`) runs **one**
  `git worktree list` **before** the allocator's `BEGIN IMMEDIATE`. ⛔ Never
  spawn git inside that transaction — it also runs on the read-only
  `worktree_detect` path and would block every other writer, hooks included.
- Live rows of the same repo stored under another key are re-keyed lazily,
  inside the transaction, by `store.unifyLiveKeys`. **Losers of a slot
  collision are set to `slot = NULL` before any re-key** — re-keying first
  raises `idx_wt_slot_live`, which `isSlotRace` misreads as a transient race and
  retries forever.
- A revealed collision keeps the slot on the oldest row; the loser is re-slotted
  after commit through the existing `tryAssignFreeSlot` + `worktree.env` path,
  with the `warnIfSlotMismatch` warning. Its seeded `.env` still holds the old
  slot's values until the user re-seeds it. This transient NULL is the one
  documented exception to "nothing in production writes slot = NULL".
- Squash-merge, abandon and cleanup run in the **main checkout**
  (`inMainCheckout(row)`, `src/worktree/merge-guards.ts`), derived from the
  worktree directory rather than the stored key, so legacy rows work too. H3
  refuses a dirty main checkout and restores its original branch; a `base`
  checked out in another linked worktree is refused up front with
  `BASE_CHECKED_OUT`.
- Cleanup guard 2 accepts `<any checkout of the repo>/<config.directory>`, so
  worktrees nested by earlier versions are reclaimable; guard 1 (branch prefix
  `sentinal/spec-`) still refuses foreign worktrees such as Orca's.
- Writing the worktree directory under the identity root is a deliberate
  exception to "identity → storage keys only".

## ⛔ Claude Code hook payloads — verified facts

- **Bash `tool_response` is `{stdout, stderr, interrupted, isImage, …}`. There
  is no `output` field.** Read it through `bashOutputOf(input)`
  (`src/utils/hook-output.ts`), never `tool_response.output`. Until the
  orca-support follow-ups, three hooks read `output`, so on Claude Code the TDD
  tracker had never auto-confirmed RED or GREEN and error→fix capture had never
  seen a failed command.
- **`PostToolUse` fires only on success.** A non-zero Bash exit fires
  **`PostToolUseFailure`** with `error` (`"Exit code N\n…"`, may be
  middle-truncated or a bare message), `is_interrupt?`, `tool_use_id`,
  `duration_ms?`. It does not fire for validation rejections or permission
  denials. Sentinal registers `tdd-tracker` and `tool-failure-observer` on it.
- Test-outcome indicators must require a **non-zero** count: every passing bun
  run prints ` 0 fail`. `/\d+\s+fail/` read every passing run as a failure, so
  GREEN never fired on either target.
- A `PostToolUseFailure` capture must redact **before** classifying: the
  classifier truncates titles, and a truncated secret can slip under the
  redactor's minimum token length.

## OpenCode tool failures — verified on 1.18.32

Non-zero bash exits arrive in `tool.execute.after` with `metadata.exit` and
finish `completed`. Tools that **throw** (edit mismatch, missing file, schema
error, permission rejection, a plugin's own `tool.execute.before` throw) skip
`tool.execute.after` entirely and surface only on the `event` hook as
`message.part.updated` with `part.type === "tool"` and
`part.state.status === "error"`. The real `properties` is
`{sessionID, part, time}`, not the SDK 1.4.7 typing. De-duplicate on `part.id`,
never `callID` (provider-issued; it repeats across parts).

## Release build

`.releaserc.json` runs `@semantic-release/exec` (`release-build.mjs`) **before**
`@semantic-release/npm` bumps `package.json`. Anything that reads the version
from `package.json` during prepare gets the **previous** release's version —
which is how every OpenCode plugin from `b0a907c` (2026-03-10) to v1.38.0
shipped reporting the prior version. Build with an explicit version
(`scripts/build-opencode.mjs <version>`); `release-build.mjs` fails the release
unless both `targets/opencode/dist/sentinal.mjs` and `src/cli/embedded-assets.ts`
bake it. The npm tarball is unaffected (`prepack` runs after the bump).
