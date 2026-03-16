# Smart Memory Implementation Plan

Created: 2026-03-15
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Make memory restoration context-aware by using semantic search instead of pure recency, capture failed approaches as negative observations, and add quality decay scoring to keep the memory store relevant over time.

**Architecture:** Three independent improvements: (1) Enhance `restoreContext()` to build a semantic query from the active spec task description + recently edited files and use the existing hybrid search (vector + FTS) instead of chronological fetch. (2) Add a new `detectFailedApproach()` heuristic to `capture.ts` that detects repeated errors on the same file and git restore/checkout patterns. (3) Add a `quality_score` column to observations (V8 migration), initial score from capture confidence, time-based decay in maintenance, and a `memory_maintain` MCP tool for manual pruning.

**Tech Stack:** sqlite-vec (existing), @xenova/transformers (existing), SQLite migrations, FTS5

## Scope

### In Scope

- Semantic query construction from spec task + recent files + project name
- Hybrid search integration in `restoreContext()` with graceful fallback to recency
- Accept `semanticQuery` in the sidecar `/context` endpoint
- Failed approach detection heuristic (repeated errors + git restore)
- `quality_score` column via V8 migration
- Time-based quality decay in maintenance
- `memory_maintain` MCP tool for pruning low-quality observations
- Restore prioritizes high-quality observations via score weighting

### Out of Scope

- Changing the embedding model (keep MiniLM-L6-v2)
- Automatic background decay (use manual `memory_maintain` tool)
- Real-time quality boost on observation access (future enhancement)
- Changing the progressive disclosure MCP pattern (search → timeline → get)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Restore function: `src/memory/restore.ts:54-219` — `restoreContext()` takes `RestoreOptions`, returns `RestoredContext` with markdown
  - Search orchestrator: `src/memory/search/orchestrator.ts:81-102` — selects hybrid/FTS/filter strategy based on query and vector availability
  - Heuristic pattern: `src/memory/capture.ts:192-286` — each heuristic is a function returning `CaptureDecision | null`, checked in priority order
  - Migration pattern: `src/memory/migrations.ts` — sequential V1-V7 functions, `runMigrations()` at top
  - MCP tool pattern: `src/memory/mcp-tools.ts:55-90` — Zod schema + handler with sidecar/direct routing

- **Conventions:**
  - Observations table: `observations` in SQLite with FTS5 index `observations_fts` and optional vec0 index `observation_vectors`
  - Quality/metadata stored in JSON `metadata` column — but for filtering, proper columns with indexes are preferred
  - `store.ts` is at 663 lines (OVER 600-line limit) — new methods MUST go in separate files or existing helper modules
  - `capture.ts` is at 424 lines (over 400-line warn) — extract new heuristic into a helper if it pushes past 450
  - Vector search is optional — always check `vectorStore.isAvailable()` before using

- **Key files:**
  - `src/memory/restore.ts` (238 lines) — Current restore: chronological fetch, no semantic search. `currentFiles` param exists but is never passed by callers.
  - `src/memory/vector-store.ts` (290 lines) — sqlite-vec wrapper. `search()` does KNN with post-filtering. `indexObservation()` creates per-field vectors.
  - `src/memory/embeddings.ts` (150 lines) — Xenova/all-MiniLM-L6-v2, 384 dimensions, ~50-200ms per embedding
  - `src/memory/search/orchestrator.ts` (123 lines) — Strategy selector: hybrid when vector available, FTS fallback
  - `src/memory/capture.ts` (424 lines) — 5 heuristics, EventBuffer, `analyzeEvent()`. Near line limit.
  - `src/memory/store.ts` (663 lines) — OVER LIMIT. SQLite operations. Do NOT add methods here.
  - `src/memory/service.ts` (271 lines) — Higher-level memory operations, `addObservation()`, `search()`
  - `src/memory/maintenance.ts` (136 lines) — `rebuildFtsIndex()`, `rebuildVectorIndex()`, `checkIntegrity()`
  - `src/memory/migrations.ts` (290 lines) — V1-V7 migrations. Add V8 here.
  - `src/memory/mcp-tools.ts` (276 lines) — 5 MCP tools (search, timeline, get, save, stats)

