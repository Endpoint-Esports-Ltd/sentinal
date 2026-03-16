# Shareable Knowledge Implementation Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Enable project-specific observations (decisions, patterns, conventions) to be shared across team members via a committable `.sentinal/project-memory.json` file. Observations are loaded alongside SQLite data during memory restore and can be saved directly with a `shared` flag or promoted from existing observations via a `memory_share` MCP tool.

**Architecture:** Three layers: (1) A `SharedMemory` module that reads/writes `.sentinal/project-memory.json` as formatted, human-editable JSON. (2) Integration into `restoreContext()` to merge shared observations with SQLite observations. (3) A `memory_share` MCP tool to promote existing observations to shared, and a `shared` parameter on `memory_save` to save directly to shared memory.

**Tech Stack:** JSON file I/O, existing MemoryService, MCP SDK, Zod

## Scope

### In Scope
- `.sentinal/project-memory.json` file format (human-editable JSON array of observations)
- `.sentinal/.gitignore` that ignores everything EXCEPT `project-memory.json`
- Loading shared observations during `restoreContext()` (merged with SQLite)
- `memory_share` MCP tool to promote existing observations by ID to shared memory
- `shared: true` parameter on `memory_save` to save directly to shared file
- Deduplication: shared observations are tagged to avoid double-counting during restore

### Out of Scope
- Conflict resolution when multiple team members edit the shared file simultaneously (handled by git merge)
- Automatic promotion of observations (manual curation only)
- Syncing shared observations back to SQLite (they stay in the JSON file)
- Schema migration for the shared memory file (V1 format only)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Memory restore: `src/memory/restore.ts:62-134` — `restoreContext()` fetches observations, categorizes by type, formats as markdown
  - Memory MCP tools: `src/memory/mcp-tools.ts:184-234` — `memory_save` handler with sidecar-first pattern
  - File I/O: `src/hooks/pre-compact.ts:48-56` — writes `.sentinal/compact-state.json` (similar pattern)

- **Conventions:**
  - `.sentinal/` is gitignored in projects (`.gitignore` entry: `.sentinal/`). The nested `.sentinal/.gitignore` must re-include `project-memory.json`.
  - Observations have types: `decision`, `discovery`, `error`, `fix`, `pattern`
  - MCP tools return `{ content: [{ type: "text", text: "..." }] }`
  - The restore pipeline doesn't distinguish observation origin — it categorizes by type

- **Key files:**
  - `src/memory/restore.ts` (359 lines) — `restoreContext()` with sync/async paths
  - `src/memory/mcp-tools.ts` (361 lines) — `memory_save`, `memory_search`, etc.
  - `src/memory/types.ts` (255 lines) — `Observation`, `CreateObservation` types
  - `src/memory/service.ts` (271 lines) — `addObservation()`, `getRecentForProject()`
  - `src/hooks/pre-compact.ts` (58 lines) — writes to `.sentinal/`

- **Gotchas:**
  - `mcp-tools.ts` is at 361 lines — adding `memory_share` tool and `shared` parameter to `memory_save` must stay under 400 lines. Extract shared memory logic into a separate module.
  - `restore.ts` is at 359 lines — merging shared observations must add minimal lines. Ideally load shared observations in the fetch phase (before categorization) and concat with SQLite observations.
  - The `.sentinal/` gitignore entry exists in most projects' `.gitignore`. The nested `.sentinal/.gitignore` must use `!project-memory.json` to re-include it.
  - Shared observations don't have auto-increment IDs from SQLite. Use negative IDs or string IDs to distinguish them during restore.

- **Domain context:**
  - Shared memory is for curated, stable knowledge: architectural decisions, naming conventions, gotchas. Not for transient observations like errors/fixes.
  - The file must be human-editable because team members may want to add/edit entries directly, not just through MCP tools.
  - Typical shared memory file: 5-50 entries. Not expected to grow large.

