# Session Management Completion Implementation Plan

Created: 2026-03-09
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Goal

Complete the remaining session management features from parent plan Task 4: add `transcript_path` to sessions table, add query methods to `MemoryStore`, create `sentinal sessions` and `sentinal check-context` CLI commands, and implement stale session cleanup.

## Scope

### In Scope
- Schema migration v4 adding `transcript_path` column to sessions table
- `getActiveSessions()`, `listSessions()`, `cleanupStaleSessions()` methods on `MemoryStore`
- `sentinal sessions list` CLI command with `--active`, `--project`, `--json` flags
- `sentinal sessions cleanup` CLI subcommand with `--threshold` and `--json` flags
- `sentinal check-context <path>` CLI command with `--session <id>` and `--json` flags
- Hook updates to pass `transcript_path` when available
- Full test coverage for all new methods and migrations

### Out of Scope
- Standalone `src/sessions/manager.ts` module (CRUD stays on MemoryStore — consistent pattern)
- Explicit `status` column (redundant — `end_time IS NULL` is canonical active check)
- Dashboard integration (depends on Tasks 8-9)
- Session notification on end (depends on Task 8)

## Context for Implementer

**Architecture decision:** Session CRUD stays on `MemoryStore` — consistent with `getSetting()`, `insertSession()`, `SpecStore` patterns. No separate `SessionManager` class.

**File size concern:** `store.ts` is currently 555 lines. New methods add ~30 lines → ~585 total. Under the 600-line Sentinal quality limit but close. If future features need more session logic, extract to a separate module then.

**`transcript_path` is nullable:** Not all sessions have transcripts. OpenCode doesn't provide one in the same way as Claude Code. `ALTER TABLE ADD COLUMN` defaults to NULL for existing rows. The `check-context --session` flag degrades gracefully when transcript_path is null.

**Existing patterns to follow:**
- `src/cli/commands/config.ts` — CLI command with subcommands, `--json` flag
- `src/cli/commands/spec.ts` — Another subcommand group example
- `src/sessions/context.ts` — `estimateContextUsage()` function used by `check-context`
- `src/memory/store.ts:migrateV3()` — Migration pattern

## Progress Tracking

- [x] Task 1: Schema migration v4 — add `transcript_path` column
- [x] Task 2: Session query methods on MemoryStore
- [x] Task 3: `sentinal sessions` CLI command
- [x] Task 4: `sentinal check-context` CLI command
- [x] Task 5: Test verification + parent plan update

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: Schema Migration v4 — Add `transcript_path` Column

**Objective:** Add `transcript_path` column to sessions table via v4 migration. Update types, serialization, and callers.

**Files:**
- Modify: `src/memory/types.ts` — Bump `SCHEMA_VERSION` to 4, add `transcriptPath` to `SessionSchema`
- Modify: `src/memory/store.ts` — Add `migrateV4()`, update `insertSession()`, `deserializeSession()`, `RawSession`
- Modify: `src/memory/store.test.ts` — Add migration test, update session insert tests
- Modify: `src/hooks/session-start.ts` — Pass `transcript_path` from hook input
- Modify: `targets/opencode/plugins/sentinal.ts` — Pass `null` for `transcriptPath`

**Definition of Done:**
- [x] `migrateV4()` adds `transcript_path TEXT` column to sessions table (idempotent via PRAGMA table_info check)
- [x] Existing v1-v3 databases migrate cleanly to v4
- [x] `SessionSchema` includes `transcriptPath: z.string().nullable()`
- [x] `insertSession()` accepts and stores `transcriptPath`
- [x] `session-start.ts` passes `input.transcript_path` (or null) to store
- [x] OpenCode plugin passes `null` for `transcriptPath`
- [x] Tests cover: migration, insert with transcript_path, insert without (null)

---

### Task 2: Session Query Methods on MemoryStore

**Objective:** Add `getActiveSessions()`, `listSessions()`, and `cleanupStaleSessions()` to MemoryStore.

**Files:**
- Modify: `src/memory/store.ts` — Add 3 new methods
- Modify: `src/memory/store.test.ts` — Add tests for each method

**Definition of Done:**
- [x] `getActiveSessions()` returns sessions where `end_time IS NULL`, ordered by `start_time DESC`
- [x] `listSessions(opts?)` supports filters: `project`, `assistant`, `active` (boolean), `limit` (default 50), `offset`
- [x] `cleanupStaleSessions(thresholdMs?)` ends sessions older than threshold (default 24h), returns count
- [x] Tests: list all, filter active only, filter by project, filter by assistant, cleanup stale, custom threshold
- [x] `store.ts` stays under 600 lines (597 lines)

---

### Task 3: `sentinal sessions` CLI Command

**Objective:** Create `sentinal sessions list` and `sentinal sessions cleanup` subcommands.

**Files:**
- Create: `src/cli/commands/sessions.ts` — `registerSessionsCommand(program)`
- Modify: `src/cli/index.ts` — Import and register command

**Definition of Done:**
- [x] `sentinal sessions list` shows table of sessions (ID, project, assistant, started, duration, status)
- [x] `sentinal sessions list --active` shows only active sessions
- [x] `sentinal sessions list --project <path>` filters by project
- [x] `sentinal sessions list --json` outputs JSON array
- [x] `sentinal sessions cleanup` runs stale cleanup, reports count ended
- [x] `sentinal sessions cleanup --threshold <hours>` uses custom threshold (default 24)
- [x] `sentinal sessions cleanup --json` outputs JSON result

---

### Task 4: `sentinal check-context` CLI Command

**Objective:** Create `sentinal check-context` command that estimates context window usage.

**Files:**
- Create: `src/cli/commands/check-context.ts` — `registerCheckContextCommand(program)`
- Modify: `src/cli/index.ts` — Import and register command

**Definition of Done:**
- [x] `sentinal check-context <transcript-path>` estimates context from file size
- [x] `sentinal check-context --session <id>` looks up transcript_path from session record
- [x] `--json` outputs `{"percent": N, "tokens": N, "fileBytes": N}`
- [x] Without `--json`, outputs human-readable: `Context: 72% (~144,000 tokens)`
- [x] Graceful error when session has no transcript_path
- [x] Graceful error when file doesn't exist

---

### Task 5: Test Verification + Parent Plan Update

**Objective:** Run full test suite and update parent plan Task 4 completion status.

**Files:**
- Modify: `docs/plans/2026-03-09-market research-parity.md` — Update Task 4 DoD and progress
- Modify: `src/index.ts` — Add any missing exports if needed

**Definition of Done:**
- [x] `bun test` passes (344 tests, up from 339)
- [x] Parent plan Task 4 DoD items updated
- [x] No regressions

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `store.ts` exceeding 600-line limit | Low | Medium | New methods add ~30 lines → ~585. Monitor and extract if needed. |
| `ALTER TABLE ADD COLUMN` on existing DBs | Low | Low | SQLite supports natively. Default NULL. Tested in migration. |
| `transcript_path` unavailable in OpenCode | Low | Low | Field nullable. CLI `--session` degrades with clear error. |

## Goal Verification

```bash
bun test
sentinal sessions list --json
sentinal sessions list --active --json
sentinal sessions cleanup --json
sentinal check-context /path/to/transcript --json
```