- **Gotchas:**
  - Vector store requires `sqlite-vec` + Homebrew SQLite on macOS. Always check `isAvailable()`.
  - `store.ts` is over the 600-line hard limit. Any new store methods MUST use a new file or the service layer.
  - Embeddings are ~50-200ms per text. Restore must not block on slow embedding — have a timeout or use cached embeddings.
  - The `currentFiles` parameter in `restoreContext()` exists but no caller passes it — wire it through the sidecar route and hook callers.
  - The OpenCode plugin gets memory during compaction (via `output.context.push()`), not at session start. The sidecar `/context` endpoint needs the semantic query parameter added.

- **Domain context:**
  - Memory restore runs at session start (Claude Code) and during compaction (both). This is a moderate-frequency path (~1-5 calls per session).
  - The hybrid search already combines vector (0.7 weight) and FTS (0.3 weight) with recency boost (+0.1). Adding quality score weighting fits naturally.
  - Auto-capture heuristics fire on every tool call. A new heuristic must be fast (<5ms) since it's in the hot path.

## Assumptions

- The vector store and embedding service are functional on the developer's machine — supported by: existing `memory_search` MCP tool uses them successfully — Tasks 1, 2 depend on this
- `quality_score` column can be added without breaking existing callers — supported by: SQLite ADD COLUMN with DEFAULT is non-breaking — Task 4 depends on this
- Repeated errors on the same file within the EventBuffer window is a reliable signal for failed approaches — supported by: error-fix detection already uses similar buffer scanning (`hasRecentError`) — Task 3 depends on this
- The embedding latency (~50-200ms) is acceptable during restore — supported by: restore runs 1-5 times per session, not on every tool call — Task 1 depends on this

## Testing Strategy

- **Unit tests:** `src/memory/restore.test.ts` — test semantic restore with mock service/vector store
- **Unit tests:** `src/memory/capture.test.ts` — test failed approach heuristic
- **Unit tests:** `src/memory/maintenance.test.ts` — test quality decay
- **Integration:** Test full restore path via sidecar with real vector store
- **Existing tests:** Full suite must pass after all changes

## Risks and Mitigations

| Risk                                               | Likelihood | Impact | Mitigation                                                                         |
| -------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------- |
| Vector store not available (sqlite-vec missing)    | Medium     | Medium | Graceful fallback to chronological restore (existing behavior)                     |
| Embedding latency slows restore                    | Low        | Medium | Timeout on embedding (500ms), fall back to FTS-only if slow                        |
| Quality decay removes useful observations          | Low        | Medium | Soft decay (never auto-delete), manual prune only via MCP tool                     |
| Failed approach heuristic produces false positives | Medium     | Low    | Conservative confidence (0.60), tag with "failed-approach" for easy identification |
| V8 migration breaks existing databases             | Very Low   | High   | Backup before migration (existing pattern in maintenance.ts)                       |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Semantic restore returns worse results than chronological** (Task 1) — Trigger: restored observations are less relevant than before because the embedding model doesn't understand code context well. The MiniLM-L6-v2 model is trained on general text, not code. Mitigation: hybrid scoring with recency boost should prevent pure semantic results from dominating; quality score adds another signal.

2. **Failed approach heuristic triggers too aggressively** (Task 3) — Trigger: normal iterative development (fix error, get new error, fix again) is classified as "failed approach" when it's actually progress. Mitigation: require 3+ errors on the SAME file with no success between them, and require the file to be reverted or significantly rewritten.

3. **Quality decay makes old but important observations invisible** (Task 4) — Trigger: a critical architectural decision from 2 months ago decays to low quality and is never restored. Mitigation: decisions decay slower than other types, and the `memory_maintain` tool lets users boost important observations.

## Goal Verification

### Truths

1. `restoreContext()` uses semantic search (hybrid vector+FTS) when vector store is available
2. Semantic query is constructed from active spec task description (primary) + recent files (fallback)
3. Restore falls back to chronological fetch when vector store is unavailable
4. Failed approach patterns (repeated errors + git restore) are detected and captured as observations
5. Observations have a `quality_score` that decays over time
6. `memory_maintain` MCP tool allows pruning low-quality observations
7. Restore prioritizes high-quality observations via score weighting

### Artifacts

- `src/memory/restore.ts` (modified) — semantic restore with hybrid search
- `src/memory/capture.ts` (modified) — failed approach heuristic
- `src/memory/maintenance.ts` (modified) — quality decay function
- `src/memory/migrations.ts` (modified) — V8 migration for quality_score
- `src/memory/mcp-tools.ts` (modified) — memory_maintain tool
- `src/sidecar/routes.ts` or separate route file (modified) — accept semanticQuery in /context

