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
- **Lint/format:** `eslint` 10.11.0 + `typescript-eslint` 8.70.1 + `prettier` 3.9.9, pinned
  devDependencies; flat config `eslint.config.mjs`, `.prettierignore` (CHANGELOG, `docs/**`,
  `.sentinal/*.json`, generated/dist paths). **No CI gate** — run `bunx eslint <paths>` /
  `bunx prettier --write <file>` on files you touch, never a repo-wide `--write`. `typescript` is
  pinned `^5.7.0` (`bun add` would pick 7).

## Directory Structure

```
src/                       # Shared TypeScript (consumed by BOTH targets)
├── analysis/              # check_diagnostics, impact_analysis, quality_report MCP tools
├── checkers/              # angular, nestjs, detect — framework validation (tsc/eslint/prettier are on-demand via quality_report)
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

| #   | Site                                                                      | Root it uses                                     | Verdict                          |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| 1   | `src/hooks/post-compact-restore.ts:33` (`compact-state.json`)             | `resolveWorkspaceRoot(input.cwd)`                | ✅ (changed — was `findGitRoot`) |
| 2   | `src/runtime/pidfile.ts:105-107` (`runtime.pid`)                          | explicit `worktreePath` param                    | ✅ unchanged                     |
| 3   | `src/worktree/slot-env.ts:27` → `worktree-config.ts:356` (`worktree.env`) | explicit `worktreePath` param                    | ✅ unchanged                     |
| 4   | `src/memory/shared.ts:37-39` (`project-memory.json`)                      | caller-supplied `project` (raw, never canonical) | ✅ unchanged                     |

Site 1 was **already worktree-scoped by accident**: `findGitRoot` ran
`git rev-parse --show-toplevel`, which answers "the worktree I am standing in".
It now says so explicitly, and additionally gains the non-empty-absolute
guarantee that `?? input.cwd` did not provide.

### Canonical keys at the sidecar and `SpecStore` boundary (D3)

**Reads fail open, writes normalize** (D3 of
`docs/plans/2026-09-24-hardening-sweep.md`). The one implementation is
`src/sidecar/project-key.ts` (kept free of `bun:sqlite` — hooks and `SpecStore`
import it):

| Function                      | Line | Semantics                                                                                           |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `canonicalProjectKey(raw)`    | :55  | memoized `resolveProjectIdentity` (10 s TTL, 512 entries); blank returned unchanged, never resolved |
| `normalizeProjectKey(raw)`    | :74  | **WRITE** — blank/absent → `null`, caller must 400 (`MISSING_PROJECT_PATH`)                         |
| `normalizeProjectFilter(raw)` | :84  | **READ** — blank/absent → `undefined` = "all projects"; supplied → canonical                        |
| `inferProjectFromFile(path)`  | :94  | D4 — identity of the nearest existing ancestor of `dirname(path)`; `null` for relative/blank paths  |

⛔ Never resolve a blank value: `resolveProjectIdentity("")` substitutes the
sidecar's own `process.cwd()`, which is meaningless in a detached process.
Do **not** normalize `/project-context` or `/config/compaction` — those take
disk paths.

`SpecStore` canonicalizes at its **single write point** (`syncFromPlanFile`,
`src/spec/store.ts:80`; `syncAllPlans` resolves once per call, not one git spawn
per plan file) **and** on its project-keyed reads (`getCurrentSpec`,
`listSpecs`, slug lookups). Canonical writes with raw reads miss on macOS
(`/var` vs `/private/var`). A raw subdirectory/symlink key was what made the
Stop guard read a live plan as ownerless and block with "orphaned".

**`/tdd-state` `set` without a project infers it (D4)** from the file via
`inferProjectFromFile` and logs "inferred projectPath"; a relative `filePath`
is a 400. ≤1.37.1 plugins and `tdd_set_state` send none. Making an absent
project a hard 400 is deferred to a later release.

### Restore splits key and workspace (D8) — formerly a conflation site

`mergeSharedObservations` (`src/memory/restore.ts:158`) used one `projectPath`
as both the storage key and the `readSharedMemory` disk prefix. It no longer
does: `RestoreOptions.workspacePath?` (`restore.ts:29`, defaults to
`projectPath`, so the public API is unchanged) is the local checkout that
`.sentinal/project-memory.json` is read from (`restore.ts:163`); `projectPath`
is only the key. `GET /context?project=&workspace=` — the sidecar canonicalizes
`project` for the key and takes the workspace from `workspace`, else
`resolveWorkspaceRoot(<raw project>)`, so an old CC hook sending its raw
worktree cwd gets canonical memories **and** that worktree's shared memory.
`SidecarClient.restoreContext(project, semanticQuery?, workspace?)`. Both CC
hooks and the plugin send identity + workspace. Before this, restore from a
linked worktree or subdirectory found **no** memories.

`handleCompactionAutocontinue` was the other conflation site; since v1.38.0 it
takes `{ identity, workspace }` and filters with `isInside()`. No known
conflation site remains.

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

2. ~~`specs.id` is not project-qualified.~~ **Resolved by migration V14 (D6)**
   — see "Project-qualified spec keys" below.

### Project-qualified spec keys (V14, D6)

- **`specs.id` = `<canonicalProject>::<slug>`** (`specKey`,
  `src/memory/spec-key.ts:17`). It is **opaque — never parse it**. The slug
  (bare plan filename, `slugFromFilename`, `src/spec/parser.ts:74`) lives in
  `specs.slug`, the project in `specs.project_path`, and
  `UNIQUE(project_path, slug)` (`idx_specs_project_slug`) makes that pair the
  real identity. Two projects with the same plan filename keep separate rows.
- **Public `Spec.id` stays the slug**, so every caller comparing it with a
  parsed plan (ownership, the plugin's owner check, `spec_metrics` default)
  keeps working. `Spec` also carries `key` (the stored id) and `projectPath`
  (`src/spec/types.ts:74-76`). Internal FK writers (e.g. `tdd-tracker`) use
  `spec.key`.
- **Resolution happens at the store boundary** (`src/memory/spec-key.ts`, in
  `memory/` to avoid a memory → spec import cycle), so an old plugin or agent
  sending a bare slug still writes the key:
  - `resolveSpecKey(db, value, project?)` (:31) — **lookups, strict**: exact
    stored id → that project's row for the slug (never another project's) →
    without a project, the slug only if exactly one project has it → else
    `null`. Never guesses.
  - `resolveSpecKeyForWrite` (:62) — **FK writers** (`store.ts`,
    `store-sessions.ts`, `worktree/store.ts`): the supplied project first, then
    a slug unique across projects (a write often carries a raw or inferred
    project). Ambiguous → refused: the raw value is passed through so the FK
    fails loudly, or `NULL` for notifications.
- `SpecStore.isSlugInProgress` (`src/spec/store.ts:426`) is deliberately
  **project-blind** — worktree cleanup's `isPlanActive` guard. A false positive
  only skips one removal; a false negative deletes work.
- **Runtime heal** (`healSameIdentityRows`, `src/spec/store.ts:243`): when
  `syncFromPlanFile` creates key K and no row K exists, same-slug rows whose
  project resolves to the same identity (linked-worktree keys V14 could not see
  through, or bare ids an old sidecar wrote after V14) are re-keyed onto K.
- An **old bare-id writer after V14 fails loudly** on the unique index rather
  than silently creating a duplicate (`migrations-v14.test.ts:194`).
- **V14** (`src/memory/migrations-v14.ts`): canonicalizes with a git-free
  strip of `/.sentinal/worktrees/spec-*` + `realpathSync`; collisions keep the
  newest `updated_at`, **delete** the loser's `spec_tasks`/`spec_events`
  (re-pointing would violate `UNIQUE(spec_id, position)`) and re-point its
  nullable references; records version 14 only after `foreign_key_check` shows
  no **new** violation against `specs` (pre-existing ones are baselined).
  ⛔ **V14 never throws out of the `MemoryStore` constructor**: a failure rolls
  back, logs, leaves 14 unrecorded and retries next start.
- ⛔ **`PRAGMA defer_foreign_keys` has no effect in autocommit** and resets at
  COMMIT. The five FKs to `specs(id)` have no `ON UPDATE CASCADE`, so every
  re-key goes through `withDeferredFks` (`spec-key.ts:100`), which sets the
  pragma as the **first statement inside** the transaction. `runMigrations`
  itself runs outside any transaction; `foreign_keys = ON` is set on every
  connection (`src/memory/store.ts:47`).
- The five FKs are declared in `src/memory/migrations-legacy.ts`: `spec_tasks`
  :90 (NOT NULL, `ON DELETE CASCADE`), `worktrees` :150, `notifications` :180,
  `tdd_cycles` :201, `spec_events` :217 (NOT NULL).

### Migration runner (D7)

`runMigrations` (`src/memory/migrations.ts:29`) runs **every unrecorded step**
in order — not "everything above `MAX(version)`" — so a step whose guard
declined (and therefore did not record itself) is retried instead of being
skipped forever once a later step records. Steps **below the lowest recorded
version** count as applied (a DB seeded at version N never recorded 1..N-1).
Silent when nothing is pending; backs up first unless the DB is fresh. V11
records only after verifying the column exists. Migrations are split:
`migrations-legacy.ts` (V1–V10), `migrations-v11.ts` … `migrations-v14.ts`,
`migration-helpers.ts`.

### Worktree slot pool is keyed on the canonical project

Since the orca-support follow-ups, `worktree_create` bases new worktrees off the
**main checkout** (`<main>/.sentinal/worktrees/spec-…`) from any checkout, and
every reader and writer of the slot pool uses the canonical project:

- `resolveSlotScope(projectPath)` (`src/worktree/slot-scope.ts:41`; `slots.ts`
  re-exports the split `slot-env` / `slot-scope` / `slot-pool` /
  `slot-messages` modules) runs **one**
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

## Auto-capture, dedupe and notifications (hardening sweep)

- **Error→fix capture (D9).** "Is this output a failure?" is one pure
  classifier, `isErrorOutput(text, exitCode?)` in
  `src/memory/error-classifier.ts:66` (re-exported by `capture.ts`). Failure
  counts must be **non-zero** (`/\bfail\b/` matched every passing ` 0 fail`); a
  known exit code overrides the text heuristics. An error is **consumed** by the
  fix it produces (`consumedBy` marker on the buffered event, per rule —
  persisted in CC's `<cwd>/.sentinal/event-buffer.json`, in memory in the
  plugin); the current event is excluded from the look-back; edits to
  `.md`/`.mdx`/`.markdown` or `docs/` never count as fixes
  (`DOC_PATH_PATTERNS`, `capture.ts:101`). Before this, 52% of one user's
  memories were false "Fixed issue in X" rows.
- **Server-side dedupe (D10).** `src/memory/dedupe-signature.ts` (pure) signs an
  observation when `metadata.source` is `auto-capture` / `auto-capture-failure`
  or `metadata.dedupeKey` is set: `sha1(type | normalizeVolatile(title) |
normalized content or "key:"+dedupeKey)`. The normalizer strips durations,
  counts, hashes, version banners, temp paths, timestamps and a truncated
  section's partial last line. `MemoryService.addObservationDeduped`
  (`src/memory/service.ts:141`) collapses repeats within 30 min (auto-captured
  `fix` rows also by same project + title within 5 min) into `occurrences` /
  `lastSeen`, with no re-embed. `POST /observation` always takes the deduped
  path, as does the CC direct fallback; manual observations are never signed.
  `instructions-loaded` sends `dedupeKey: file_path`.
- **Notifications carry a project (D5).** `POST /notification` takes an
  optional `projectPath` (absent → `NULL`/global, blank → 400, else canonical).
  Warning producers set project + `source`: `spec_notify` (`spec-notify`),
  `stop-failure`, `config-change` (only for files inside the workspace).
  Info producers stay `NULL`. A `NULL`-project notification surfaces in the
  session-start digest only if its source is in `GLOBAL_NOTIFICATION_SOURCES`
  (`src/hooks/session-notifications.ts:30` — retire skew + `vector-init`).

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
