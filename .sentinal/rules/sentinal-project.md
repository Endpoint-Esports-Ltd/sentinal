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

Two call sites genuinely use **one** parameter as both a storage key and an
on-disk prefix. Splitting their signatures is deferred:

- `handleCompactionAutocontinue` (`src/opencode/compaction-autocontinue.ts:27`)
  — key for `getCurrentSpec`, prefix for `cycle.filePath.startsWith`.
- `mergeSharedObservations` (`src/memory/restore.ts:152-156`) — the same
  `projectPath` feeds `getRecentForProject` (key) and `readSharedMemory`
  (disk). Read-only and currently benign because `project-memory.json` is
  git-tracked and therefore identical in every checkout at the same commit.

### Known limitations of the identity migration

1. **Orphaned pre-migration memory rows.** Observations written before this
   change were keyed by the worktree path they were recorded in, and some of
   those worktrees no longer exist (two known clusters of 110 and 81 rows).
   They are NOT reachable from the canonical key — the only way to read them is
   to pass that literal old path to `memory_search`. No backfill is performed.
   List the orphans with:

   ```bash
   # DB lives at $SENTINAL_HOME/memory.db, defaulting to ~/.sentinal/memory.db
   # (see src/memory/db-path.ts:34-52)
   sqlite3 "${SENTINAL_HOME:-$HOME/.sentinal}/memory.db" \
     "SELECT project_path, COUNT(*) FROM observations
       GROUP BY project_path ORDER BY 2 DESC;"
   ```

   Any `project_path` in that output that no longer exists on disk is orphaned.

2. **`specs.id` is not project-qualified.** The spec row id is the bare plan
   filename (`slugFromFilename`, `src/spec/parser.ts:74`), so two **different**
   projects that both contain e.g. `docs/plans/2026-01-01-add-auth.md` collide
   on a single row. A composite `(project_path, id)` key is deferred because
   five foreign keys reference `specs(id)` — `src/memory/migrations.ts:217`,
   `:268`, `:289`, `:305`, `:363`.

3. **`worktree_create` still bases off the invoking checkout.** Un-nesting was
   dropped from the plan, so creating a worktree from inside a worktree nests
   it. ⛔ **Do not "fix" this by re-keying `worktrees.project_path` to the
   canonical identity for new rows only.** The slot allocator reads live rows
   with `WHERE project_path = ?` (`src/worktree/store.ts:95`, `:156`, `:186`);
   if new rows carry the canonical key while live rows still carry old
   per-worktree values, the live rows become invisible to the allocator and the
   **same slot is handed out twice**. The `idx_wt_slot_live UNIQUE(project_path,
slot)` index cannot catch it, because the two rows differ in `project_path`.
   Any re-keying must migrate every existing row in the same transaction.