### Key Links

- `restoreContext()` ← uses `service.search()` → orchestrator → hybrid strategy → vector store
- `detectFailedApproach()` ← called from `analyzeEvent()` in the heuristic chain
- `quality_score` column ← set on insert, decayed by maintenance, weighted in restore/search
- `memory_maintain` MCP tool ← calls maintenance functions for decay + prune

## Progress Tracking

- [x] Task 1: Add semantic restore to `restoreContext()`
- [x] Task 2: Wire semantic query through sidecar and callers
- [x] Task 3: Add failed approach detection heuristic
- [x] Task 4: Add quality_score column and V8 migration
- [x] Task 5: Implement quality decay in maintenance
- [x] Task 6: Create `memory_maintain` MCP tool
- [x] Task 7: Weight restore results by quality score

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add semantic restore to `restoreContext()`

**Objective:** Modify `restoreContext()` to use hybrid search (vector + FTS) instead of chronological fetch when a semantic query is provided and the vector store is available.

**Dependencies:** None

**Files:**

- Modify: `src/memory/restore.ts`
- Modify: `src/memory/restore.test.ts`

**Key Decisions / Notes:**

- Add a `semanticQuery?: string` field to `RestoreOptions` (line 27)
- When `semanticQuery` is provided and `service.search()` is available, use it instead of `service.getRecentForProject()`:
  ```ts
  const searchResults = await service.search(semanticQuery, {
    project: projectPath,
    limit: recentLimit,
  });
  ```
- The orchestrator (`search/orchestrator.ts:81-102`) already selects hybrid strategy when vector is available — no changes needed there
- If semantic search returns < 3 results, supplement with chronological results (deduped)
- Fallback: if `semanticQuery` is not provided or search throws, use existing chronological behavior
- Timeout: wrap the search in a `Promise.race` with 2s timeout to prevent slow embeddings from blocking restore

**Definition of Done:**

- [ ] `restoreContext()` accepts `semanticQuery` option
- [ ] When provided, uses `service.search()` for observation retrieval
- [ ] Falls back to chronological when query is absent or search fails
- [ ] Supplements sparse semantic results with chronological
- [ ] Tests verify semantic path, fallback path, and hybrid results

**Verify:**

- `bun test src/memory/restore.test.ts`

---

### Task 2: Wire semantic query through sidecar and callers

**Objective:** Pass a semantic query from hooks and plugins through the sidecar to `restoreContext()`. Construct the query from active spec task + recent files + project name.

**Dependencies:** Task 1

**Files:**

- Modify: `src/sidecar/routes.ts` (add `semanticQuery` param to `/context` endpoint)
- Modify: `src/sidecar/client.ts` (add `semanticQuery` param to `restoreContext()`)
- Modify: `src/cli/commands/hook.ts` (construct semantic query in `runMemoryRestore()` and `runPreCompact()`)
- Modify: `targets/opencode/plugins/sentinal.ts` (construct semantic query in compaction handler)

**Key Decisions / Notes:**

- **Helper location:** Create `buildSemanticQuery()` in `src/memory/restore.ts` (at 238 lines, well under limit). This keeps it co-located with `restoreContext()` and accessible to all callers.
- **Query construction logic:** `buildSemanticQuery(projectPath: string, service?: MemoryService): string` that:
  1. Checks for active spec via `findActivePlan(projectPath)` — if found, reads the current uncompleted task's title + objective
  2. Falls back to: project directory basename + recently edited files (from the last 5 observations for this project via `service.getRecentForProject()`)
  3. Minimum fallback: project directory basename alone (NEVER returns empty string)
  4. Returns a single string suitable for embedding (max ~500 chars)
- **Always-semantic enforcement:** `buildSemanticQuery()` return type is `string` (not `string | undefined`). It MUST always return a non-empty string. The project basename is the absolute minimum fallback.
- **Sidecar `/context` route:** Add `semanticQuery` query parameter (optional). Pass through to `restoreContext()`.
- **Client method:** Add `semanticQuery?: string` to `restoreContext()` signature.
- **Claude Code hooks:** In `runMemoryRestore()` (hook.ts:185-215) and `runPreCompact()` (hook.ts:232-275), call `buildSemanticQuery(input.cwd)` and pass to `client.restoreContext()`.
- **OpenCode plugin:** In the compaction handler (sentinal.ts:447-484), build query from `projectRoot` and pass to `sidecar.restoreContext()`.
- **Line count concern:** `routes.ts` is at 398 lines. Adding a query param to `/context` is ~2 lines — acceptable.

