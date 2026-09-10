# Changelog Top-4 Adoption Implementation Plan

Created: 2026-07-17
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: Yes
Type: Feature

## Summary

**Goal:** Adopt the four highest-value capabilities from the CC 2.1.143→2.1.185 / OC 1.15.11→1.18.3 changelog audit: (1) soft `additionalContext` stop-guard + `background_tasks` awareness, (2) OpenCode plugin `dispose` teardown + spike-gated V2/namespaced API migration, (3) OpenCode SDK active-sessions as an authoritative source for the session-aware stop-guard (with sidecar fallback), (4) explicit MCP timeouts + abort-signal/progress support on slow tools.

**Architecture:** Dual-target (CC compiled hooks + OC native plugin) with a shared sidecar and MCP server. Most logic is extracted into testable `src/**` modules; target files (`hooks.json`, `sentinal.ts`, `opencode.json`, `.mcp.json`) are thin wiring. A hard **spike gate** (Task 1) determines whether the full OC V2 migration proceeds or falls back to a legacy-plugin `dispose`-equivalent.

**Tech Stack:** TypeScript (strict, ES2022), Bun ≥1.0, `bun:test`, `@modelcontextprotocol/sdk` 1.27.1 (confirmed: supports `extra.signal`/`extra.sendNotification`/`extra._meta.progressToken`), OpenCode plugin runtime (V2 = Effect-based `@opencode-ai/plugin/v2/{effect,promise}` — NOT installed; types hand-written inline).

## Scope

### In Scope

- **#1 CC stop-guard soft block:** replace `denyExit` with a soft `additionalContext` (exit 0) path; consume `background_tasks`/`session_crons` to skip blocking when real background work is in flight; add a `stopContext()` helper.
- **#2a OC dispose teardown:** give the OpenCode plugin a real teardown path (the `dispose` capability, OC v1.15.11) that flushes/stops the sidecar cleanly — replacing the ad-hoc `session.deleted` shutdown.
- **#2b OC V2 migration — SPIKE-GATED (Task 1):** only proceed to the full Effect/Promise V2 plugin migration if the spike proves OpenCode 1.18.3 loads a V2/Promise plugin AND exposes the needed client surface. Otherwise fall back to #2a on the legacy plugin.
- **#3 OC SDK active sessions:** make the `session.idle` stop decision consult the OpenCode SDK's active-sessions API (OC v1.17.12) as the authoritative liveness source, falling back to `MemoryStore.isSessionAlive` when unavailable. ⚠️ OC `session.idle` is **advisory-only** (warn log; OpenCode has no deny/exit-2 equivalent) — this improves *warning accuracy*, not hard enforcement.
- **#4 MCP hardening:** set explicit per-server/per-tool timeouts in `opencode.json` + `.mcp.json`; add `extra.signal` abort handling + progress emission to `memory_search` and `quality_report`.

### Out of Scope

- OC "yolo mode" bypass detection (changelog v1.17.12) — noted as future work; not in top-4.
- Session custom metadata storage (OC v1.15.13) — future optimization, not top-4.
- MCP resource templates / code-mode adapter (OC v1.17.10/v1.17.14) — future.
- Config-driven model routing (separate parked plan — untouched).
- Full rewrite of every MCP tool for abort/progress — only the two slow tools (`memory_search`, `quality_report`).

## Context for Implementer

> Written for an implementer who has never seen this codebase.

