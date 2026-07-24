# Memory Update, Delete & Auto-Maintain (freshness) Implementation Plan

Created: 2026-07-24
Status: VERIFIED
Approved: Yes
Iterations: 5
Worktree: No
Type: Feature

## Summary

**Goal:** Let an agent correct an existing memory in place (`memory_update`) and remove redundant ones (`memory_delete`) instead of appending endless "CORRECTION" observations — updating resets the memory's staleness (timestamp + quality) so the corrected fact is fresh again and the stale original stops lingering in search. **Plus:** make the existing-but-dormant `memory_maintain` (decay/prune) actually keep memories fresh — auto-run a throttled decay on sidecar startup, expose it via the CLI, and document the whole freshness lifecycle so agents know it exists.

**Architecture:** Add `updateObservation()` to the SQLite store (reuses the existing `observations_au` AFTER-UPDATE FTS trigger for re-indexing), expose `memory_update` + `memory_delete` MCP tools (with sidecar routes + client methods, following the existing `{ client, store }` delegation pattern), add `sentinal memory update|delete` CLI commands, re-embed assets, then update the shipped `sentinal-memory` rule + spec skills to prefer updating over appending corrections.

**Tech Stack:** TypeScript, `bun:sqlite` (bun test), MCP SDK (zod), commander CLI, the sidecar HTTP layer.

## Scope

### In Scope