**Definition of Done:**

- [ ] `/context` sidecar endpoint accepts `semanticQuery` param
- [ ] `SidecarClient.restoreContext()` passes `semanticQuery`
- [ ] Claude Code hooks construct and pass semantic query
- [ ] OpenCode plugin constructs and passes semantic query
- [ ] Semantic query uses active spec task when available, falls back to file list

**Verify:**

- `bun test src/sidecar/ src/hooks/ src/memory/restore.test.ts`

---

### Task 3: Add failed approach detection heuristic

**Objective:** Add a `detectFailedApproach()` heuristic to the capture system that detects repeated errors on the same file and explicit git restore/checkout patterns.

**Dependencies:** None

**Files:**

- Modify: `src/memory/capture.ts`
- Modify: `src/memory/capture.test.ts`

**Key Decisions / Notes:**

- **Signal 1 — Repeated errors:** 3+ events with `success: false` or `hasErrorIndicator(output)` on the same `filePath` within the buffer window (last 10 events). No successful edit between errors.
- **Signal 2 — Git restore:** Bash event with `git checkout --` or `git restore` in the output, targeting a file that was recently edited.
- **Confidence:** 0.60 (conservative — just above threshold to capture but low enough to be deprioritized in restore)
- **Type:** `"pattern"` with tags `["failed-approach", "auto-captured"]`
- **Content:** Include what was tried (the file path, error indicators) and what the outcome was (reverted, abandoned)
- **Line count:** `capture.ts` is at 424 lines. Adding ~40 lines for the new heuristic pushes it to ~465. Consider extracting helper functions or moving constants to reduce. If needed, extract the heuristic functions into `src/memory/capture-heuristics.ts`.
- Insert into the heuristic chain at `analyzeEvent()` after `detectBuildFixSequence` (last position — lowest priority for a speculative heuristic)

**Definition of Done:**

- [ ] `detectFailedApproach()` detects repeated errors on same file
- [ ] `detectFailedApproach()` detects git restore/checkout patterns
- [ ] Captured with type "pattern" and tag "failed-approach"
- [ ] Confidence is 0.60 (just above threshold)
- [ ] Tests cover: repeated errors triggering, git restore triggering, normal iteration NOT triggering

**Verify:**

- `bun test src/memory/capture.test.ts`

---

### Task 4: Add quality_score column and V8 migration

**Objective:** Add a `quality_score REAL DEFAULT 1.0` column to the observations table via a V8 migration. Set initial quality based on capture confidence for existing observations.

**Dependencies:** None

**Files:**

- Modify: `src/memory/migrations.ts` (add V8 migration)
- Modify: `src/memory/types.ts` (update `CURRENT_VERSION` to 8, add `qualityScore` to `Observation` type)

**Key Decisions / Notes:**

- V8 migration: `ALTER TABLE observations ADD COLUMN quality_score REAL DEFAULT 1.0`
- Backfill: set `quality_score = json_extract(metadata, '$.confidence')` where metadata has confidence, else 1.0
- Add index: `CREATE INDEX idx_obs_quality ON observations(quality_score)` for efficient filtering
- Update `Observation` type in `types.ts` to include `qualityScore: number`
- Update `deserializeObservation()` in `store.ts` to read the new column (minimal change)
- Bump `DB_CONSTANTS.SCHEMA_VERSION` from 7 to 8 (in `src/memory/types.ts` where `DB_CONSTANTS` is defined)
- **Set quality_score on new inserts:** Update `service.addObservation()` (service.ts:64-78) to set `quality_score` from `metadata.confidence` when available, otherwise 1.0. Since `store.ts` is at 663 lines (over limit), modify the service layer instead.

**Definition of Done:**

- [ ] V8 migration adds `quality_score` column with default 1.0
- [ ] Existing observations backfilled from metadata confidence
- [ ] Index created on `quality_score`
- [ ] `Observation` type includes `qualityScore`
- [ ] New observations set `quality_score` from capture confidence at insert time
- [ ] Migration runs successfully on existing databases

