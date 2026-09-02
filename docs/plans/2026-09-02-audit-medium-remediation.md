# Audit Medium Remediation + Deferred Items Implementation Plan

Created: 2026-09-02
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: Yes
Type: Feature

## Summary

**Goal:** Close out the v1.36.1 audit (memory #610): the two items deferred from v1.36.2 (`reconcile.ts` prefix collision; the remaining `~/.sentinal` write paths) plus all actionable MEDIUM findings.

**Architecture:** All fixes in `src/`. No shipped command/rule prose changes → **zero parity-baseline regeneration**. Three waves of file-disjoint tasks; one pre-requisite split (`uninstall.ts`, 691, over the block).

**Tech Stack:** TypeScript (strict), Bun + `bun test`, zod 4.

## Scope

### In Scope

| ID | Finding | Site |
| --- | --- | --- |
| D1 | `reconcile.ts:82` prefix collision — `startsWith` should be exact equality (deferred from H4) | `src/worktree/reconcile.ts` |
| D2 | 8 remaining `homedir()/.sentinal` write paths not routed through `getSentinalHome()` — `file-log.ts` writes the real `sidecar.log` on every suite run | `file-log.ts:42`, `observation-queue.ts:18`, `quality-runners.ts:53-54`, `auto-decay.ts:45`, `embeddings.ts:67`, `native-deps.ts:25`, `dashboard/lifecycle.ts:17,137`, `dashboard-ensure.ts:23`, `config.ts:56` (read) |
| M1 | LSP: never re-rooted per project; two projects share one instance (`diagnosticsMap.clear()` races); timeout resolves as false "0 errors" defeating the tsc fallback; Content-Length counts bytes but slices UTF-16 chars | `src/sidecar/lsp-client.ts`, `quality-routes.ts`, `quality-runners.ts` |
| M2 | Sidecar lifecycle: `autoStartSidecar` trusts `kill(pid,0)` only (recycled PID blocks start forever; `isSidecarReachable()` exists but unused); `stopSidecarProcess` signals with no identity check; no version in `/health` (old sidecar serves after upgrade); start TOCTOU double-spawn | `src/sidecar/lifecycle.ts`, `routes.ts`, `server.ts`, `client.ts`, `src/cli/commands/sidecar*.ts` |
| M3 | worktree: cleanup guard 3 exact-path only (cwd in a subdir of your own worktree is unprotected from `--force`); default cleanup pass iterates ALL projects globally (`branch -D` in every tracked repo); `abandon` swallows `rmSync` failure and marks abandoned anyway | `src/worktree/cleanup.ts`, `cleanup-mcp-tool.ts`, `manager.ts` |
| M4 | runtime: teardown verdict captured before `down` runs (unbounded `graceMs`) then not re-verified; failed SIGKILL still returns `ok:true` and DELETES the pidfile (orphans a live group); `runtime_up` claim race (no exclusive write) | `src/runtime/teardown.ts`, `lifecycle.ts`, `pidfile.ts` |
| M5 | plan parser: no code-fence awareness (fenced `### Task 7` becomes a real task, corrupting `task_count` → stop-guard/statusline); duplicate task positions corrupt counts | `src/spec/parser.ts` |
| M6 | memory: prune never removes vector rows (orphans consume KNN k-slots forever); `memory_maintain` not registered at all in sidecar mode (catalog lies by omission) | `src/memory/store.ts` (prune), `mcp-tools.ts`, `vector-store.ts` |
| M7 | config writers: `sentinal update` reverts user permission opt-outs every run (uninstall deletes keys wholesale, reinstall re-adds defaults); installer `mcp` merge is sentinal-wins over user edits; no backup-before-modify; JSONC comments destroyed; `isConfigEffectivelyEmpty` deletes configs with a customised `lsp` block | `src/cli/commands/install-opencode-config.ts`, `uninstall.ts` (after split) |
| M8 | update: no size/checksum verification of downloaded binaries; old-binary backup deleted before the new binary ever runs | `src/cli/commands/update.ts` |
| M9 | MCP surface: SDK wraps tool shapes non-strict (forgetting the `reach:` wrapper on `impact_analysis`/`plan_impact` is silently accepted and scored with the built-in graph); `spec_register.status` is a free-form string regex-substituted into plan files; `withAbort` pre-aborted path orphans an eagerly-created promise (unhandled rejection, process-fatal) | `src/analysis/impact.ts`, `plan-impact.ts`, `src/spec/mcp-tools.ts`, `src/mcp/tool-runtime.ts` |
| M10 | hooks: hard-mode spec-stop-guard ignores `stop_hook_active` (infinite stop loop); 4 hooks run `main()` at module load with no `import.meta.main` guard; the CLI dispatcher REIMPLEMENTS 4 hooks and has already diverged (session-end: sidecar-first vs direct-only) | `src/hooks/spec-stop-guard.ts`, `session-end.ts`, `memory-restore.ts`, `pre-compact.ts`, `post-compact-restore.ts`, `src/cli/commands/hook.ts` |
| M11 | observation-queue: cross-process read-modify-write loses observations (no locking; a drain overwrites concurrent enqueues) | `src/sidecar/observation-queue.ts` |
| M12 | dashboard: `Access-Control-Allow-Origin: *` on a fixed port with no auth — any web page can read the entire memory DB and POST settings | `src/dashboard/server.ts` |
| Pre-req | `uninstall.ts` is 691 lines — over the 600 hard block; M7 cannot edit it until split | `src/cli/commands/uninstall.ts` |

### Out of Scope

- Known issues #3 (installer manifest), #4 (hasUnexpected dominance), #5 (TDD guard scoping), #6 (`check_diagnostics` — note M6's maintain fix must NOT quietly fix #6; different tool).
- Audit LOW-severity notes not listed above.
- `CLAUDE_PLUGIN_DATA` wiring (still one seam at a time).
- Comment-preserving JSONC editing — M7 stops at backup + skip-on-unparseable + value-matching cleanup.

## Context for Implementer

> Written for someone who has never seen this codebase.

### Length tripwires (verified on main @ v1.36.2)

| File | Lines | Constraint |
| --- | ---: | --- |
| `src/cli/commands/uninstall.ts` | **691** | 🔴 OVER THE BLOCK — Task 1 splits it before M7 |
| `src/memory/mcp-tools.ts` | **582** | 18 from block — M6's registration change must be tiny |
| `src/cli/commands/update.ts` | **577** | 23 from block — M8 may need to extract a `update-verify.ts` sibling |
| `src/sidecar/lsp-client.ts` | 502 | M1 adds real logic → **plan the split** (transport/framing out, precedent: `reach.ts`→`reach-sources.ts`) |
| `src/cli/commands/hook.ts` | 500 | M10's dedup should REMOVE lines (reimplementations → imports) |
| `src/sidecar/server.ts` / `routes.ts` | 478/461 | over warn — M2 additions must be minimal (`/health` version ≈ 2 lines) |
| `src/runtime/pidfile.ts` / `teardown.ts` | 399/397 | 1-3 from warn — M4 logic goes in a NEW sibling (`teardown-verify.ts` or extend `proc-start.ts`, 184) |
| `src/spec/parser.ts` | 386 | fence tracking ≈ 25 lines → crosses the warn; extract a `parser-fences.ts` helper if cleaner |

### Verified design facts

1. **D1:** branches are never suffixed (established by v1.36.2's H4) — `reconcile.ts:82`'s `startsWith(wanted)` arm is both wrong and useless; exact `===` only.
2. **D2:** `getSentinalHome()` exists in `src/memory/db-path.ts` (v1.36.2) and is already honoured by the DB + sidecar socket/port/pid. The 8 files above still hardcode `homedir()/.sentinal`. ⛔ `file-log.ts` is imported by hooks — it must stay dependency-light (db-path.ts imports only `node:*`, safe). `config.ts:56` is a READ path — route it too, for test determinism.
3. **M1:** the sidecar holds ONE `ctx.lspClient` for all projects (`quality-routes.ts` context); `getDiagnostics` only re-initializes when `!isReady()`, never on project change; `MAX_CONCURRENT=2` allows two projects concurrently on the same instance. The timeout path resolves with whatever arrived — `runTscLsp` then reports `ok:true, errors:[]`, and the fallback triggers only on a **thrown** "LSP diagnostics failed". Framing: `contentLength` is bytes per LSP spec but the buffer is a decoded JS string.
4. **M2:** `isSidecarReachable()` exists in `lifecycle.ts` (probes `/health`) but `autoStartSidecar` and the start command use `kill(pid,0)` only. `/health` returns `{status, pid, httpPort}` — no version. The client (`tryConnect`) accepts any responding sidecar.
5. **M4:** `proc-start.ts` (184 lines, v1.36.2) already provides start-time verification — teardown's re-verify after `down` should reuse it. The claim race fix is `writeFileSync(path, data, {flag:"wx"})` as the exclusive claim.
6. **M6:** `memory_maintain` is registered only `if (store)` — in sidecar mode it does not exist. Fix WITHOUT a new sidecar route: register always; in client mode the handler opens a scoped direct `MemoryStore` per call (it is an explicit, rare, destructive maintenance op — the cold-open cost is fine). Prune must collect doomed IDs and call the vector cleanup per ID before the raw `DELETE`.
7. **M7:** the additive-merge precedent is `deepMergeAdditive` (used for `permission`/`agent`); `mcp` merge spreads sentinal last. The documented opt-out contract is "set the value, never delete the line" (`install-opencode-config.ts:7-11`). Uninstall cleanup must only remove keys **whose values still match shipped defaults**.
8. **M9:** the SDK accepts a full `ZodObject` schema, not just a raw shape (`zod-compat` wraps raw shapes in a non-strict object). Passing `z.object(shape).strict()` closes the mis-nesting hole. `spec_register.status` gets `requiredEnum`-style validation (optional enum + the existing VERIFIED-transition guard extended to a full transition table).
9. **M10:** the fix pattern for dispatcher drift already exists — `tdd-guard`/`tool-redirect`/`stop-failure` export a `processX()` consumed by both entry points. Extract the same for session-end, memory-restore, pre-compact, post-compact-restore; `hook.ts` imports them. `stop_hook_active` is declared in `hook-output.ts:19` and consumed nowhere.
10. **M11:** enqueue is read→push→write, drain is read→send→write(failed) — no lock. Smallest sound fix: **dir-as-queue** (one file per observation, `wx` create, unlink on success) — atomic by construction, no lock file needed. The OpenCode plugin also drains this queue — check `targets/opencode/plugins/sentinal.ts` for the reader and keep the on-disk format compatible OR update both sides (plugin edit allowed; it is length-exempt but NOT parity-relevant).
11. **M12:** the dashboard UI is same-origin — the CORS headers serve no legitimate purpose. Remove them; that alone closes cross-origin reads (ACAO is what makes responses readable). POST `/api/settings` body validation is a ride-along.
12. **Test the production shape** (`{client, store: null}`) for every `{client, store}` change — the pattern whose absence shipped four bugs this month.

### Gotchas

1. **⛔ NEVER run `bunx prettier --write` project-wide or call `quality_report`** (~85 unrelated files). `--check`/`--write` touched files only.
2. **Run `bun run embed-assets` before `bunx tsc --noEmit`** (~10 spurious TS2307 otherwise).
3. **`bun run build:opencode` + embed-assets after any plugin edit** (M11 may touch the plugin's queue reader).
4. **TDD guard blocks pure extractions and brand-new modules** (7 sightings) — genuine RED, then `tdd_set_state` → `RED_CONFIRMED`; never a fake failing test.
5. **In multi-agent waves, judge the full suite only at wave boundaries** — mid-wave failures in other agents' domains are in-flight states.
6. **`SENTINAL_HOME` is set for every test run** (test-preload) — D2's tests should assert paths follow it, mirroring `db-path.test.ts`'s guard pattern.
7. Subprocess/timeout tests need explicit `it(..., timeout)` budgets (`sentinal-test-timing` skill).
8. `ps` portability: BSD `ps` has no `etimes`; `etime` is POSIX (v1.36.2 lesson) — relevant if M2/M4 touch process probing.

## Assumptions

- **M1's per-project fix can be a single serialized client that re-initializes on project change** (mutex + re-root) rather than a client-per-project map — simpler, and `MAX_CONCURRENT=2` cross-project concurrency is rare. If serialization measurably wedges the two-project case, fall back to a map. Task 6 depends on this.
- **M11's dir-as-queue is compatible with the plugin's drain loop** after updating both sides in the same task. The queue is best-effort telemetry — a one-release format break (old spool files orphaned) is acceptable IF the new code migrates/drains legacy files once. Task 10 depends on this.
- **M7's "values still match shipped defaults" comparison is computable** — the shipped defaults are constants in `install-constants.ts`/`install-opencode-config.ts`. Task 11 depends on this.
- **M2's version check is advisory** (log loudly, never refuse) — a hard refusal would strand users mid-upgrade. Task 7 depends on this.

## Testing Strategy

- Per-fix regression test failing before the fix, through real entry points; production shape (`{client, store:null}`) wherever `{client, store}` is involved.
- M5: probe-verified corpus — the parser test must include the audit's two probes (fenced `### Task` heading; duplicate positions) plus this repo's `docs/plans/` corpus sweep (the `plan-files.test.ts` precedent).
- M11: a cross-process race test (two spawned writers + a drainer) or, if too flaky, a same-process interleaving test proving the atomic property.
- Pure-move checkpoint for the uninstall split: existing tests byte-unchanged.
- Full suite ≥ **2881 pass / 0 fail**; tsc clean; `build:all` clean.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| M1's serialization wedges concurrent quality checks | Medium | Medium | Mutex has a timeout; fallback documented (client-per-project map); wedge regression test from v1.36.2 (H8) must stay green |
| M7 breaks legitimate uninstall cleanup (leaves junk behind) | Medium | Medium | Value-matching removal still removes untouched defaults; tests cover both customised-preserved and default-removed |
| M10's dispatcher dedup changes live hook behaviour (the dispatcher IS what runs) | Medium | High | The extraction must preserve the DISPATCHER's current behaviour where the two diverge (it is the shipped path), noting each divergence resolved; live-smoke checklist after |
| M11 format change strands old spool files | Medium | Low | One-time legacy drain on first new-format run |
| Strict schemas (M9) reject payloads agents currently send successfully | Low | Medium | The only newly-rejected shapes are mis-nested keys that were silently WRONG before; contract test re-run confirms all shipped examples still parse |
| Wave collisions | Low | High | File-disjointness table below; only Task 1→11 dependency crosses waves |

## Pre-Mortem

1. **M1 is too big for one task** (re-root + serialize + timeout-distinction + byte-framing + split) → Trigger: the lsp-client diff exceeds ~300 changed lines or the split turns behavioural. Fallback: land re-root+serialize+timeout (the correctness set) and defer byte-framing to a follow-up — framing bugs need multibyte payloads, rarer in practice.
2. **M10's divergences are load-bearing** (the dispatcher's session-end stops the sidecar; the standalone doesn't) → Trigger: extraction forces choosing between behaviours with user-visible consequences. Resolution rule: the dispatcher's behaviour wins (it ships); document each choice in the task report.
3. **M11's plugin-side drain can't be updated compatibly** → Trigger: plugin drain loop assumes the single-file format in a way the dir format can't satisfy. Fallback: keep the single file but add an advisory lock (`wx` lockfile with stale-age takeover).
4. **M7's default-matching misfires on nested structures** (deep equality vs key order) → Trigger: tests show a byte-different but semantically-equal value treated as customised. Acceptable failure direction (preserves too much rather than deleting user config) — document, don't chase.

## Execution Waves

**Wave 1** — pre-req + small independents: Task 1 (split uninstall), Task 2 (D1+M3 worktree hardening), Task 3 (M4 runtime hardening), Task 4 (M9 MCP surface), Task 5 (M12 dashboard).
**Wave 2** — the meat: Task 6 (M1 LSP), Task 7 (M2 sidecar lifecycle), Task 8 (M5 parser), Task 9 (M6 memory), Task 10 (D2+M11 paths+queue).
**Wave 3** — config/update/hooks: Task 11 (M7, needs Task 1), Task 12 (M8 update), Task 13 (M10 hooks dedup).

**File-disjointness:** T6 owns `lsp-client.ts`+`quality-routes.ts`+`quality-runners.ts` (including the D2 tsbuildinfo path in quality-runners — T10 must NOT touch it); T7 owns `sidecar/lifecycle.ts`+`routes.ts`+`server.ts`+`client.ts`+CLI sidecar cmd; T10 owns the other D2 files + `observation-queue.ts` + the plugin's queue reader. No parity fixtures anywhere. Wave 3: T11 `install-opencode-config.ts`+uninstall siblings; T12 `update.ts`; T13 hooks+`hook.ts` — disjoint.

## Goal Verification

### Truths

1. `reconcile.ts` resolves `add` without matching `add-auth` — test fails before.
2. With `SENTINAL_HOME` set, ALL of: file-log, observation-queue, quality-runners tsbuildinfo, auto-decay, embeddings cache, native-deps, dashboard pidfile, dashboard-ensure, config path resolve under it — extending the `db-path.test.ts` guard; fails before.
3. Two sequential quality checks for different projects produce diagnostics rooted at each project (M1) — fails before (second project gets first project's root).
4. An LSP run receiving ZERO publishDiagnostics notifications falls back to subprocess tsc instead of reporting 0 errors — fails before.
5. `autoStartSidecar` with a stale pidfile pointing at a recycled live PID still starts a sidecar (reachability, not liveness) — fails before.
6. `/health` includes `version`; the client logs on mismatch — fails before.
7. cleanup `--force` refuses when `current_worktree` is a SUBDIRECTORY of the target; the default pass with a `projectPath` never touches another repo's branches — both fail before.
8. Teardown re-verifies after `down`; a failed SIGKILL returns `ok:false` and keeps the pidfile — fails before.
9. A fenced `### Task 99` heading does NOT become a task; duplicate positions dedupe with consistent counts — both fail before (audit probes).
10. Prune removes the pruned observations' vector rows; `memory_maintain` is listed via a real `Client` with `{client, store:null}` — both fail before.
11. `sentinal update`'s config cycle preserves a user's `permission.skill` opt-out and a user's pinned `mcp` server value — fails before.
12. A downloaded binary whose byte-count mismatches the asset size is rejected and the backup retained until `--version` succeeds — fails before.
13. `impact_analysis` called with top-level `moduleCount` (mis-nested, no `reach:` wrapper) is REJECTED, not silently scored built-in — fails before. All 10 shipped example payloads still parse.
14. `spec_register` with `status: "bogus"` is rejected by enum — fails before.
15. A pre-aborted `withAbort` does not produce an unhandled rejection — fails before.
16. Hard-mode stop-guard with `stop_hook_active: true` does not deny; all four module-load hooks carry `import.meta.main`; `hook.ts` imports (not reimplements) the four extracted `processX` functions — fail before.
17. Two concurrent enqueues + a drain lose zero observations (M11) — fails before.
18. Dashboard responses carry NO `Access-Control-Allow-Origin` header — fails before.
19. `bun test` ≥ 2881 / 0 fail; tsc clean; `build:all` clean; every touched non-test file < 600 (new files < 400); `uninstall.ts` < 400.

## Progress Tracking

- [x] Task 1: Split `uninstall.ts` (691 → 300/303/152) — pure move (Wave 1) — `0f168ce`; Task 11's surface exported from `uninstall-opencode-config.ts`
- [x] Task 2: D1 + M3 — worktree hardening (Wave 1) — `08fc451`, 4 REDs
- [x] Task 3: M4 — runtime teardown/up hardening (Wave 1) — `da2d4f9`; new `teardown-verify.ts` (182) + `pidfile-claim.ts` (172); graceMs capped 10min
- [x] Task 4: M9 — MCP surface hardening (Wave 1) — `009d686`; premise CONFIRMED and SHARPENED (see notes)
- [x] Task 5: M12 — dashboard CORS removal (Wave 1) — `def83a0`; same-origin audit clean (htmx relative URLs; non-browser pollers unaffected by CORS)
- [x] Task 6: M1 — LSP correctness (Wave 2) — `beabe34`; all 4 premises CONFIRMED; M1d LANDED (not deferred); lsp-client 502→397 + lsp-transport 262
- [x] Task 7: M2 — sidecar lifecycle integrity (Wave 2) — `d687c9d`; lifecycle split 291+214; residual race window (a) reported
- [x] Task 8: M5 — parser fences + dupes (Wave 2) — `8a3913e`; corpus 548→542 tasks (see notes); parser-fences.ts 61
- [x] Task 9: M6 — prune vectors + maintain registration (Wave 2) — `3f1a035`; mcp-tools split 268/175/161/95 + vector-cleanup 50; WAL concurrency verified; catalog counts correct as-is
- [x] Task 10: D2 + M11 — SENTINAL_HOME + queue atomicity (Wave 2) — `0f041f9`; all 8 premises confirmed; plugin needed NO edit (imports the shared module)
- [x] Task 11: M7 — config-writer safety (Wave 3) — `f8e57cc`; all 5 premises confirmed; Truth 11 end-to-end cycle green
- [x] Task 12: M8 — update binary verification (Wave 3) — `2a81b33`; streaming SHA-256; .bak kept until --version smoke passes
- [x] Task 13: M10 — hooks consistency + dispatcher dedup (Wave 3) — `857f41f`; hook.ts 500→324; carve-out pinned; live-smoke caught+fixed a pre-existing dispatcher exit-1 on empty input

**Total Tasks:** 13 | **Completed:** 13 | **Remaining:** 0

**Final: 3091 pass / 0 fail** (baseline at plan start 2881, +210). tsc clean; build:all + build:cli clean.

### Wave 3 outcomes

- **⚠️ T12's RED run REPLACED THE REAL INSTALLED BINARY** — pre-fix `downloadAndInstall` had no options param, so the mocked-fetch argument was silently ignored and the test did a real GitHub download over `~/.sentinal/bin/sentinal`. Verified healthy (it installed the genuine v1.36.2; `--version` clean). A live demonstration of M8 itself. Post-fix the tests run fully offline.
- **T11 plan contradiction:** the plan said explore/general task permissions were "Sentinal never wrote" — FALSE, the embedded opencode.json agent blocks DO ship them. The never-touch rule was implemented anyway (generic names cannot be attributed). Side effect: pristine install→uninstall now leaves agent task-permission keys behind — the acceptable Pre-Mortem 4 direction.
- **T13:** after the carve-out, NO hook stops the sidecar at all — lifecycle rests entirely on the sidecar's own session-aware shutdown (T7's domain) plus the MCP server's direct-mode path. Deliberate. Live-smoke caught a pre-existing dispatcher bug (session-end exit 1 on `{}` — `join(undefined,...)` outside the try), fixed RED-first.
- **T11 observations (pre-existing, not fixed):** uninstall leaves `permission.bash` (pkill*/killall*) and the `.sentinal/rules/*.md` instructions entry behind — neither in M7's key list. → Deferred.

### Wave 2 outcomes (3017 pass / 0 fail, tsc clean, build:opencode clean at boundary)

- **⚠️ The LSP fast path has likely NEVER produced real diagnostics on this repo** — tsserver's project load exceeds the window, zero notifications arrive, and the old code resolved `[]`; the pre-existing "returns diagnostics as an array" test was passing VACUOUSLY through the mute path. Now pinned honestly (mute → "LSP diagnostics failed" → tsc fallback).
- **T7 contradiction resolved:** M2b's reachable-branch `/health` pid match is impossible synchronously (fetch has no sync form) — identity for BOTH branches comes from the `ps` argv probe (`/(^|\s)sidecar\s+start(\s|$)/`, verified against all three real spawn shapes). A serving sidecar's argv matches anyway; a wedged one can't answer `/health` at all.
- **T7 ride-along:** `isSidecarReachable()`'s PID-only fallback (bare pidfile, no port/socket file) now returns false — that fallback was Truth 5's bug through a second door. Booting grace: pidfile younger than 10s + live-but-unreachable = booting (port file is written BEFORE the pidfile, so this is sound).
- **T8 corpus deltas:** `PLAN-spec-workflow.md` 5→0 (genuine phantoms — an example spec inside a ```markdown fence). ⚠️ `2026-04-20-spec-verify-full-tsc.md` 2→1 is NOT a phantom: a stray unclosed fence at line 131 swallows a real historical task — the parser is faithful to the RENDERED document (GitHub renders it fenced too); a doc-fix there would restore it. Corpus has zero real duplicate positions — M5b is protection against a synthetic-but-plausible class.
- **T10 contradiction (Gotcha 6 assumption FALSE for the preload's own import graph):** `test-preload.ts`'s ESM import of `vector-store.js` is hoisted above the `SENTINAL_HOME` assignment and transitively evaluates `native-deps.ts` first — load-time constants there freeze to the real `~/.sentinal`. Hence `getDepsDir()` (fresh-read) with `DEPS_DIR` kept as a deprecated load-time alias.
- **T6:** `LspClient` gained an options seam (`command`, `diagnosticsTimeoutMs`, `mutexTimeoutMs`) — backward compatible, the documented fake-server test seam. `quality-routes.ts` needed zero code changes (its fallback branch was already correct once `getDiagnostics` throws honestly).

## Deferred Issues (appended by Wave 3)

- Uninstall leaves `permission.bash` (`pkill*`/`killall*`) and the `.sentinal/rules/*.md` `instructions` entry behind (T11 observation; adjacent to issue #3's manifest work).

## Deferred Issues (appended by Wave 2)

- `setup.ts` / `setup-bundle.ts` still consume the deprecated load-time `DEPS_DIR` — migrate to `getDepsDir()`.
- `test-preload.ts` import-hoisting defeats the seam for load-time constants in its own import graph — `await import()` after the env assignment would fix it.
- T7 residual race window (a): manual `sentinal sidecar start` doesn't take the start lock — closing it touches `startSidecar`'s startup contract.
- `docs/plans/2026-04-20-spec-verify-full-tsc.md` has a stray unclosed fence at line 131 swallowing its Task 2 heading — doc-fix restores the historical task count.

### Wave 1 outcomes (2933 pass / 0 fail, tsc clean at boundary)

- **⚠️ M9a premise CONFIRMED but SHARPENED:** the SDK honours `.strict()` only via `registerTool()` — the deprecated 4-arg `tool()` overload treats a full ZodObject as *annotations* and **drops validation entirely**. Both reach tools migrated to `registerTool()`; `server.tool`-patching capture helpers gained an additive `registerTool` intercept (incl. a justified ride-along in `src/test-helpers.ts`).
- **M9b transition table is gated-entry:** any target NOT listed is reachable from everywhere; `COMPLETE` requires the implementing family, `VERIFIED` requires the complete family. `COMPLETE→PENDING` (verify loop-back) verified legal and pinned.
- **M4a nuance:** `owned→stale` verdict flip during `down` deliberately PROCEEDS (that's `down` succeeding); the `maySignalGroup` gate arbitrates. A fresh `starting` record younger than the startup budget now FAILS preflight instead of being "recovered" — recovery there was the claim race in a different coat.
- **T2 flagged:** `src/cli/commands/worktree.ts:263` (`sentinal worktree cleanup`) calls `manager.cleanup()` with no options — stays on the global sweep. → Deferred.
- **T5 found pre-existing dashboard bugs (out of scope, not fixed):** the settings Save form posts urlencoded but the handler always did `req.json()` — the browser Save button 400s today; `/api/settings/reset` and `/api/sessions/cleanup` buttons 404 (routes don't exist). → Deferred.

## Deferred Issues

- `src/cli/commands/worktree.ts:263` — CLI cleanup unscoped; add `-p/--project` like the sibling `detect`.
- Dashboard: settings form content-type mismatch (Save 400s); missing `/api/settings/reset` + `/api/sessions/cleanup` routes (buttons 404). Pre-existing, found by T5.

**⛔ Premise confirmation (Tasks 6, 10, 11 and M9a):** unlike the HIGHs, most MEDIUM premises were NOT independently re-verified. Each of those tasks' FIRST step is to confirm its premise against source (the specific claimed lines/behaviours); if a premise is wrong, adapt and report — do not implement a fix for a bug that does not exist. (M2, M6, M10 premises were review-verified already.)

## Implementation Tasks

### Task 1: Split `uninstall.ts` (691 → <400) — pure move

**Objective:** Clear the hard block so M7 can edit the cleanup logic.
**Wave:** 1 · **Dependencies:** None
**Files:** `src/cli/commands/uninstall.ts` + new sibling(s) (e.g. `uninstall-opencode.ts`, `uninstall-claude.ts`)

- **⛔ PURE MOVE.** Existing uninstall tests byte-unchanged (`git diff --exit-code`). Precedents: `spec/mcp-tools.ts` (parent keeps entry point) or `sidecar/client.ts` (inverted inheritance) — pick the smallest diff. Public surface (`registerUninstallCommand` or equivalent) unchanged; check `src/cli/index.ts` wiring stays untouched.
- Every piece < 400. Full suite green; tsc clean.

**Verify:** `git diff --exit-code -- 'src/cli/commands/uninstall*.test.ts' 2>/dev/null; bun test src/cli/`

### Task 2: D1 + M3 — worktree hardening

**Wave:** 1 · **Dependencies:** None
**Files:** `src/worktree/reconcile.ts`, `cleanup.ts`, `cleanup-mcp-tool.ts`, `manager.ts`, their tests

- **D1:** `reconcile.ts:82` `w.branch.startsWith(wanted)` → `w.branch === wanted` (branches never suffixed — v1.36.2 H4 finding). RED: `add` disk-scan must not adopt `add-auth`'s worktree.
- **M3a (guard 3):** `cleanup.ts` guard 3 uses exact path equality — replace with `isInside(current, gwt.path) || equal` using the existing helper (`disk-scan.ts` has the strictly-inside logic). RED: `current_worktree` = `<target>/src` must refuse `--force`.
- **M3b (global pass):** the default cleanup pass iterates `store.listAll("active")` globally — scope to the provided `projectPath`'s repo root when given (`getRepoRoot` exists). Unscoped invocation keeps global behaviour. RED: cleanup in project A must not `branch -D` in project B.
- **M3c (abandon):** after the `rmSync` fallback, verify `!existsSync(wt.worktreePath)` before writing `abandoned`; on survival throw `REMOVE_FAILED` (mirror the merge path's discipline). RED: simulated rm failure must NOT free the slot.
- `manager.ts` is 384 — watch the warn; extract if needed.

**Verify:** `bun test src/worktree/`

### Task 3: M4 — runtime teardown/up hardening

**Wave:** 1 · **Dependencies:** None
**Files:** `src/runtime/teardown.ts` (397), `lifecycle.ts`, `pidfile.ts` (399), tests; new logic into a NEW sibling or `proc-start.ts` (184) — **both big files are 1-3 lines from the warn**

- **M4a:** re-run the ownership verdict (`inspectPidfile`/`maySignalGroup`) AFTER the declared `down` completes, before signalling; cap `graceMs` (schema change — pick a defensible max, e.g. 10 min, documented). Reuse `proc-start.ts`'s start-time verification in the re-check.
- **M4b:** after SIGKILL, re-probe liveness; if still alive or the signal failed with non-ESRCH → keep the pidfile, return `ok:false, stopped:false` (the module's own doctrine: never delete a record while the group may live). RED: EPERM-style failure must not delete the pidfile.
- **M4c:** `runtime_up`'s claim: `writeFileSync(..., {flag:"wx"})` for the initial `starting` pidfile — EEXIST → re-run preflight (someone else claimed). RED: two concurrent claims → exactly one wins, the loser reports.

**Verify:** `bun test src/runtime/`

### Task 4: M9 — MCP surface hardening

**Wave:** 1 · **Dependencies:** None
**Files:** `src/analysis/impact.ts`, `plan-impact.ts`, `src/spec/mcp-tools.ts`, `src/mcp/tool-runtime.ts`, tests

- **M9a:** pass `.strict()` `ZodObject`s as the tool schema for `impact_analysis` and `plan_impact` (the SDK accepts full schemas; raw shapes get wrapped non-strict). RED: top-level `moduleCount` (mis-nested) currently accepted-and-ignored → must reject naming the key. **Contract check:** the 10 shipped example payloads still parse (the existing `sync-graph-tools.test.ts` contract test must stay green); the emitted `inputSchema` unchanged (assert via `listTools`).
- **M9b:** `spec_register.status` → optional enum of the real statuses (`PENDING|IN_PROGRESS|COMPLETE|VERIFIED|...` — enumerate from `SpecSchema`/parser first); extend the existing VERIFIED-transition guard into an explicit transition table (document which transitions are legal and why). Use `requiredEnum`'s sibling pattern for optional enums (missing → fine; wrong → clear error).
- **M9c:** `tool-runtime.ts` pre-aborted path: `promise.catch(() => {})` before returning the early rejection. RED: pre-aborted `withAbort` around a rejecting promise → no unhandled rejection (assert via `process.on("unhandledRejection")` capture in the test).

**Verify:** `bun test src/analysis/ src/spec/ src/mcp/ src/cli/sync-graph-tools.test.ts`

### Task 5: M12 — dashboard CORS removal

**Wave:** 1 · **Dependencies:** None
**Files:** `src/dashboard/server.ts` (263), `src/dashboard/routes/api.ts` (ride-along), tests

- Remove `Access-Control-Allow-Origin: *` (and any ACAM/ACAH) — the UI is same-origin; the headers only enable hostile pages. RED: response headers must not contain ACAO.
- Ride-along: validate the `/api/settings` POST body (shape-check known keys; reject unknown top-level keys) — small, same file family.
- Check the dashboard UI actually is same-origin (`rg -n 'fetch\(' src/dashboard/views/` or the client JS) — if anything legitimately cross-origin exists, STOP and report rather than breaking it.

**Verify:** `bun test src/dashboard/`

### Task 6: M1 — LSP correctness

**Wave:** 2 · **Dependencies:** None
**Files:** `src/sidecar/lsp-client.ts` (502 — **plan the split**: framing/transport to `lsp-transport.ts`), `quality-routes.ts` (145), `quality-runners.ts` (375 — includes its D2 tsbuildinfo path, THIS task owns it), tests

- **M1a (re-root):** `getDiagnostics` re-initializes when `projectPath !== this.projectPath` (shutdown + initialize). RED: project B after project A must produce B-rooted diagnostics.
- **M1b (serialize):** a per-instance mutex around the diagnostics cycle so two projects can't interleave `diagnosticsMap.clear()`. Assumption 1: single serialized client; timeout on the mutex so a wedged run can't queue forever (v1.36.2's H8 wedge test must stay green).
- **M1c (timeout distinction):** track whether ANY publishDiagnostics notification arrived; zero notifications at deadline → treat as failure so `runTscLsp`'s caller falls back to subprocess tsc. RED: Truth 4.
- **M1d (byte framing):** buffer raw bytes (`Uint8Array`), decode only complete messages per the Content-Length byte count. RED: a synthetic message with multibyte chars must parse cleanly. (Pre-Mortem 1 fallback: if the task balloons, defer M1d — its explicit landing site is a NEW Wave-3 task the orchestrator adds to the plan, not a silent drop; the report must say which.)
- **D2 ride-along:** route `quality-runners.ts:53-54` tsbuildinfo paths through `getSentinalHome()`.

**Verify:** `bun test src/sidecar/`

### Task 7: M2 — sidecar lifecycle integrity

**Wave:** 2 · **Dependencies:** None
**Files:** `src/sidecar/lifecycle.ts` (231), `routes.ts` (461 — minimal), `server.ts` (478 — minimal), `client.ts` (327), the CLI sidecar command, tests

- **M2a:** `autoStartSidecar` + the start command use `isSidecarReachable()` (already exists) instead of `kill(pid,0)`; a live-but-unreachable PID → clean the stale files and start. RED: Truth 5.
- **M2b (review-corrected design):** `stopSidecarProcess` verifies identity before signalling. Reachable → `/health`'s `pid` must match the pidfile's, then signal. **Unreachable is NOT proof of death** — a wedged sidecar is alive but not serving, and silently removing its files would orphan a live process (the half-applied version of M4b's doctrine). So: unreachable → check the PID's identity via `ps -p <pid> -o command=` — if the argv looks like a sentinal sidecar (`mcp-server`/`sidecar` marker), it is ours-but-wedged: SIGNAL it, then clean files; if the argv is something else or `ps` fails, the PID is recycled/unknown: remove the stale files and do NOT signal. Note the sync→async ripple: `stopSidecarProcess` is currently sync with ~4 call sites — audit each caller when making it async (or use `spawnSync` for the ps probe to stay sync; prefer staying sync).
- **M2c:** add `version` (from the package/build constant — find how `getVersion()` works, the dashboard already uses it) to `/health`; `tryConnect` logs loudly on mismatch (advisory — never refuse, Assumption 4).
- **M2d (best-effort):** close the start TOCTOU with a `wx` lockfile around spawn (mirror M4c's pattern); EEXIST with a stale lock (age > threshold) → take over. Keep it simple; report if the race window can't be fully closed without larger surgery.

**Verify:** `bun test src/sidecar/`

### Task 8: M5 — plan parser fences + duplicate positions

**Wave:** 2 · **Dependencies:** None
**Files:** `src/spec/parser.ts` (386 — extract `parser-fences.ts` if the warn is crossed), tests

- **M5a:** track ``` fences in a single pass; skip fenced lines in ALL extractors (task headings, checkbox scan, metadata — a fenced `Status:` line is also matchable today). RED: the audit's probes — a fenced `### Task 99` in `## Progress Tracking` and a fenced task heading must not become tasks.
- **M5b:** dedupe duplicate positions at parse time (LAST wins, consistently — document why) and derive `task_count` from the deduped set. RED: `Task 1` twice → 2 tasks total, counts consistent.
- **Corpus sweep:** parse every `docs/plans/*.md` in this repo without throwing; report count deltas vs the current parser (fence fixes may legitimately REMOVE phantom tasks from historical plans — list which).
- ⚠️ `plan-files.ts` (analysis) has its OWN fence handling — do NOT touch it; note any divergence for a future unification.

**Verify:** `bun test src/spec/`

### Task 9: M6 — prune vector cleanup + maintain registration

**Wave:** 2 · **Dependencies:** None
**Files:** `src/memory/store.ts` (291), `mcp-tools.ts` (**582 — 18 from block; keep the change tiny or split first**), `vector-store.ts` (291), `service.ts`, tests

- **M6a:** every prune path collects doomed IDs first and calls `vectorStore.removeObservation(id)` per ID before the raw `DELETE` (three paths: `store.prune`, `memory_maintain`'s raw DELETE, CLI `service.prune`). RED: after prune, `observation_vectors` has no rows for pruned IDs.
- **M6b:** register `memory_maintain` unconditionally; in client mode the handler opens a scoped direct `MemoryStore` per call (destructive maintenance op — cold-open cost acceptable; document why no sidecar route). RED: Truth 10's `listTools` check with `{client, store:null}`. Add the DESTRUCTIVE flag to its description (repo rule; the audit flagged its absence).
- **⛔ Split `mcp-tools.ts` FIRST, unconditionally** (review-mandated: 18 lines of headroom will not survive M6b's registration change plus a DESTRUCTIVE-flag description edit). Pure-move mini-step: extract by cohesion (e.g. `maintain-mcp-tools.ts`), existing tests byte-unchanged, then apply M6a/M6b. Precedent: `spec/mcp-tools.ts` split.

**Verify:** `bun test src/memory/`

### Task 10: D2 + M11 — SENTINAL_HOME routing + queue atomicity

**Wave:** 2 · **Dependencies:** None
**Files:** `src/utils/file-log.ts`, `src/sidecar/observation-queue.ts`, `src/memory/auto-decay.ts`, `embeddings.ts`, `native-deps.ts`, `src/dashboard/lifecycle.ts`, `src/opencode/dashboard-ensure.ts`, `src/memory/config.ts` (getConfigPath), `targets/opencode/plugins/sentinal.ts` (queue reader ONLY), tests — **NOT `quality-runners.ts` (Task 6 owns it)**

- **D2:** route every listed path through `getSentinalHome()` (import from `src/memory/db-path.ts` — it is `node:*`-only, hook-safe). Extend the `db-path.test.ts`-style guard: with `SENTINAL_HOME` set, each resolved path is under it (Truth 2). ⚠️ `file-log.ts` and `dashboard/lifecycle.ts` are hook/plugin-reachable — verify no new heavy imports (bundle-grep if in doubt).
- **M11:** dir-as-queue — one file per observation (`wx`-created, timestamped-unique name), drain lists + sends + unlinks per file; a failed send leaves its file. One-time legacy drain: if the old single-file spool exists, ingest then delete it. Update the plugin's reader to match (both sides in this task; rebuild via `bun run embed-assets && bun run build:opencode`). RED: interleaved enqueue-during-drain loses nothing (Truth 17). Pre-Mortem 3 fallback: advisory `wx` lockfile if the dir format can't work for the plugin.
- Cap: queue keeps its bounded drop-oldest semantics (count files, drop oldest beyond 50).

**Verify:** `bun test src/sidecar/observation-queue.test.ts src/utils/ src/memory/db-path.test.ts src/dashboard/ src/opencode/ 2>/dev/null || bun test src/sidecar/ src/utils/ src/memory/` — scoped to owned domains (Gotcha 5: full-suite and `build:opencode` are judged at the WAVE BOUNDARY by the orchestrator, not mid-wave — a mid-wave plugin build would bake in-flight T6/T7 sidecar state into the bundle).

### Task 11: M7 — config-writer safety

**Wave:** 3 · **Dependencies:** Task 1
**Files:** `src/cli/commands/install-opencode-config.ts` (128), the uninstall sibling(s) from Task 1, tests

- **M7a:** `mcp` merge becomes additive with ONE exception — the `sentinal` entry is force-updated (its binary path must track the install); the other four managed servers: only added if absent, user edits (pins, `enabled:false`) preserved. Document the exception.
- **M7b:** uninstall cleanup removes a managed key ONLY if its current value deep-equals the shipped default; customised values are left with a note in the output. `permission.skill`/`docs/plans` edit keys/task permissions: same rule. `explore`/`general` task permissions Sentinal never wrote: never touched.
- **M7c:** backup-before-modify (`.bak`, latest-wins — the v1.36.2 H7 pattern) in BOTH `writeOpenCodeConfig` and the uninstall cleanup; unparseable config → skip with a warning, never "start fresh"; shape-validate before every cast (`plugin` as string[], `instructions` as string[], `mcp` as object — the audit's TypeError list).
- **M7d:** `isConfigEffectivelyEmpty` treats a customised `lsp` block as content (compare against the shipped default before calling it empty).
- RED: Truth 11 — a full update cycle (uninstall-cleanup + reinstall-merge) preserves a user opt-out AND a pinned server value; both fail today.

**Verify:** `bun test src/cli/`

### Task 12: M8 — update binary verification

**Wave:** 3 · **Dependencies:** None
**Files:** `src/cli/commands/update.ts` (**577 — 23 from block**; extract `update-verify.ts` if needed), tests

- Verify `downloaded bytes === asset.size` before install; if the release publishes `checksums.txt` (it does — 5 assets incl. checksums), fetch and verify the SHA too (best-effort: missing checksum file → size-only + note).
- Keep the old binary's `.bak` until the NEW binary passes a `--version` smoke exec; only then delete. Failure at any step → restore `.bak`, report.
- RED: truncated download (size mismatch) → rejected, old binary intact; new-binary-fails-to-exec → rolled back.

**Verify:** `bun test src/cli/`

### Task 13: M10 — hooks consistency + dispatcher dedup

**Wave:** 3 · **Dependencies:** None
**Files:** `src/hooks/spec-stop-guard.ts`, `session-end.ts`, `memory-restore.ts`, `pre-compact.ts`, `post-compact-restore.ts`, `src/cli/commands/hook.ts` (500), tests

- **M10a:** hard-mode stop-guard early-returns when `input.stop_hook_active === true` (the declared-but-unconsumed loop breaker). RED: hard mode + flag → no deny.
- **M10b:** add `if (import.meta.main)` guards to the four module-load hooks. RED: importing each module must not consume stdin/execute (test via a child `bun -e 'import(...)'` with a timeout, or refactor so `main()` is only referenced under the guard and assert exportability).
- **M10c:** extract shared `processX()` for session-end, memory-restore, pre-compact, post-compact-restore (the `tdd-guard` pattern); `hook.ts` imports them, deleting its reimplementations. **Divergence resolution rule: the DISPATCHER's behaviour wins (it is what ships) — with ONE review-mandated carve-out.** The dispatcher's `runSessionEnd` (`hook.ts:97-130`) calls `stopSidecarProcess()` in two paths; the standalone never touches the sidecar. Post-v1.36.2 (H1), the sidecar owns its own lifecycle via session-aware shutdown — a hook-side stop is redundant and racy with other live sessions, the exact class H1 removed from the MCP server. **For this divergence the STANDALONE behaviour wins: the extracted `processSessionEnd` must NOT stop the sidecar.** List every other divergence resolved (dispatcher-wins) in the report. `hook.ts` should SHRINK. Add a test pinning that session-end does not call `stopSidecarProcess`.
- **Live-smoke after** (the `sentinal-live-smoke` skill): `echo '{}' | bun src/cli/index.ts hook shared <name>` for each affected hook — confirm no crash and expected no-op output.

**Verify:** `bun test src/hooks/ src/cli/`