- `src/memory/store.ts`: `updateObservation(id, patch)` — updates title/content/type/tags/filePaths and **resets `timestamp=now` + `quality_score` to fresh**; returns the updated observation or null if not found. (`deleteObservation` already exists; FTS auto-syncs via the `observations_au` trigger.)
- **`src/memory/service.ts`: `updateObservation(id, patch)` — the layer the routes/tools actually use.** After the store UPDATE it MUST re-index the vector embedding: `vectorStore?.removeObservation(id)` then `vectorStore?.indexObservation(...)` with the NEW content (there is no vector-update — remove + re-add). This mirrors how `service.addObservation` indexes (`service.ts:87`) and `service.deleteObservation` removes (`service.ts:114`). ⚠️ **Without this, a corrected memory's OLD embedding lingers and `memory_search` (hybrid vector+FTS, live in the sidecar) resurfaces the stale text.**
- `src/memory/mcp-tools.ts`: register `memory_update` and `memory_delete`, delegating via the `{ client, service }` pattern (routes go through `ctx.service`, NOT the raw store).
- `src/sidecar/routes.ts` + `src/sidecar/client.ts`: add `/memory/update` + `/memory/delete` routes (call `ctx.service.updateObservation`/`deleteObservation`) + `SidecarClient` methods.
- `src/memory/cli.ts`: `sentinal memory update <id> [--title|--content|--type|--tags ...]` and `sentinal memory delete <id>` (via the service so vectors are handled).
- Re-embed: `bun run embed-assets` so `sentinal install` ships the new tools/CLI.
- **Freshness / auto-maintain (dormant today — nothing calls `memory_maintain`; no docs; decay never auto-runs):**
  - **Auto-run throttled decay on sidecar startup** — in `startSidecar` (next to `cleanupStaleSessionsOnStartup`), run `decayQualityScores(store)` IF a `~/.sentinal/last-decay.json` timestamp is older than a threshold (~24h), then record the run. The sidecar boots ~once per work-session, giving natural ~daily decay with NO per-session hook and NO cross-session-loop risk (memory #163). Best-effort, wrapped in try/catch — never block sidecar startup.
  - **CLI expose:** add `sentinal memory decay [--dry-run]` and `sentinal memory maintain <decay|prune|stats> [--threshold N] [--dry-run]` (today the CLI only has `prune`). Route through the same `decayQualityScores` / prune logic.
  - **Docs:** document the freshness lifecycle in `sentinal-memory.md` — how quality decays with age (per-type rates), that decay now auto-runs, and when to manually `memory_maintain prune`.
- Docs: `targets/{opencode,claude-code}/rules/sentinal-memory.md` + spec-skill save guidance — prefer `memory_update` (by ID) over a new CORRECTION; use `memory_delete` to remove now-redundant corrections.

### Delete + vectors (your requirement, verified)

`service.deleteObservation` (`service.ts:111-114`) ALREADY calls `store.deleteObservation(id)` **and** `vectorStore?.removeObservation(id)`. So the only requirement for delete is that `memory_delete` (MCP + sidecar route + CLI) routes through **`service.deleteObservation`, not the raw `store.deleteObservation`** — otherwise the embedding is orphaned and a deleted memory can still surface via vector search. This is an explicit correctness gate in Tasks 2 & 3.

### Freshness scoring in search (why this matters — verified)

Quality/recency only affect ranking on ONE of the two search paths today:
- **Hybrid (vector up, the sidecar/production path)** — `hybrid.ts`: `score = vectorScore*0.7 + ftsScore*0.3`, then `+= (1 - age/90d)*0.1` recency boost (`RECENCY_WINDOW_MS`, `MAX_RECENCY_BOOST=0.1`), then `*= max(qualityScore, 0.1)`. So decay (quality) AND `memory_update` (timestamp→recency+quality) BOTH move ranking here.
- **FTS-only fallback (vector down)** — `service.searchFtsOnly` → `store.searchFTS` orders by raw bm25 `rank` and returns as-is. **quality_score and recency are IGNORED.** So without the fix below, `memory_update`/`decay` change nothing about ranking when vector search is unavailable.

**Fix (in scope — Task 6):** apply the SAME quality×recency weighting to the FTS-only fallback so freshness ranks consistently regardless of vector availability. Extract the hybrid weighting (`combinedScore *= max(quality,0.1)` + the recency boost) into a **shared helper** reused by BOTH `hybrid.ts` and `searchFtsOnly` — one formula, no drift. (`memory_update` already fixes CONTENT on both paths; this makes it affect RANKING on both too.)

### Out of Scope

- A dedicated `vectorStore.updateObservation` primitive (use remove + re-index; there's no in-place vector update).
- Retuning the weight constants (VECTOR_WEIGHT/FTS_WEIGHT/recency window/decay rates) — reuse existing values; only make the FTS path apply them.
- Bulk/mass update; title-based upsert (chosen key is explicit observation ID).
- Changing `memory_maintain` decay/prune behavior.

## Context for Implementer

- **Update key = observation ID** (user decision), obtained from a prior `memory_search`/`memory_save` (both already return IDs).
- **⚠️ Layer names (reviewer-corrected):** the STORE method is **`store.insertObservation`** (`store.ts:99`), NOT `addObservation`. **`addObservation`/`deleteObservation` are `MemoryService` methods** (`service.ts:71`, `:111`) — and the sidecar routes + MCP tools go through **`ctx.service`**, so the new `updateObservation` must exist at BOTH layers: `store.updateObservation` (raw SQL) and `service.updateObservation` (store + vector re-index). Tools/routes call the SERVICE.
- **Quality reset:** `insertObservation` derives `quality_score` from `metadata.confidence` (0–1) else `1.0` (`store.ts:100-107`). `updateObservation` resets it the SAME way (fresh `1.0`, or re-derive if confidence provided).
- **FTS is auto-maintained on UPDATE:** `observations_au` `AFTER UPDATE` trigger (`migrations.ts:109-114`) does a full delete+reinsert of title/content/tags using `new.*` — so a partial-field `UPDATE observations SET ... WHERE id=?` keeps FTS correct with NO manual handling (reviewer-confirmed).
- **VECTOR is NOT auto-maintained — must be handled in the service.** `service.addObservation` calls `vectorStore?.indexObservation(...)` (`service.ts:87`); `service.deleteObservation` calls `vectorStore?.removeObservation(id)` (`service.ts:114`). `vectorStore` has `indexObservation` (`vector-store.ts:158`) + `removeObservation` (`:208`), NO update. So `service.updateObservation` MUST `vectorStore?.removeObservation(id)` then `vectorStore?.indexObservation(updated)`. Vector/hybrid search is LIVE in the sidecar (memory #135), so this is required, not optional.
- **`deleteObservation(id)`** already exists at store (`store.ts:146`, existence-checked) and service (`service.ts:111`, also removes the vector). Expose the SERVICE one.
- **⚠️ Timeline side-effect (reviewer should-fix — decided):** `getTimelineAround` orders purely by `timestamp` (`store.ts:218-221`), so resetting `timestamp=now` moves a corrected observation to "now" in timeline windows. This is ACCEPTED and intended: a correction IS a fresh event, and refreshing recency is the whole point (it also drives the anti-staleness quality decay). Documented in Pre-Mortem so it's a conscious choice, not a surprise.
- **MCP delegation pattern:** memory tools take `{ client, service }`; when `client` (SidecarClient) is set, delegate to the sidecar route; else use `service` directly. `memory_save` (`mcp-tools.ts:257`, calls `client.addObservation`→POST `/observation`, else `service.addObservation`) is the exact template. Mirror for update/delete.
- **Sidecar:** memory routes live in `src/sidecar/routes.ts` (alongside `/observation`, `/memory/search`, `/timeline`, `/get`, `/stats`); add `/memory/update` + `/memory/delete` calling `ctx.service.updateObservation`/`deleteObservation`, + matching `SidecarClient` methods.
- **CLI:** `src/memory/cli.ts` dispatches by `argv[0]` (search/list/timeline/get/export/stats/prune/setup). Add `update` + `delete` cases + help text + `parseArgs` flags.
- **Docs delivery:** rules/skills are shipped via embedded assets; after editing `targets/**`, run `bun run embed-assets` (regenerated file is gitignored, guarded by `check-embed-assets`). Do NOT document the tools before they exist (avoids the stale-rules class of bug — memory #382).
- **Naming:** MCP tools are `snake_case` (`memory_update`, `memory_delete`).

## Assumptions

- The `observations_au` UPDATE trigger keeps FTS in sync on a raw SQL UPDATE — supported by `migrations.ts:109`. Task 1 depends on this (verify with an FTS search-after-update test).
- Resetting `timestamp` + `quality_score` on update is the intended "reset staleness" (decay = `quality * rate^(age/30d)` off `timestamp`, `maintenance.ts:172`). Tasks 1–4 depend on this.
- ID is a stable handle returned by search/save — no title-collision ambiguity. All tasks depend on this.

## Testing Strategy

- **Store unit**: `updateObservation` (fields changed; timestamp/quality reset; null on missing id; FTS finds NEW content, not OLD).
- **Service unit (VECTOR)**: on `updateObservation` with a mock/spy vectorStore, assert `removeObservation(id)` THEN `indexObservation(new content)` are called; on `deleteObservation`, assert `vectorStore.removeObservation(id)` is called (already exists — lock it). This is the guard for "no stale/dangling embeddings."
- **MCP tools**: `memory_update`/`memory_delete` via `service` (direct) and `client` (sidecar) paths; delete routes through the vector-aware service on both; unknown id graceful.
- **CLI**: `memory update <id> --content ...` and `memory delete <id>` mutate through the service.
- **Delivery**: `EMBEDDED_RULES` + `EMBEDDED_CC_RULES` contain the new rule guidance after `embed-assets`; `check-embed-assets` passes.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| FTS goes stale after update (search returns old text) | Med | High | Rely on the existing `observations_au` trigger; add a search-after-update test that asserts new content is found and old is not |
| Docs reference a tool that doesn't ship (stale-rules bug class) | Med | High | Sequence docs AFTER the tools; re-embed; a delivery test asserts the embedded rule mentions memory_update |
| Delete is destructive with no undo | Low | Med | Explicit ID only; tool description flags it destructive; no bulk delete |
| quality reset diverges from insert semantics | Low | Low | Reuse the same quality derivation as `addObservation` |

## Pre-Mortem

1. **Vector search resurfaces the STALE text after update** (Task 1) → Trigger: after `memory_update`, a `memory_search` (hybrid) returns the old content, because only FTS was re-indexed, not the embedding. Cause: forgot the vector remove+re-index in `service.updateObservation`. Mitigation: the service unit test asserts `vectorStore.removeObservation`+`indexObservation` fire; this is your stated requirement and the #1 risk.
2. **Deleted memory still appears in vector search** (Task 2/3) → Trigger: `memory_delete` removes the FTS row but a vector hit still returns the ghost. Cause: delete routed through `store.deleteObservation` (FTS-only) instead of `service.deleteObservation` (which also `vectorStore.removeObservation`). Mitigation: the correctness gate — all delete paths call the service; test asserts the vector removal.
3. **FTS stale after update** (Task 1) → Trigger: FTS search-after-update finds old content. Mitigation: rely on `observations_au`; the store test asserts new-found/old-not-found.
4. **Sidecar path not wired** (Task 2) → Trigger: works via direct service but not through the running MCP server (sidecar client). Mitigation: test BOTH branches; add the route + client method.
5. **Docs reference a mis-named tool** (Task 4) → Mitigation: snake_case; delivery test greps the embedded rule for `memory_update`.
6. **Auto-decay runs on EVERY sidecar boot (thrashing) or blocks startup** (Task 5) → Trigger: decay fires repeatedly, or a decay error stops the sidecar. Cause: throttle not honored / not wrapped. Mitigation: `last-decay.json` timestamp gate (default 24h) with injected clock in tests; best-effort try/catch so startup never fails.
7. **CLI decay diverges from memory_maintain decay** (Task 5) → Mitigation: both call the SAME `decayQualityScores` — no duplicated formula.

## Accepted Behavior Change

**Update resets `timestamp` → moves the observation to "now" in `memory_timeline`.** `getTimelineAround` orders by timestamp (`store.ts:218-221`), so a corrected observation re-anchors to the present. This is INTENDED: a correction is a fresh event, and refreshing recency is the whole point (it also resets the age-based quality decay so the corrected fact stops looking stale). Not a bug — a conscious trade (chronological "when first learned" is lost in favor of "when last correct").

## Execution Waves

**Wave 1** — store primitive (Task 1): the `updateObservation` foundation everything else builds on.
**Wave 2** — surface it (Tasks 2, 3, 6): MCP tools + sidecar (Task 2), CLI (Task 3), and FTS-fallback freshness weighting (Task 6) all depend on Task 1 but touch different files (mcp-tools/sidecar vs cli vs search) → parallel-safe.
**Wave 3** — docs + delivery + freshness (Tasks 4, 5): both depend on the tools existing (Tasks 2/3) so docs reference real tools; they share `sentinal-memory.md` so run SEQUENTIALLY (Task 4 then Task 5), not parallel — file overlap. Task 5 also adds the auto-decay runner + sidecar wiring + CLI (independent files).

## Goal Verification

### Truths

1. `store.updateObservation(id, patch)` changes content AND sets fresh `timestamp` + `quality_score`; null on missing id (unit).
2. After update, FTS finds the NEW content and NOT the OLD unique content (unit).
3. `service.updateObservation` calls `vectorStore.removeObservation(id)` then `vectorStore.indexObservation(new)`; `service.deleteObservation` calls `vectorStore.removeObservation(id)` — verified via vectorStore spy (no stale/dangling embeddings).
4. `memory_update`/`memory_delete` are registered `snake_case` MCP tools working via `service` AND `client` branches; delete routes through the vector-aware service on both (grep + unit).
5. `sentinal memory update <id> --content X` and `sentinal memory delete <id>` mutate through the service (CLI test).
6. `sentinal-memory.md` (both targets) instructs preferring `memory_update` over a new correction; `EMBEDDED_RULES` + `EMBEDDED_CC_RULES` reflect it after `embed-assets`.
7. The auto-decay runner decays when `last-decay.json` is missing/older-than-threshold and skips when fresh (unit, injected clock); `startSidecar` calls it best-effort without crashing on failure (unit).
8. `sentinal memory decay` and `sentinal memory maintain decay|prune|stats` exist and work (CLI test); `sentinal-memory.md` documents the freshness lifecycle.
9. A shared `applyFreshness` (recency-add-then-quality-multiply, `now` injectable) is the single formula: hybrid uses it (existing hybrid tests unchanged) AND `searchFtsOnly` over-fetches + re-ranks by it (a fresher item just past the bm25 limit can surface); `store.searchFTS` is NOT freshness-weighted (no double-apply); explicit date ordering passes through.
10. `bun test` green; `bunx tsc --noEmit` clean; `check-embed-assets` passes.

### Artifacts

| Artifact | Provides | Exports |
| -------- | -------- | ------- |
| src/memory/store.ts | raw update primitive (FTS via trigger) | updateObservation |
| src/memory/service.ts | update/delete WITH vector re-index/remove | updateObservation (+ existing deleteObservation) |
| src/memory/mcp-tools.ts | agent-facing update/delete | memory_update, memory_delete |
| src/sidecar/routes.ts + client.ts | sidecar-delegated update/delete | /memory/update, /memory/delete |
| src/memory/cli.ts | CLI update/delete + decay/maintain | `memory update`, `memory delete`, `memory decay`, `memory maintain` |
| src/memory/auto-decay.ts | throttled startup decay | runAutoDecayIfStale |
| src/sidecar/server.ts | startup wiring | (startSidecar calls auto-decay) |
| targets/*/rules/sentinal-memory.md | update/delete + freshness lifecycle | (rule) |

### Key Links

| From | To | Via | Pattern |
| ---- | -- | --- | ------- |
| mcp-tools.ts memory_update | service.updateObservation / client | injection pattern | updateObservation |
| service.updateObservation | vectorStore.removeObservation + indexObservation | vector re-index | vectorStore.*indexObservation |
| store.updateObservation | observations_fts | AFTER UPDATE trigger | UPDATE observations SET |
| cli.ts | service.updateObservation | `update` command | case "update" |
| sentinal-memory.md | memory_update tool | rule guidance | memory_update |

## Progress Tracking

- [x] Task 1: store + service updateObservation (staleness reset; FTS trigger; VECTOR re-index) (Wave 1)
- [x] Task 2: memory_update + memory_delete MCP tools + sidecar routes/client (service, vector-aware) (Wave 2)
- [x] Task 3: CLI `memory update` + `memory delete` (via service) (Wave 2)
- [x] Task 4: rules/skills guidance (prefer-update) + re-embed + delivery test (Wave 3)
- [x] Task 5: auto-run throttled decay on sidecar startup + CLI decay/maintain + freshness docs (Wave 3)
- [x] Task 6: quality × recency weighting on the FTS-only fallback (shared freshness helper) (Wave 2)
      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: store + service updateObservation (FTS via trigger, VECTOR via service re-index)

**Objective:** Add `updateObservation` at BOTH layers: `store.updateObservation` (raw SQL UPDATE, resets timestamp+quality, FTS auto-synced by trigger) and `service.updateObservation` (calls the store method THEN re-indexes the vector: remove + re-add with new content). Returns the updated observation or null.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/store.ts` (`updateObservation`)
- Modify: `src/memory/service.ts` (`updateObservation` — store + vector re-index)
- Test: `src/memory/store.test.ts`, `src/memory/service.test.ts`

**Key Decisions / Notes:**

- `store.updateObservation(id, patch: { title?; content?; type?; tags?; filePaths?; metadata? }): Observation | null` — existence check first (like `deleteObservation`), dynamic `UPDATE observations SET <changed>, timestamp=?, quality_score=? WHERE id=?` (timestamp=`Date.now()`, quality = same derivation as `insertObservation`), return `getObservation(id)`. Do NOT touch `observations_fts` (the `observations_au` trigger handles it).
- `service.updateObservation(id, patch): Observation | null` — call `this.store.updateObservation(...)`; if it returns an updated obs AND `this.vectorStore?.isAvailable()`, `this.vectorStore.removeObservation(id)` then `this.vectorStore.indexObservation(updated…)` (mirror `addObservation`'s indexing at `service.ts:87`). Vector re-index is best-effort/non-blocking like the insert path.

**Definition of Done:**

- [ ] Store: fields change; `timestamp`+`quality_score` refreshed (new timestamp > old); null on missing id
- [ ] FTS: `searchFTS(newUniqueWord)` finds it; `searchFTS(oldUniqueWord)` does not
- [ ] Service: on update with a vector store present, `removeObservation` then `indexObservation` are called (spy/mock the vectorStore); no old embedding remains
- [ ] `bun test src/memory/store.test.ts src/memory/service.test.ts` green

**Verify:** `bun test src/memory/store.test.ts src/memory/service.test.ts --verbose`

### Task 2: memory_update + memory_delete MCP tools (+ sidecar routes/client)

**Objective:** Register `memory_update` and `memory_delete` MCP tools using the `{ client, service }` pattern with sidecar routes + client methods, so the production (sidecar-backed) path works. **Delete MUST route through `service.deleteObservation`** (which removes the vector), never the raw store.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/memory/mcp-tools.ts`
- Modify: `src/sidecar/routes.ts`, `src/sidecar/client.ts`
- Test: `src/memory/mcp-tools.test.ts`, `src/sidecar/routes.test.ts`

**Key Decisions / Notes:**

- `memory_update({ id, title?, content?, type?, tags?, filePaths? })` → `client.updateObservation(...)` when client set, else `service.updateObservation(...)`. `memory_delete({ id })` → `client.deleteObservation(id)` / `service.deleteObservation(id)`. Descriptions flag delete destructive; both `snake_case`.
- Mirror `memory_save`'s dual-path structure. Add `/memory/update` + `/memory/delete` routes in `routes.ts` calling `ctx.service.updateObservation`/`deleteObservation`; add `SidecarClient.updateObservation`/`deleteObservation`.
- ⚠️ **Correctness gate:** both the direct AND sidecar delete paths call the SERVICE (vector-aware), not `store.deleteObservation`.

**Definition of Done:**

- [ ] Both tools registered; work via `service` AND `client` branches; unknown id → graceful message
- [ ] Delete goes through the service (vector removed) on both paths — asserted via a vectorStore spy
- [ ] `bun test src/memory/mcp-tools.test.ts src/sidecar/routes.test.ts` green

**Verify:** `bun test src/memory/mcp-tools.test.ts src/sidecar/routes.test.ts --verbose`

### Task 3: CLI `memory update` + `memory delete`

**Objective:** Add `sentinal memory update <id> [--title|--content|--type|--tags]` and `sentinal memory delete <id>` to the memory CLI.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/memory/cli.ts`
- Test: `src/memory/cli.test.ts`

**Key Decisions / Notes:**

- Add `update`/`delete` cases to the `argv[0]` dispatch + `parseArgs` flags + help/usage text (mirror the `get`/`prune` command style).

**Definition of Done:**

- [ ] `memory update <id> --content X` updates the store; `memory delete <id>` removes it; both print clear output; usage on bad args
- [ ] `bun test src/memory/cli.test.ts` green

**Verify:** `bun test src/memory/cli.test.ts --verbose`

### Task 4: Docs (prefer update over correction) + re-embed + delivery test

**Objective:** Update the shipped memory rule + spec-skill save guidance to prefer `memory_update` (by ID) over appending a CORRECTION, and `memory_delete` to remove redundant corrections; re-embed; guard delivery.
**Dependencies:** Task 2, Task 3
**Wave:** 3

**Files:**

- Modify: `targets/opencode/rules/sentinal-memory.md`, `targets/claude-code/rules/sentinal-memory.md`
- Modify (light): spec-skill save cues if they say "save a correction" anywhere
- Regenerate: `src/cli/embedded-assets.ts` via `bun run embed-assets`
- Test: extend `src/cli/rules-memory-refs.test.ts` (or add a small delivery assertion)

**Key Decisions / Notes:**

- Add to `sentinal-memory.md`: "When a saved observation is wrong or outdated, prefer `memory_update(id, …)` (find the id via `memory_search`) over saving a new CORRECTION — updating fixes the fact AND refreshes its recency. Use `memory_delete(id)` to remove now-redundant corrections." Keep both targets in sync.
- Delivery test: assert both `EMBEDDED_RULES` and `EMBEDDED_CC_RULES` `sentinal-memory.md` contain `memory_update` (mirrors the prior stale-rules delivery guard).

**Definition of Done:**

- [ ] Both target rules mention `memory_update`/`memory_delete` with the prefer-update guidance
- [ ] `bun run embed-assets` run; both embedded rule records contain `memory_update`
- [ ] `bun test && bunx tsc --noEmit` green; `bun scripts/check-embed-assets.mjs` passes

**Verify:** `bun test src/cli/rules-memory-refs.test.ts && bun scripts/check-embed-assets.mjs`

### Task 5: Auto-run throttled decay + CLI decay/maintain + freshness docs

**Objective:** Make freshness passive: auto-run `decayQualityScores` on sidecar startup (throttled ~24h via a state file), expose decay/maintain in the CLI, and document the lifecycle. `memory_maintain` is currently never called by anything and undocumented.
**Dependencies:** Task 4 (docs land after the update/delete docs; shares sentinal-memory.md)
**Wave:** 3

**Files:**

- Create: `src/memory/auto-decay.ts` (throttled runner: read `~/.sentinal/last-decay.json`; if older than threshold or missing → `decayQualityScores(store)` + write new timestamp; best-effort)
- Modify: `src/sidecar/server.ts` (`startSidecar` — call the throttled runner next to `cleanupStaleSessionsOnStartup`, in try/catch)
- Modify: `src/memory/cli.ts` (`decay` + `maintain` commands + help)
- Modify: `targets/{opencode,claude-code}/rules/sentinal-memory.md` (freshness lifecycle section)
- Test: `src/memory/auto-decay.test.ts`, `src/memory/cli.test.ts`

**Key Decisions / Notes:**

- **Throttle:** default 24h; runner reads/writes a `last-decay.json` timestamp under `~/.sentinal/` (mirror `paths.ts` helpers). Missing/stale → run; fresh → skip. Deterministic in tests via an injectable `now`/threshold/state-path.
- **Startup wiring (reviewer-corrected):** ⚠️ `decayQualityScores` is O(N) per-row `UPDATE`s in a JS loop with NO transaction (`maintenance.ts:186-221`), and `startSidecar` runs `cleanupStaleSessionsOnStartup` at `:293` BEFORE the socket-bind / `alreadyRunning` early-return. So do NOT run decay inline on the hot path. Instead: (a) run it only AFTER the `alreadyRunning` early-return (so a redundant sidecar spawn never decays), and (b) run it OFF the hot path — schedule it right after the server starts listening (e.g. `queueMicrotask`/`setTimeout(0)` post-`Bun.serve`, next to the background vector-init that already runs "after listen"), wrapped in a transaction for the row updates. Best-effort try/catch — a decay failure must NEVER affect the sidecar.
- **CLI:** `sentinal memory decay [--dry-run]` and `sentinal memory maintain <decay|prune|stats> [--threshold N] [--dry-run]`, reusing `decayQualityScores` + the existing prune query. Mirror the `prune` command wiring in `cli.ts`.
- ⚠️ **CLI prune safety (reviewer):** the existing `memory prune` (`cli.ts` → `runPrune`) deletes with NO guard. The new `maintain prune` (and ideally a note for the existing `prune`) must **default to dry-run and require an explicit `--apply`** to actually delete — the MCP tool already supports `dry_run`, so mirror that safety in the CLI. Deleting memory is destructive and unrecoverable.
- **State-path guard:** no generic `~/.sentinal` helper exists to "mirror"; the auto-decay runner must `mkdirSync(dirname(stateFile), { recursive: true })` before writing `last-decay.json` (fresh machines / CI have no `~/.sentinal`), matching how `startSidecar` guards its socket-dir write.
- **Docs:** add a "Keeping memory fresh" section — per-type decay rates, that decay auto-runs (~daily via the sidecar), and manual `memory_maintain prune`/CLI usage. Prefer commands over prose (skill quality rule).

**Definition of Done:**

- [ ] Auto-decay runs when the state file is missing/older-than-threshold and skips when fresh (unit, injected clock/state-path)
- [ ] `startSidecar` invokes it best-effort; a thrown decay does not crash startup (unit)
- [ ] `sentinal memory decay` and `memory maintain decay|prune|stats` work; `maintain prune` is dry-run by default and only deletes with `--apply` (CLI test)
- [ ] Startup decay runs OFF the hot path (after listen / after alreadyRunning return), in a transaction; a thrown decay does not affect the sidecar (unit)
- [ ] `sentinal-memory.md` documents the freshness lifecycle; `EMBEDDED_*` reflects it
- [ ] `bun test && bunx tsc --noEmit` green; `check-embed-assets` passes

**Verify:** `bun test src/memory/auto-decay.test.ts src/memory/cli.test.ts && bun scripts/check-embed-assets.mjs`

### Task 6: Apply quality × recency weighting to the FTS-only fallback

**Objective:** Make freshness (quality_score + recency) affect ranking on the FTS-only path too, using the SAME formula as hybrid via a shared helper — so `memory_update`/`decay` change ranking whether or not vector search is up.
**Dependencies:** Task 1 (freshness semantics settled)
**Wave:** 2 (independent files from Tasks 2/3; touches search only)

**Files:**

- Create: `src/memory/search/freshness.ts` — `applyFreshness(baseScore, obs, now): number`. ⚠️ **Exact order-of-ops MUST match hybrid** (`hybrid.ts:91-101`): recency is ADDED to the base FIRST, THEN the sum is MULTIPLIED by quality — i.e. `let s = baseScore; if (age < RECENCY_WINDOW_MS) s += (1 - age/RECENCY_WINDOW_MS) * MAX_RECENCY_BOOST; s *= max(obs.qualityScore ?? 1, 0.1); return s;`. NOT `base*quality + recency`. `now` is a parameter (injectable for deterministic tests).
- Modify: `src/memory/search/strategies/hybrid.ts` — replace its inline recency+quality math (`:93-101`) with `applyFreshness(combinedScore, obs, now)` (behavior-preserving; existing hybrid tests MUST stay green — the extracted formula is byte-equivalent).
- Modify: `src/memory/service.ts` `searchFtsOnly` (`:160`) — the re-rank lives HERE, NOT in `store.searchFTS` (which is shared by hybrid's `FTSStrategy` — re-ranking there would double-apply freshness). See over-fetch + orderBy below.
- Test: `src/memory/search/freshness.test.ts`, extend `src/memory/service.test.ts` (FTS-only re-rank).

**Key Decisions / Notes:**

- **⚠️ Over-fetch before LIMIT (must-fix):** `store.searchFTS` applies `LIMIT/OFFSET` in SQL (`store.ts:181-182`) and returns an already-truncated bm25 page — so re-ranking only that page can NEVER promote a fresher item bm25-ranked past the limit boundary (exactly where a decayed item sinks). Fix in `searchFtsOnly`: build a cloned `SearchFilters` with an inflated candidate limit (e.g. `max(limit*5, 50)`) and `offset: 0`, call `store.searchFTS` with it, apply `applyFreshness` over that larger candidate set, sort desc, THEN slice to the caller's `limit`/`offset`. No `store.searchFTS` signature change needed.
- **⚠️ orderBy guard (should-fix):** the mode branch lives in `store.searchFTS`'s SQL (`store.ts:180`). In `searchFtsOnly`, only apply the freshness re-rank when the effective order is the DEFAULT relevance mode; if `orderBy` is `date_asc`/`date_desc`, pass through unchanged (no over-fetch, no re-rank) so explicit chronological ordering is preserved.
- **Base score = positional** (mirror `fts.ts` `1.0 - index*0.05`): `store.searchFTS` does NOT expose the raw bm25 `rank` on the `Observation` type, so positional is the only in-scope base. ⚠️ This means bm25 MAGNITUDE is lost — so do NOT claim "a far stronger text match still wins" (unprovable with positional base). What IS guaranteed and testable: among results already in bm25 order, a higher-quality/fresher observation is boosted relative to a stale one, and the quality multiplier is bounded (≥0.1) so it re-orders within the candidate set rather than nulling relevance.
- **Test determinism (repo `sentinal-testing` rule):** use dynamic timestamp offsets (`Date.now() - N*day`), never hardcoded ISO dates; inject `now` into `applyFreshness`.

**Definition of Done:**

- [ ] `applyFreshness` is the single formula (recency-add-then-quality-multiply, matching hybrid); hybrid refactored to use it; ALL existing hybrid tests unchanged/green
- [ ] `searchFtsOnly` over-fetches candidates, applies freshness, sorts, then slices to limit/offset — a fresher/higher-quality item bm25-ranked just past the limit CAN now surface (test proves it)
- [ ] Explicit `date_asc`/`date_desc` ordering is passed through untouched (test)
- [ ] Re-rank lives only in `searchFtsOnly`; `store.searchFTS` (used by hybrid's FTSStrategy) is NOT freshness-weighted (no double-apply — grep/assert)
- [ ] `bun test src/memory/ green`; `bunx tsc --noEmit` clean

**Verify:** `bun test src/memory/search/ src/memory/service.test.ts --verbose`