**Verify:**

- `bun test src/memory/`

---

### Task 5: Implement quality decay in maintenance

**Objective:** Add a `decayQualityScores()` function to maintenance that reduces quality scores based on age, with type-based decay rates.

**Dependencies:** Task 4

**Files:**

- Modify: `src/memory/maintenance.ts`
- Modify: `src/memory/maintenance.test.ts`

**Key Decisions / Notes:**

- **Time-proportional decay formula:** `new_score = quality_score * (decay_rate ^ (days_since_creation / 30))`. This is calculated per-observation based on its `timestamp` vs current time, so running decay after 60 days applies 2 periods of decay automatically. No need for a `last_decayed_at` column — the formula is idempotent when calculated from creation time.
- **Type-based rates (per 30 days):**
  - `decision`: 0.95 (slow decay — decisions stay relevant longer)
  - `discovery`: 0.90
  - `pattern`: 0.85
  - `fix`: 0.80 (fast decay — specific fixes become less relevant)
  - `error`: 0.75 (fastest decay — errors are transient)
- **Minimum score:** 0.1 (never decay to zero — observations are always findable via search)
- **Function signature:** `decayQualityScores(store: MemoryStore, options?: { dryRun?: boolean }): { updated: number, decayed: number }`
- **Implementation:** Single SQL UPDATE per type bucket rather than per-observation iteration

**Definition of Done:**

- [ ] `decayQualityScores()` reduces scores based on type and age
- [ ] Decisions decay slowest, errors decay fastest
- [ ] Minimum score of 0.1 enforced
- [ ] Dry-run mode returns counts without updating
- [ ] Tests verify decay rates per type

**Verify:**

- `bun test src/memory/maintenance.test.ts`

---

### Task 6: Create `memory_maintain` MCP tool

**Objective:** Register a `memory_maintain` MCP tool that triggers quality decay and allows pruning observations below a quality threshold.

**Dependencies:** Task 5

**Files:**

- Modify: `src/memory/mcp-tools.ts`
- Modify: `src/memory/mcp-tools.test.ts`

**Key Decisions / Notes:**

- **Parameters:**
  - `action` (required): `"decay"` | `"prune"` | `"stats"`
  - `prune_threshold` (optional, default 0.15): prune observations with quality_score below this
  - `dry_run` (optional, default false): preview without changes
- **Actions:**
  - `decay`: Run `decayQualityScores()`, return counts
  - `prune`: Delete observations with `quality_score < prune_threshold`, return counts
  - `stats`: Return quality score distribution (count per bucket: 0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0)
- Route through sidecar when available, direct when not (use the existing MCP tool routing pattern — `decayQualityScores()` and prune are called on `MemoryStore` directly, no new sidecar endpoint needed)
- Return structured markdown with action results

**Definition of Done:**

- [ ] `memory_maintain` tool registered with Zod schema
- [ ] Supports decay, prune, and stats actions
- [ ] Prune respects threshold parameter
- [ ] Dry-run mode works for both decay and prune
- [ ] Tests cover all three actions

**Verify:**

- `bun test src/memory/mcp-tools.test.ts`

---

### Task 7: Weight restore results by quality score

**Objective:** Integrate `quality_score` into the restore and search scoring so higher-quality observations are prioritized.

**Dependencies:** Task 4, Task 1

**Files:**

- Modify: `src/memory/search/strategies/hybrid.ts` (multiply combined score by quality_score)

**Key Decisions / Notes:**

- **In hybrid strategy only:** After computing combined score (vector*0.7 + fts*0.3 + recency), multiply by `qualityScore`. This requires fetching `quality_score` when loading observations in the strategy.
- **Chronological restore unchanged:** Keep pure timestamp ordering for the fallback path. Quality weighting only applies to semantic search results. This preserves existing behavior and avoids surprises.
- **Weight formula:** `finalScore = combinedScore * Math.max(qualityScore, 0.1)` — ensures minimum visibility
- **Observation fetching:** The search strategies already fetch full observations to apply filters. Add `qualityScore` to the returned data.

**Definition of Done:**

- [ ] Hybrid search multiplies combined score by quality_score
- [ ] Chronological restore is unchanged (pure timestamp)
- [ ] High-quality observations rank above low-quality ones in semantic search
- [ ] Tests verify score ordering

**Verify:**

- `bun test src/memory/`