## Assumptions

- `.sentinal/` directory exists in projects where Sentinal is used — supported by: the memory.db and compact-state.json are already written there — Tasks 1, 3 depend on this
- Git nested `.gitignore` with `!filename` pattern works to re-include a file in a gitignored directory — supported by: standard git behavior documented in gitignore(5) — Task 1 depends on this
- Shared observations merged into restore won't cause confusing duplicates — supported by: we tag shared observations with `metadata.source: "shared"` and dedup by title — Task 2 depends on this
- The shared memory file will be small enough to read synchronously without performance impact — supported by: 5-50 entries * ~200 bytes each = ~10KB max — Task 2 depends on this

## Testing Strategy

- **Unit tests:** `src/memory/shared.test.ts` — test read/write of shared memory file
- **Unit tests:** `src/memory/restore.test.ts` — test merged restore with shared observations
- **Unit tests:** `src/memory/mcp-tools.test.ts` — test memory_share tool and shared parameter
- **Existing tests:** Full suite must pass after all changes

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Git merge conflicts in project-memory.json | Medium | Low | Human-editable JSON format makes manual conflict resolution easy. Each entry is self-contained. |
| Shared observations are stale/irrelevant | Low | Low | Manual curation only — team reviews what gets shared. memory_share requires explicit action. |
| Nested .gitignore doesn't work in all git versions | Very Low | Medium | Document in README. Fallback: place file outside .sentinal/ if needed. |
| restore.ts exceeds 400-line limit | Medium | Medium | Shared observation loading is a simple file read + concat. Minimal line addition. |

## Pre-Mortem

*Assume this plan failed. Most likely internal reasons:*

1. **Shared observations pollute the restore context with irrelevant entries** (Task 2) — Trigger: the restore markdown becomes too long because shared observations are always included regardless of relevance. Mitigation: shared observations are limited to decisions and patterns (most stable types). Limit to 5 shared entries in restore.

2. **Team members manually edit project-memory.json and break the format** (Task 1) — Trigger: JSON parse error on restore because someone added invalid JSON. Mitigation: wrap the read in try/catch with a clear error message. Never crash on shared memory parse failure — log warning and continue with SQLite-only restore.

3. **memory_share promotes transient observations that shouldn't be shared** (Task 3) — Trigger: errors and fixes end up in shared memory, cluttering the team's knowledge base. Mitigation: memory_share only allows promoting `decision`, `discovery`, and `pattern` types. Errors and fixes are rejected.

## Goal Verification

### Truths
1. `.sentinal/project-memory.json` exists as a human-editable JSON file
2. `.sentinal/.gitignore` re-includes `project-memory.json` so it can be committed
3. Shared observations are loaded during `restoreContext()` and appear in the restore markdown
4. `memory_share` MCP tool promotes existing observations to shared memory by ID
5. `memory_save` with `shared: true` writes directly to the shared memory file
6. Shared memory parse failures don't crash restore — fallback to SQLite-only

### Artifacts
- `src/memory/shared.ts` (new) — read/write shared memory file
- `src/memory/shared.test.ts` (new) — tests
- `src/memory/restore.ts` (modified) — merge shared observations
- `src/memory/mcp-tools.ts` (modified) — memory_share tool + shared parameter on memory_save

### Key Links
- `restoreContext()` ← loads shared observations via `readSharedMemory()` ← merges with SQLite observations
- `memory_share` MCP tool ← reads observation from SQLite ← writes to shared memory file
- `memory_save` with `shared: true` ← writes directly to shared memory file

## Progress Tracking

- [x] Task 1: Create shared memory file module
- [x] Task 2: Integrate shared observations into restoreContext()
- [x] Task 3: Add memory_share tool and shared parameter to memory_save

**Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Implementation Tasks

### Task 1: Create shared memory file module

**Objective:** Build the core module for reading and writing `.sentinal/project-memory.json`. The file contains a JSON array of shared observations in a human-readable format.