- **Dual-target rule:** shared logic in `src/**`, target wiring in `targets/**`. Every behavior change needs both targets addressed where applicable. See `.sentinal/rules/sentinal-dual-target.md`.
- **`hooks.json` is embedded:** `targets/claude-code/hooks/hooks.json` is also embedded verbatim in `src/cli/embedded-assets.ts` (generated). After editing `hooks.json`, re-run `bun run embed-assets` (via `scripts/embed-assets.mjs`) — never hand-edit `embedded-assets.ts`.
- **OC plugin export invariant:** `targets/opencode/plugins/sentinal.ts` must export ONLY the plugin function (default + same-ref named). OpenCode invokes every function export as a plugin factory (`getLegacyPlugins`). All helpers live in `src/opencode/*.ts` or `targets/opencode/plugins/sentinal-helpers.ts`. Guarded by `src/opencode/plugin-exports.test.ts`. (`sentinal.ts:179-183`)
- **OC plugin is file-length exempt** (`PATH_EXEMPTIONS` in `src/utils/file-length.ts:14-16`), currently 1172 lines — but DRY still applies: extract new logic to `src/opencode/*.ts` for testability, not to reduce line count.
- **Stop-guard current output (#1):** `src/hooks/spec-stop-guard.ts:70` calls `denyExit(reason)` → `process.exit(2)` (hard block). `hook-output.ts` helpers: `hint(eventName, context)` returns `{ hookSpecificOutput: { hookEventName, additionalContext } }` (object only, no exit); `output(data)` writes stdout (no exit); `denyExit`/`blockExit` write stderr+stdout then `process.exit(2)`. To go soft: `output(hint("Stop", reason))` at exit 0. `HookInput.background_tasks`/`session_crons` are typed as `unknown[]` (`hook-output.ts:27,29`) but never read.
- **Decision layer (#1/#3):** `src/spec/ownership.ts` `resolveStopDecision(input): StopDecision` is the single source of truth for both targets. `StopDecisionInput { searchDir, currentSessionId, store }`, `StopDecision { block, reason? }`. It does NOT see `background_tasks` (those live on `HookInput`, consumed in the hook layer). `#3` adds an optional liveness-source injection so the OC side can pass SDK-derived active sessions.
- **OC session.idle current logic (#3):** `sentinal.ts:1114-1144` opens `new MemoryStore()`, touches the session, calls `resolveStopDecision`, closes the store, logs via `client.app.log` if blocked. The `client` object today exposes ONLY `app.log` + `session.messages` — session-list/event-subscribe are UNVERIFIED (not in `targets/opencode/types/opencode-plugin.d.ts`).
- **OC teardown current state (#2a):** no `dispose` hook. Teardown is inline in the `session.deleted` branch (`sentinal.ts:1084-1093`): `sidecar.endSession` → `getActiveSessions()` → if 0, `stopDashboard()`+`stopSidecar()`. `SidecarClient` has NO `close()` method (stateless fetch client); shutdown is via `stopProcess("sidecar.pid")` SIGTERM.
- **MCP tools (#4):** `server.tool(name, desc, zodShape, handler)` in `src/mcp/server.ts`. Handlers currently use `async ({args}) => ...` and OMIT the SDK's 2nd `extra` param. `extra: RequestHandlerExtra` provides `.signal: AbortSignal`, `.sendNotification(...)`, `._meta.progressToken` (SDK 1.27.1, confirmed). `memory_search` (`src/memory/mcp-tools.ts:73-90`) runs `@xenova/transformers` embeddings on cold path. `quality_report` (`src/analysis/mcp-tools.ts:355-375`) spawns tsc/eslint/prettier via sidecar `/quality-check` (`src/sidecar/quality-routes.ts`, already has per-check `runWithTimeout` + `activeChecks`/`MAX_CONCURRENT` guards). Configs: `targets/opencode/opencode.json:75-78` and `targets/claude-code/.mcp.json:3-7` — neither sets a timeout.

## Runtime Environment

- Build: `bun run build:all` (CC hooks + OC plugin). CLI: `bun run build:cli`. Embed assets: `bun run embed-assets`.
- Tests: `bun test`. TSC gate: `bunx tsc --noEmit` (full project, pre-commit).
- Sidecar: `~/.sentinal/sidecar.{sock,port,pid}`. Restart: `kill $(cat ~/.sentinal/sidecar.pid); rm ~/.sentinal/sidecar.{sock,port,pid}`.
- Live smoke (CC hook): pipe a `HookInput` JSON through the compiled `sentinal hook shared spec-stop-guard` and assert exit code. (`.opencode/skills/sentinal-live-smoke`.)

## Assumptions

- CC 2.1.145+ delivers `background_tasks`/`session_crons` on Stop input as arrays; empty/absent means no background work — supported by changelog verbatim + `hook-output.ts:26-29` typing. Tasks 2 depend on this.
- CC 2.1.163 `additionalContext` on Stop keeps the turn alive without a hook-error label at exit 0 — supported by changelog verbatim. Task 2 depends on this.
- OpenCode 1.18.3 (installed) supports the `dispose` capability for the plugin flavor we ship — VERIFY in Task 1 spike (dispose exists v1.15.11; whether legacy plugins get it vs only V2 Promise plugins is unverified). Tasks 3/4 depend on the spike outcome.
- The OpenCode plugin `client` may or may not expose session-list/event-subscribe at runtime — VERIFY in Task 1 spike. Task 5 (#3) degrades to `MemoryStore.isSessionAlive` if absent.
- MCP SDK 1.27.1 `extra` param carries `signal`/`sendNotification`/`_meta.progressToken` — CONFIRMED from `node_modules/@modelcontextprotocol/sdk` (`shared/protocol.d.ts:173-219`). Task 7 depends on this.

## Testing Strategy

- **Unit:** each extracted `src/**` module gets a companion `*.test.ts` (bun:test). Stop-context builder, background-task awareness, SDK-session liveness adapter, MCP abort/progress wrappers all tested in isolation.
- **Integration:** `resolveStopDecision` with the new liveness-source injection; sidecar quality-route abort behavior.
- **Live smoke:** compiled `sentinal hook shared spec-stop-guard` — assert the soft path exits 0 and emits `additionalContext` JSON (no `process.exit(2)`), and that a real block still surfaces context. This also unblocks direct `processSpecStopGuard` testing (the old tests avoided it precisely because `denyExit` exits the runner).
- **OC plugin:** load-smoke (`targets/opencode/plugins/sentinal.test.ts`) must still pass (catches init throws). New OC logic tested via extracted `src/opencode/*.ts` modules, not the plugin file.
- **Gates:** `bun test` (exit 0, not just "0 fail"), `bunx tsc --noEmit`, `bun run build:all`.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| OC V2 API is Effect-based, unpublished, uninstalled — blind migration | High | High | **Task 1 spike gate.** Full V2 only proceeds if the spike passes; else fall back to legacy-plugin dispose-equivalent (Task 4). User already chose spike-gate. |
| OC client doesn't expose session-list/event-subscribe at runtime | Med | Med | Task 5 keeps `MemoryStore.isSessionAlive` as fallback; SDK is additive/authoritative-when-present, never the sole source. |
| Soft stop-guard stops enforcing (agent ignores `additionalContext`) | Med | Med | `additionalContext` is a nudge by design; the CC 8-block cap no longer applies since we exit 0. Keep a config escape (env) to restore hard block if needed. Document the behavior change. |
| `background_tasks` shape differs from `unknown[]` assumption | Low | Low | Treat defensively: only skip blocking when the array is non-empty AND parseable; otherwise fall through to normal decision (fail toward blocking). |
| Editing `hooks.json` without re-embedding | Med | Med | Task explicitly runs `bun run embed-assets` + asserts `embedded-assets.ts` updated. |
| MCP progress requires client-supplied progressToken | Med | Low | Emit progress only when `extra._meta?.progressToken` is present; abort handling works unconditionally via `extra.signal`. |
| CI exit-code leak from a test calling `denyExit`/`process.exit` | Med | High | Soft path removes the exit-2 in the common case; any test that must exercise a hard path uses the compiled-dispatcher live-smoke (subprocess), never in-process. |

## Pre-Mortem

_Assume this plan failed after full execution. Most likely internal reasons:_

1. **Soft stop-guard silently lets sessions abandon in-progress plans** (Task 2) → Trigger: after switching to `additionalContext`, the agent stops anyway and the plan is left IN_PROGRESS with no nudge visible. Observable in the live-smoke: exit 0 but the `additionalContext` JSON is missing/empty. Mitigation: assert the JSON shape in the smoke test; keep an env toggle to force hard block.
2. **V2 migration half-lands** (Task 1/spike) → Trigger: spike ambiguously "passes," migration starts, then the Effect runtime contract mismatches at load and the whole plugin fails to load (silent — no hooks fire). Mitigation: spike must produce a *loading* V2 plugin artifact proven by `plugin.debug.log` before any migration code is written; otherwise fall back. Load-smoke test must pass.
3. **SDK session source disagrees with sidecar store** (Task 5) → Trigger: SDK reports a session live that our store thinks is dead (or vice-versa), causing inconsistent block/allow across CC vs OC. Mitigation: SDK is authoritative only on the OC side; CC keeps store-based; document the divergence; add a test asserting fallback when SDK returns malformed data.
4. **MCP abort added but subprocess keeps running** (Task 7) → Trigger: `extra.signal` fires but the sidecar `/quality-check` subprocess isn't actually killed (abort not plumbed through the HTTP boundary). Mitigation: Task 7 wires abort → sidecar cancellation or, minimally, stops awaiting and lets the existing `runWithTimeout` reap; test asserts the tool returns promptly on abort even if the subprocess lingers.

## Execution Waves

**Wave 1 — Capability spike (hard gate):** Task 1 only. Sets the soft-stop mechanism (Task 2), the V2 path (Task 4), and the MCP timeout field names (Task 6). No dependent code is written until its verdict lands.

**Wave 2 — Spike-independent (single task):** Task 7 (MCP abort/progress). Independent of the spike — SDK 1.27.1 `extra` support is already confirmed. Touches only `src/memory/mcp-tools.ts` + `src/analysis/mcp-tools.ts` + new `src/mcp/tool-runtime.ts`. Runs in parallel with Wave 1.

**Wave 3 — Spike-gated work (parallel where no file overlap):** After Task 1's verdict:
- Task 2 (CC stop-guard, spike-gated mechanism) — touches `src/hooks/*` + `src/utils/hook-output.ts` + `hooks.json`.
- Task 6 (MCP config timeouts, spike-verified fields) — touches the two config files + re-embed.
- Task 2 and Task 6 have **no file overlap** with each other → parallel.
- OC-plugin chain: Task 3 (dispose) → Task 4 (V2 or fallback) → Task 5 (SDK liveness) share `targets/opencode/plugins/sentinal.ts`, so **sequential** among themselves. This chain runs in parallel with Tasks 2/6 (different files) EXCEPT Task 5 edits `src/spec/ownership.ts` — which Task 2 only *calls*, never edits — so no write conflict; the backward-compat invariant (Task 5) protects Task 2's caller.

**Wave 4 — Verify:** Task 8 (full suite, tsc, build:all, CC live-smoke re-run, OC load-smoke).

## Goal Verification

### Truths

1. `src/hooks/spec-stop-guard.ts` no longer calls `denyExit` on the normal in-progress path — grep: absence of `denyExit(` in the soft path; presence of `output(hint("Stop"` or a `stopContext(` helper.
2. `processSpecStopGuard` reads `background_tasks` — grep: `background_tasks` appears in `src/hooks/spec-stop-guard.ts`.
3. `src/utils/hook-output.ts` exports a Stop-context helper — grep: `export function stopContext` (or the chosen name).
4. Compiled live-smoke: piping a Stop `HookInput` with a self-owned in-progress plan through `sentinal hook shared spec-stop-guard` emits the soft-context per the spike-chosen mechanism (SOFT_EXIT0 → exit 0 + `additionalContext`; SOFT_CONTINUE_ON_BLOCK → exit 2 + `continueOnBlock`), and the block context is surfaced (not silently allowed). Assertion checks the mechanism the spike verified.
5. `targets/opencode/opencode.json` and `targets/claude-code/.mcp.json` both set an explicit timeout on the `sentinal` MCP server — grep: `timeout` present in both `sentinal` entries.
6. `memory_search` and `quality_report` handlers declare the `extra` param and reference `extra.signal` — grep: `extra` + `signal` in `src/memory/mcp-tools.ts` and `src/analysis/mcp-tools.ts`.
7. OC plugin has a dispose/teardown path — grep: `dispose` (or the chosen registration) in `targets/opencode/plugins/sentinal.ts` or an imported `src/opencode/dispose*.ts`.
8. Task 1 spike produces `docs/plans/2026-07-17-changelog-top4-adoption.spike.md` recording the V2/dispose/session-API verdict.
9. `bun test` exits 0 and `bunx tsc --noEmit` is clean after all tasks.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/utils/hook-output.ts` (modify) | Stop `additionalContext` helper | `stopContext()` (or `stopHint()`) |
| `src/hooks/spec-stop-guard.ts` (modify) | Soft, background-aware stop-guard | `processSpecStopGuard()` |
| `src/hooks/stop-background.ts` (new) | Background-task awareness logic | `hasActiveBackgroundWork()` |
| `src/opencode/session-liveness.ts` (new) | SDK active-sessions adapter + fallback | `resolveActiveSessions()` |
| `src/opencode/plugin-dispose.ts` (new) | Extracted teardown logic | `disposePlugin()` |
| `src/mcp/tool-runtime.ts` (new) | Abort/progress helpers for tools | `withAbort()`, `emitProgress()` |
| `targets/opencode/opencode.json` (modify) | MCP timeout config | — |
| `targets/claude-code/.mcp.json` (modify) | MCP timeout config | — |
| `docs/plans/2026-07-17-changelog-top4-adoption.spike.md` (new) | V2/dispose/session-API verdict | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/hooks/spec-stop-guard.ts` | `src/utils/hook-output.ts` | soft context emit | `stopContext\|hint\("Stop"` |
| `src/hooks/spec-stop-guard.ts` | `src/hooks/stop-background.ts` | background awareness | `hasActiveBackgroundWork` |
| `targets/opencode/plugins/sentinal.ts` | `src/opencode/session-liveness.ts` | idle liveness source | `import.*session-liveness` |
| `targets/opencode/plugins/sentinal.ts` | `src/opencode/plugin-dispose.ts` | teardown | `import.*plugin-dispose` |
| `src/memory/mcp-tools.ts` | `src/mcp/tool-runtime.ts` | abort/progress | `withAbort\|emitProgress` |
| `src/analysis/mcp-tools.ts` | `src/mcp/tool-runtime.ts` | abort/progress | `withAbort\|emitProgress` |

## Progress Tracking

- [x] Task 1: Capability spike (OC V2/dispose/session-API + CC Stop exit-0) (Wave 1) — verdicts: Task2=SOFT_EXIT0, Task4=LEGACY_DISPOSE_FALLBACK (full V2 deferred, not viable on OC 1.18.3), Task5=PROCEED (client.session.list available), Task6 fields resolved
- [x] Task 7: MCP abort-signal + progress on slow tools (Wave 2)
- [x] Task 2: CC stop-guard soft context + bounded background awareness (Wave 3, gated by Task 1)
- [x] Task 6: MCP config timeouts (both targets, spike-verified fields) (Wave 3, gated by Task 1)
- [x] Task 3: OC plugin dispose teardown (Wave 3)
- [x] Task 4: OC V2 migration → DEFERRED (legacy-dispose fallback per spike) (Wave 3)
- [x] Task 5: OC session.idle uses SDK active-sessions (Wave 3)
- [x] Task 8: Verify (Wave 4) — 1594 tests / 0 fail / exit 0; also fixed pre-existing bun:sqlite bundle leak in session.idle
      **Total Tasks:** 8 | **Completed:** 8 | **Remaining:** 0

## Deferred Issues

- **Full OC V2/namespaced plugin migration (part of rec #2)** — DEFERRED. Task 1 spike proved the installed OpenCode 1.18.3 ships only the legacy `@opencode-ai/plugin` (`Plugin = (input) => Promise<Hooks>`); the Effect-based `@opencode-ai/plugin/v2/{effect,promise}` API is not surfaced to plugin authors. Track as a future plan gated on `@opencode-ai/plugin/v2` being published. Task 4 delivers the dispose-equivalent teardown on the legacy plugin instead.
- **`compaction.autocontinue` key drift (out of top-4 scope)** — installed `Hooks` expects `experimental.compaction.autocontinue`; our plugin registers `compaction.autocontinue`. Possible silent no-op. Track for a follow-up.
- **Widen hand-written OC client type** — `targets/opencode/types/opencode-plugin.d.ts` under-specifies `client` (real type is the full SDK client). Task 5 adds `session.list`; a fuller alignment is future work.

## Implementation Tasks

### Task 1: Capability Spike (OC V2/dispose/session-API + CC Stop exit-0)

**Objective:** Empirically verify FOUR capabilities against the installed hosts and produce a written verdict that gates Tasks 2, 4, and 5. This is a HARD gate: no dependent code is written until the verdict is recorded with observable evidence.
**Dependencies:** None
**Wave:** 1

**Files:**
- Create: `docs/plans/2026-07-17-changelog-top4-adoption.spike.md` (verdict)
- Investigate (read-only): upstream `anomalyco/opencode` `packages/core/src/plugin/{promise,host,internal}.ts`; installed OpenCode + Claude Code at their resolved paths; live `client` object shape via a temporary debug log; a throwaway CC Stop hook probe.

**Spike questions (each needs observable yes/no evidence):**
1. **[CC — GATES TASK 2]** Does a Claude Code `Stop` hook that exits **0** with `{ hookSpecificOutput: { hookEventName: "Stop", additionalContext } }` actually keep the turn alive AND surface the context? ⚠️ The codebase's own `blockExit` docstring (`hook-output.ts:134-139`) says "Exiting 0 would silently downgrade to a no-op" — this MUST be disproven before Task 2 uses exit 0. Probe: install a throwaway Stop hook that emits additionalContext at exit 0 in a scratch project, trigger a stop, observe whether CC continues + shows context. Record CC version tested.
   - Verdict sets Task 2 path: `SOFT_EXIT0` (exit 0 additionalContext works) **or** `SOFT_CONTINUE_ON_BLOCK` (must use `continueOnBlock:true` + exit 2 + `{decision:"block"}`, the already-documented-working soft path).
2. **[OC — GATES TASK 4]** Does OpenCode 1.18.3 load a V2/Promise plugin (Registration with `dispose`)? Proven via `~/.sentinal/plugin.debug.log`.
3. **[OC — GATES TASK 3/4]** Does our current legacy plugin receive a `dispose` call on unload, or is dispose V2-only?
4. **[OC — GATES TASK 5]** Does the plugin `client` expose session-list/event-subscribe on 1.18.3? Dump `Object.keys(client)` + `Object.keys(client.session ?? {})` on init.

**Key Decisions / Notes:**
- Confirmed from upstream: V2 = `@opencode-ai/plugin/v2/{effect,promise}`; Promise plugins return a `Registration` with a `dispose` effect (`promise.ts:31`). NOT installed here (types inline).
- Also record the exact MCP timeout field name each host honors (feeds Task 6) — verify via Context7/host docs, not a guess.
- Remove ALL temporary probe code before finishing; OC + CC load paths must be clean.

**Definition of Done:**
- [ ] Spike doc records a verdict + captured evidence for all 4 questions.
- [ ] Task 2 path set: `SOFT_EXIT0` or `SOFT_CONTINUE_ON_BLOCK`.
- [ ] Task 4 path set: `FULL_V2` or `LEGACY_DISPOSE_FALLBACK`.
- [ ] MCP timeout field names for both hosts recorded (feeds Task 6).
- [ ] All temporary probe code removed; OC load-smoke green.

**Verify:**
- `test -f docs/plans/2026-07-17-changelog-top4-adoption.spike.md`
- `bun test targets/opencode/plugins/sentinal.test.ts`

### Task 2: CC Stop-Guard Soft Context + Bounded Background Awareness

**Objective:** Convert the hard `denyExit` block into a soft `additionalContext` nudge using the soft path proven by the Task 1 spike, and skip blocking for `background_tasks`/`session_crons` ONLY when doing so cannot abandon the current session's own in-progress plan.
**Dependencies:** **Task 1** (spike sets the soft-path mechanism)
**Wave:** 3 (moved from Wave 2 — now gated by Task 1)

**Files:**
- Modify: `src/utils/hook-output.ts` (add `stopContext(reason)` helper implementing the spike-chosen mechanism)
- Modify: `src/hooks/spec-stop-guard.ts` (use soft path; bounded background awareness)
- Create: `src/hooks/stop-background.ts` + `src/hooks/stop-background.test.ts` (`hasActiveBackgroundWork(input): boolean`)
- Modify/Create: `src/hooks/spec-stop-guard.test.ts`
- Modify: `targets/claude-code/hooks/hooks.json` — add `continueOnBlock: true` on the Stop entry IF the spike verdict is `SOFT_CONTINUE_ON_BLOCK`; then **`bun run embed-assets`** (hooks.json is embedded — mandatory).
- Env escape: `SENTINAL_STOP_GUARD_HARD=1` restores hard `denyExit` (documented).

**Key Decisions / Notes:**
- **Soft mechanism is spike-determined:**
  - `SOFT_EXIT0` → `stopContext` = `output(hint("Stop", reason))` then exit 0.
  - `SOFT_CONTINUE_ON_BLOCK` → `stopContext` = emit `{decision:"block", reason, hookSpecificOutput:{hookEventName:"Stop", additionalContext:reason}}` at exit 2 with `continueOnBlock:true` in hooks.json (the codebase's documented-working soft path per `hook-output.ts:134-139`).
  - Either way it ends the 8-block-cap loop class while keeping the turn alive.
- **Bounded background awareness (must NOT abandon own plan):** `hasActiveBackgroundWork` may suppress a block ONLY when the block is a *weaker* class (orphaned / adoptable-by-another). It must NEVER suppress a block when `ownerId === currentSessionId` (the self-owned in-progress case, `ownership.ts:80-81`). Implementation: thread the decision's ownership class through, or re-check ownership before suppressing. Empty/absent arrays ⇒ normal decision.
- Preserve subagent bypass and `last_assistant_message` snippet behavior.
- TDD: `stop-background.test.ts` (RED) first, including the self-owned-still-blocks case.

**Definition of Done:**
- [ ] Soft path matches spike verdict; `SENTINAL_STOP_GUARD_HARD=1` still hard-blocks.
- [ ] `hasActiveBackgroundWork` NEVER suppresses a self-owned in-progress block (explicit test); suppresses only weaker-class blocks.
- [ ] `processSpecStopGuard` unit-tested directly where the soft path allows it.
- [ ] If `hooks.json` changed → re-embedded (grep timeout/continueOnBlock in `embedded-assets.ts`).

**Verify:**
- `bun test src/hooks/stop-background.test.ts src/hooks/spec-stop-guard.test.ts`
- Live smoke: pipe a self-owned in-progress Stop `HookInput` (with non-empty `background_tasks`) through `./dist/sentinal hook shared spec-stop-guard` → still surfaces the block context (not silently allowed). Assert OBSERVED soft behavior per spike, not just stdout presence.

### Task 6: MCP Config Timeouts (Both Targets)

**Objective:** Set explicit, documented MCP timeouts (using host-verified field names from the Task 1 spike) so slow tools aren't killed at the host default.
**Dependencies:** **Task 1** (spike records the exact honored timeout field per host)
**Wave:** 3

**Files:**
- Modify: `targets/opencode/opencode.json` (`sentinal` entry — add the OpenCode-honored timeout field per spike; evaluate `cwd` per OC v1.17.4)
- Modify: `targets/claude-code/.mcp.json` (`sentinal` entry — add the CC-honored timeout field per spike; keep `alwaysLoad: true`)
- **`.mcp.json` IS embedded** (`embedded-assets.ts:21607-21611`, confirmed). After editing, **MUST run `bun run embed-assets`** and assert the timeout appears in `embedded-assets.ts`. Non-negotiable.

**Key Decisions / Notes:**
- Do NOT guess field names — use the exact honored key each host recorded in the spike doc (CC per-server timeout min 1000ms per 2.1.162; OpenCode's honored key TBD-by-spike). Pick a value comfortably above embedding cold-start + a 3×30s quality run (e.g. 120000ms).
- JSON has no comments — record the chosen value + rationale in the spike/plan doc.

**Definition of Done:**
- [ ] Both `sentinal` MCP entries carry an explicit timeout ≥ the host floor, using the spike-verified field name.
- [ ] `.mcp.json` change re-embedded — `rg "timeout" src/cli/embedded-assets.ts` shows it near the sentinal mcpServers block.
- [ ] `bun run build:all` clean.
- [ ] Runtime check: a slow tool (`quality_report` or `memory_search` cold) is no longer killed at the old default.

**Verify:**
- `rg -n "timeout" targets/opencode/opencode.json targets/claude-code/.mcp.json src/cli/embedded-assets.ts`

### Task 7: MCP Abort-Signal + Progress on Slow Tools

**Objective:** Make `memory_search` and `quality_report` honor client cancellation (`extra.signal`) and emit progress (`extra.sendNotification` when a `progressToken` is present).
**Dependencies:** None (SDK 1.27.1 confirmed to support `extra`)
**Wave:** 2

**Files:**
- Create: `src/mcp/tool-runtime.ts` + `src/mcp/tool-runtime.test.ts` (`withAbort(signal, promise)`, `emitProgress(extra, {progress, total})`)
- Modify: `src/memory/mcp-tools.ts` (`memory_search` handler declares `extra`; races search against `extra.signal`; emits progress around embedding)
- Modify: `src/analysis/mcp-tools.ts` (`quality_report` handler declares `extra`; aborts/returns promptly on `extra.signal`; emits progress per check)
- (If needed) Modify: `src/sidecar/client.ts` to pass an abort signal to `/quality-check` — otherwise, on abort, stop awaiting and let the existing `runWithTimeout` reap the subprocess.

**Key Decisions / Notes:**
- SDK 1.27.1: handler 2nd arg `extra: RequestHandlerExtra` has `.signal`, `.sendNotification`, `._meta.progressToken` (confirmed `shared/protocol.d.ts:173-219`). No convenience `reportProgress` — emit `notifications/progress` manually via `extra.sendNotification`, guarded by `extra._meta?.progressToken`.
- Abort contract: the tool must return/throw promptly when `signal.aborted`, even if a subprocess lingers (pre-mortem #4). Don't block the MCP response on subprocess kill. Lingering subprocesses are bounded — the sidecar's `runWithTimeout` reaps them at the per-check timeout, and `activeChecks`/`MAX_CONCURRENT` release in a `finally`. Confirm the abort path does NOT consume a NEW `activeChecks` slot without releasing it (else rapid abort/retry could exhaust the guard).
- Keep the `{ client, store }` delegation; abort/progress live in the tool handler layer, above delegation.
- TDD: `tool-runtime.test.ts` (RED) — abort rejects promptly; progress no-ops without a token.

**Definition of Done:**
- [ ] `withAbort`/`emitProgress` unit-tested (abort-before, abort-mid, no-token no-op).
- [ ] Both tool handlers declare `extra` and honor `extra.signal`.
- [ ] Progress emitted only when a `progressToken` is present.

**Verify:**
- `bun test src/mcp/tool-runtime.test.ts src/memory/mcp-tools.test.ts src/analysis/mcp-tools.test.ts`

### Task 3: OC Plugin Dispose Teardown

**Objective:** Extract the teardown logic into a testable module and wire a real dispose/teardown path for the OpenCode plugin, replacing the ad-hoc `session.deleted` shutdown.
**Dependencies:** Task 1 (spike verdict informs whether dispose is a native hook or a fallback)
**Wave:** 3

**Files:**
- Create: `src/opencode/plugin-dispose.ts` + `src/opencode/plugin-dispose.test.ts` (`disposePlugin({ sidecar, sessionId, stopSidecar, stopDashboard, getActiveSessions })`)
- Modify: `targets/opencode/plugins/sentinal.ts` (call `disposePlugin(...)` from the native `dispose` hook if the spike confirms it; otherwise keep it invoked from `session.deleted` but via the extracted module)

**Key Decisions / Notes:**
- Move the current inline `session.deleted` shutdown (`sentinal.ts:1084-1093`) into `disposePlugin` so both `dispose` (if available) and `session.deleted` share one tested code path.
- `SidecarClient` has no `close()` — teardown = `getActiveSessions()===0 → stopSidecar()+stopDashboard()`. If a native `dispose` exists, it should also flush any pending observation queue before stopping.
- Preserve the export-only-plugin-function invariant (helpers stay in `src/opencode/`).

**Definition of Done:**
- [ ] `disposePlugin` unit-tested (stops sidecar/dashboard only when no active sessions; flushes queue).
- [ ] Wired per spike verdict; OC load-smoke green.

**Verify:**
- `bun test src/opencode/plugin-dispose.test.ts targets/opencode/plugins/sentinal.test.ts`

### Task 4: OC V2 Migration OR Legacy-Dispose Fallback (GATED)

**Objective:** If Task 1 verdict is `FULL_V2`, migrate the plugin to the V2/Promise API with a `Registration.dispose`. If `LEGACY_DISPOSE_FALLBACK`, this task is limited to ensuring Task 3's teardown is the definitive dispose path on the legacy plugin (no V2 rewrite).
**Dependencies:** Task 1 (hard gate), Task 3
**Wave:** 3

**Files (FULL_V2 path):**
- Modify: `targets/opencode/plugins/sentinal.ts` (adopt V2/Promise plugin shape; return `Registration` with `dispose`)
- Modify: `targets/opencode/types/opencode-plugin.d.ts` (inline V2 types — do NOT add `@opencode-ai/plugin` to package.json; it's externalized/peer)
- Modify: `targets/opencode/plugins/sentinal.test.ts` (adapt load-smoke to V2 shape)

**Files (LEGACY_DISPOSE_FALLBACK path):**
- No V2 rewrite. Confirm Task 3's `disposePlugin` is the teardown path; document the deferral of full V2 in the spike doc + a `## Deferred` note.

**Key Decisions / Notes:**
- ⛔ Do not begin V2 code until the spike proves a V2/Promise plugin actually loads on 1.18.3 (evidence in `plugin.debug.log`). The pre-mortem's "half-landed V2" is the top risk.
- Keep types inline (bundling constraint; prior plan reviews mandate this).
- The export-only invariant and file-length exemption still apply.

**Definition of Done:**
- [ ] Path taken matches the spike verdict.
- [ ] If FULL_V2: plugin loads (proven by load-smoke + `plugin.debug.log`), all existing hooks still fire, `dispose` runs on unload.
- [ ] If FALLBACK: full V2 deferral documented; no partial V2 code left in the tree.

**Verify:**
- `bun test targets/opencode/plugins/sentinal.test.ts src/opencode/plugin-exports.test.ts`
- `bun run build:opencode`

### Task 5: OC session.idle Uses SDK Active-Sessions

**Objective:** Make the OpenCode `session.idle` stop decision consult the OpenCode SDK's active-sessions API as the authoritative liveness source, falling back to `MemoryStore.isSessionAlive` when the SDK surface is unavailable.
**Dependencies:** Task 1 (confirms client surface), Task 4
**Wave:** 3

**Files:**
- Create: `src/opencode/session-liveness.ts` + `src/opencode/session-liveness.test.ts` (`resolveActiveSessions({ client, store }): Promise<LivenessSource>` returning an `isSessionAlive`-compatible probe)
- Modify: `src/spec/ownership.ts` (accept an optional injected liveness probe so OC can pass SDK-derived liveness; default remains `store.isSessionAlive`)
- Modify: `src/spec/ownership.test.ts` (cover injected-probe path)
- Modify: `targets/opencode/plugins/sentinal.ts` (`session.idle` builds the SDK liveness source, passes it to `resolveStopDecision`, falls back on error)

**Key Decisions / Notes:**
- ⚠️ **OC session.idle is ADVISORY-ONLY** (`sentinal.ts:1135-1143` only calls `client.app.log({level:"warn"})`; OpenCode has no exit-2/deny equivalent). This task improves the *accuracy of the warning* — which sessions get warned — NOT hard stop enforcement. #3 does not add enforcement on OC; that's a platform limitation.
- Additive + fail-safe: SDK is authoritative ONLY when present and well-formed; malformed/absent ⇒ fall back to store. Never let an SDK error flip the decision to allow (fail toward BLOCK).
- **Backward-compat invariant (cross-wave, tested):** `resolveStopDecision`'s new `livenessProbe?` param MUST be optional; when omitted, behavior is byte-identical to today's `store.isSessionAlive` (`ownership.ts:85`). This is the SAME function Task 2's CC guard calls — a non-backward-compatible change breaks the landed CC caller. Add a test asserting the no-probe path is unchanged; Task 8 re-runs the Task 2 CC live-smoke after this task lands.
- Guard the client surface with runtime capability checks (`typeof client.session?.list === "function"`) since types are hand-written.

**Definition of Done:**
- [ ] `resolveActiveSessions` unit-tested (SDK present → uses it; malformed → falls back; absent → falls back; never flips to allow on error).
- [ ] `resolveStopDecision` byte-identical for the no-probe (CC) case — explicit test; new tests cover the injected-probe path.
- [ ] Task 5 documents OC session.idle as advisory-only.
- [ ] OC `session.idle` uses the SDK source with fallback; load-smoke green.

**Verify:**
- `bun test src/opencode/session-liveness.test.ts src/spec/ownership.test.ts targets/opencode/plugins/sentinal.test.ts`

### Task 8: Verify

**Objective:** Full regression + quality gates + dual-target build + live-smoke.
**Dependencies:** All prior tasks
**Wave:** 4

**Key Decisions / Notes:**
- Run `bun test > /tmp/t.log 2>&1; echo $?` — must be **0** (not merely "0 fail"), to catch any exit-code leak (sentinal-ci-only-failures rule).
- Live-smoke the CC stop-guard soft path through the compiled dispatcher.
- OC load-smoke must pass (init-throw guard).

**Definition of Done:**
- [ ] `bun test` exits 0; `bunx tsc --noEmit` clean; `bun run build:all` clean.
- [ ] Stop-guard live-smoke: soft path exits 0 with `additionalContext`.
- [ ] OC load-smoke green.

**Verify:**
- `bun test && bunx tsc --noEmit && bun run build:all`