**Dependencies:** None

**Files:**
- Create: `src/memory/shared.ts`
- Create: `src/memory/shared.test.ts`

**Key Decisions / Notes:**
- **File format:** Human-editable JSON with this structure:
  ```json
  {
    "version": 1,
    "observations": [
      {
        "type": "decision",
        "title": "Use SQLite for persistent memory",
        "content": "Chose SQLite over filesystem for ACID guarantees and FTS5 support.",
        "tags": ["architecture", "database"],
        "filePaths": ["src/memory/store.ts"],
        "createdAt": "2026-03-15",
        "author": "evan"
      }
    ]
  }
  ```
- **`SharedObservation` type:** Similar to `Observation` but with string `createdAt` (date only, human-friendly) and `author` field. No `id`, `sessionId`, `projectPath`, `timestamp`, `metadata`, `qualityScore` (these are SQLite-specific).
- **Functions:**
  - `readSharedMemory(projectPath: string): SharedObservation[]` — reads the file, returns empty array on parse error or missing file. Never throws.
  - `writeSharedMemory(projectPath: string, observations: SharedObservation[]): void` — writes formatted JSON (2-space indent). Creates `.sentinal/` directory if needed.
  - `addSharedObservation(projectPath: string, obs: SharedObservation): void` — reads, appends, writes. Deduplicates by title.
  - `sharedMemoryPath(projectPath: string): string` — returns the full path to the file.
- **Conversion:** `toObservation(shared: SharedObservation, projectPath: string): Observation` — converts a SharedObservation to a full Observation for use in restore. Generates synthetic `id` (negative, starting from -1), `sessionId: "shared"`, `timestamp` from `createdAt`, `metadata: { source: "shared" }`, `qualityScore: 1.0` (shared observations don't decay).

**Definition of Done:**
- [ ] `readSharedMemory()` reads and parses the JSON file
- [ ] `readSharedMemory()` returns empty array on missing file or parse error
- [ ] `writeSharedMemory()` writes formatted JSON
- [ ] `addSharedObservation()` appends and deduplicates by title
- [ ] `toObservation()` converts SharedObservation to full Observation
- [ ] Tests verify read, write, dedup, parse error handling

**Verify:**
- `bun test src/memory/shared.test.ts`

---

### Task 2: Integrate shared observations into restoreContext()

**Objective:** Load shared observations during `restoreContext()` and merge them with SQLite observations so they appear in the restore markdown.

**Dependencies:** Task 1

**Files:**
- Modify: `src/memory/restore.ts`
- Modify: `src/memory/restore.test.ts`

**Key Decisions / Notes:**
- **Merge point:** In both `restoreContextSync()` and `restoreContextAsync()`, after fetching SQLite observations, also call `readSharedMemory(projectPath)` and convert via `toObservation()`. Concat shared observations with SQLite observations before passing to `buildRestoreMarkdown()`.
- **Deduplication:** Filter out shared observations whose titles already exist in the SQLite results (SQLite is more recent and authoritative).
- **Limit:** Include at most 15 shared observations. If more exist, show a note like "Showing 15 of N shared observations" in the restore markdown.
- **Line count:** `restore.ts` is at 359 lines. Adding ~10 lines for the merge (import + read + convert + concat + dedup) keeps it well under 400.
- **No changes to `buildRestoreMarkdown()`** — it already categorizes by type and formats. Shared observations will naturally appear in the correct sections (decisions, patterns, etc.).

**Definition of Done:**
- [ ] Shared observations appear in the restore markdown
- [ ] Shared observations are deduplicated against SQLite observations
- [ ] Maximum 15 shared observations included (with truncation note if more exist)
- [ ] Restore works normally when no shared memory file exists
- [ ] Tests verify shared observations appear in restore output

**Verify:**
- `bun test src/memory/restore.test.ts`

---

### Task 3: Add memory_share tool and shared parameter to memory_save

**Objective:** Register a `memory_share` MCP tool that promotes existing observations to shared memory, and add a `shared` parameter to `memory_save` for direct shared saves.

**Dependencies:** Task 1

**Files:**
- Modify: `src/memory/mcp-tools.ts`

**Key Decisions / Notes:**
- **`memory_share` tool:**
  - Parameters: `ids` (number array, required), `project` (string, required)
  - Reads observations from SQLite by ID
  - Only allows promoting `decision`, `discovery`, and `pattern` types (rejects `error` and `fix`)
  - Converts to `SharedObservation` format
  - Calls `addSharedObservation()` for each
  - Returns confirmation with count
- **`memory_save` `shared` parameter:**
  - Add `shared: z.boolean().optional()` to the existing `memory_save` schema
  - When `shared: true`, in addition to saving to SQLite (existing behavior), also call `addSharedObservation()` with the observation data
  - Only allow shared for `decision`, `discovery`, `pattern` types
- **Line count:** `mcp-tools.ts` is at 361 lines. Adding the memory_share tool (~40 lines) and shared param (~10 lines) pushes to ~411. To stay under 400, extract the `memory_share` registration into a helper or use a very compact implementation.
  - Better approach: extract both `memory_share` tool registration AND the shared-save helper into `shared.ts` as `registerSharedTools(server, deps)` and `saveToSharedIfRequested(project, type, title, content, tags, filePaths, shared)`. This keeps mcp-tools.ts growth to ~5 lines (import + register call + 1-line helper call in memory_save handler).
- **Author field:** When promoting or saving shared, auto-detect via `git config user.name` (async). Fall back to `"unknown"` if git unavailable. Make `author` optional in SharedObservation schema.

**Files:**
- Modify: `src/memory/mcp-tools.ts` (import + register call + shared param on memory_save)
- Modify: `src/memory/shared.ts` (add registerSharedTools + saveToSharedIfRequested)
- Create: `src/memory/shared-tools.test.ts` (test memory_share tool and shared save)

**Definition of Done:**
- [ ] `memory_share` tool registered on MCP server
- [ ] Only allows promoting `decision`, `discovery`, `pattern` types
- [ ] Promoted observations appear in `.sentinal/project-memory.json`
- [ ] `memory_save` with `shared: true` writes to both SQLite and shared file
- [ ] Rejects shared save for `error` and `fix` types
- [ ] Tests verify share tool and shared save parameter

**Verify:**
- `bun test src/memory/`

---

### Task 4: Create .sentinal/.gitignore for project-memory.json

**Objective:** Ensure `.sentinal/project-memory.json` can be committed to git despite `.sentinal/` being in the project's `.gitignore`.

**Dependencies:** None

**Files:**
- Modify: `src/memory/shared.ts` (create .gitignore alongside project-memory.json)

**Key Decisions / Notes:**
- **Approach:** When `writeSharedMemory()` creates the `.sentinal/` directory (or writes the file for the first time), also create `.sentinal/.gitignore` with these contents:
  ```
  # Ignore everything in .sentinal/ except shared project memory
  *
  !.gitignore
  !project-memory.json
  ```
  This ignores all files in `.sentinal/` (memory.db, compact-state.json, etc.) but re-includes the gitignore itself and the shared memory file.
- **Idempotent:** Only write `.gitignore` if it doesn't already exist (don't overwrite custom entries).
- **Integration with install:** The `sentinal install` command could also create this `.gitignore` — but that's out of scope for this task. The write path handles it.

**Definition of Done:**
- [ ] `.sentinal/.gitignore` is created when shared memory is first written
- [ ] Gitignore contains `*`, `!.gitignore`, `!project-memory.json`
- [ ] Only created if it doesn't already exist
- [ ] Tests verify gitignore creation

**Verify:**
- `bun test src/memory/shared.test.ts`
