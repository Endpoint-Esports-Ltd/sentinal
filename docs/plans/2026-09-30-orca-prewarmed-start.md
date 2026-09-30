# Orca Pre-Warmed Start and Coordinator Fixes (issue #13) Implementation Plan

Created: 2026-09-30
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** For OpenCode, `orca_start` no longer loses the brief on a worker's first start. It
starts the agent in a terminal Sentinal creates, waits until OpenCode has drawn its input box,
and only then runs `worker-start --terminal`. The same change fixes the coordinator gaps
reported in #13: heartbeat nags, a misleading `retry_of` refusal, no way to answer a worker's
question, no way to rebind a Run after an Orca restart, and no recovery instructions.

**Architecture:**

- **Pre-warmed start.** A new module, `src/orca/dispatch-prewarm.ts`, runs these steps:
  1. `orca terminal create --worktree <placement> --command <agent> --title worker-<task>`;
  2. `orca terminal wait --for tui-idle`;
  3. poll `orca terminal read --screen` until `showsHomeScreen(tail)` (the start-screen
     matcher from `stall-terminal.ts`, used here as the positive readiness signal), then wait
     1 s more;
  4. `worker-start --task … --worktree <placement> --terminal <handle>`.

  `startTask` takes this path for agents in `SENTINAL_ORCA_PREWARM_AGENTS` (default `opencode`;
  `none` disables it), when the placement is an existing worktree. If the input box never
  appears, Sentinal closes its terminal and falls back to Orca's normal `--agent` start.
- **Terminals Sentinal created** are recorded per dispatch. When a release answers `retained`,
  Sentinal closes exactly that terminal. Orca's own terminals are never closed.
- **Heartbeats.** `orca_wait` also collects heartbeats. A delivery that holds only heartbeats
  is acked inside the call.
- **`retry_of` on a task that is already `ready`.** The start is retried once without
  `retry_of`.
- **New tools:** `orca_reply` answers a worker's question, and `orca_rebind` runs `run-use`
  for a Run.
- **Prose and docs:** the recovery instructions (close only the worker's terminal tab), the
  known cold-start drop, and the upstream links.

**Tech Stack:** TypeScript, Bun test, the `orca` CLI adapter (`src/orca/cli.ts`), zod, the MCP
SDK.

## Scope

### In Scope

1. **Pre-warmed start** for configured agents with a path or `current` placement (`new-child`
   keeps the normal path, because that worktree doesn't exist yet):
   - The receipt reports `start_path: "prewarmed" | "agent" | "agent-fallback"` and
     `prewarm: { terminal, ready_ms }`.
   - Readiness timeout: 30 s. Polling every 500 ms.
   - The automatic single retry after a failed attempt uses the same path, with a fresh
     terminal.
   - **Pending, join and replay (plan-review must_fix).** A pre-warmed start records its
     terminal handle against the request id (`state.startTerminals`).
     - An in-process join reuses the same promise, so one terminal is created.
     - An in-process replay after a CLI timeout reuses the recorded handle, so Orca sees the
       same argv with the same `--retry-request`.
     - A replay with **no** record in this process (a restart) **never pre-warms**. It asks
       `orca orchestration request-show --request <id>`:
       - `completed` → return the recorded receipt as `started`;
       - `pending` → answer `pending` again;
       - `absent` → an error saying the outcome is unknown and naming `worker-list --run` to
         inspect. It never starts a new worker, because Orca's guide says absent is not proof
         nothing happened.
2. **Closing Sentinal-created terminals** (user decision):
   - `state.createdTerminals: Map<dispatchId, handle>`.
   - After `orca_release` answers `retained` for a dispatch in that map, Sentinal runs
     `orca terminal close --terminal <handle>` and reports it.
   - The fallback closes its own terminal before the `--agent` start. `worker-start` never
     took that terminal.
   - After a failed pre-warmed attempt, its terminal is closed **only** when `worker-release`
     answered `released`/`already_released`/`retained`, or when `worker-start` never took the
     terminal (an error before a receipt). After `release_pending`/`release_unknown` it is only
     reported (plan-review should_fix).
   - Orca-created terminals are still only reported, never closed (Orca's guide: never
     substitute `terminal close` for release).
3. **Heartbeat nag fix:**
   - `waitForSettlement` adds `heartbeat` to `--types`.
   - In `orca_wait`, a delivery made up only of heartbeats is acked at once. `orca_wait`
     then **keeps waiting** for the rest of its time budget, so a heartbeat never ends the
     wait early (plan-review should_fix). The cause is that Orca nudges the coordinator for
     every pending delivery, and heartbeats are left pending because `--types` excludes them.
     This matches the reporter's ~19 nags. Task 9 checks it live.
   - In a mixed delivery, heartbeats are counted, not listed; the normal `orca_ack` covers them.
4. **`retry_of` on a `ready` task:** when `worker-start --retry-of` is refused with
   `task_not_startable` and `data.status === "ready"` and no unmet dependencies, `startTask`
   retries once without `retry_of`, with a new request id. `orca_start` then reports
   `retry_of_skipped: true` with the reason.
   - Only the **caller's** `retry_of`, never `startTask`'s own automatic retry.
   - A terminal that was already pre-warmed is **reused** for the plain start: it is ready
     and `worker-start` never took it.
   - No duplicate is possible: a `ready` task has no active dispatch, and Orca refuses a
     second concurrent start.
5. **`orca_reply({ run_id, message_id, body })`** → `orca orchestration reply --run --id --body
   --retry-request`. The Next line in `orca_wait` for a `question` names it.
6. **`orca_rebind({ run_id, force? })`** → `orca orchestration run-use --id` (a mutation,
   with `--retry-request`). It is explicit, never automatic.
   - **The refusal is enforced in code** (plan-review suggestion): `run-show` gives the Run's
     `coordinator_handle`. If that is this terminal, the tool answers "already bound". If
     `orca terminal show` says it is live (`connected: true`), the tool refuses unless
     `force: true`, because another live coordinator holds the Run. If the terminal is
     `terminal_handle_stale`, it rebinds.
   - On `consumer_fenced`, `orca_wait`'s hint names it.
7. **The real d11 fixture:** the reporter's stall-time `worker-show` (with `observation` live
   and `exactWorker`) plus the wide 160-column `worker-read`, with tests for both
   `ownTerminalLive` paths and the wide start screen.
8. **Prose** (both targets):
   - `orca_start` pre-warms OpenCode automatically.
   - Recovery for a dropped brief (a `never-started-unverifiable` attention entry): ask the
     user to close **only the worker's terminal tab**, never Orca's stop (which deleted a
     worktree on the reporter's machine). Then call `orca_start({ task_id, worktree, agent })`
     again, a plain start; a `retry_of`, if passed, is skipped automatically for a `ready` task
     (Task 6).
   - `SENTINAL_ORCA_PREWARM_AGENTS=none` turns the pre-warmed start off, for example if Orca
     #17741's pane-binding defect shows up.
   - `orca_reply` for questions; `orca_rebind` after an Orca restart; upstream issue links.
9. **Docs:** dev rules, README (tool count 49, Orca 11), the `sentinal-orca-cli` skill, and the
   `.orca/` ignores already added (`.orca/.gitignore`, `eslint.config.mjs`, `.prettierignore`).
10. **A live check on Orca 1.4.217 (macOS).**

### Out of Scope

- Reproducing Linux's cold-start drop here. On macOS, 12 of 12 first starts landed; the timing
  window is measured, but the drop is not reproduced.
- Any stop, retry or close of Orca-created worker terminals.
- A fix inside Orca or OpenCode (upstream: Orca #22580, #17741, PR #20451; OpenCode #42915).

## Context for Implementer

- **Issue #13** (3 comments with attachments; Linux; Orca 1.4.209 and then 1.4.217; OpenCode
  1.18.33 with 7 MCP servers):
  - First starts in a newly prepared worktree: 9 of 9 failed (7 dropped briefs, 2
    `agent_readiness`: `terminal_handle_stale` and a 60 s `timeout`). Later starts: 5 of 5
    landed.
  - The daemon log shows the same launch for cold and warm starts: `commandLength: 8`,
    `queuedByShellReadyBarrier: true`, with the brief pasted afterwards.
- **Measured here** (2026-09-30, macOS, `oc_startup.py` / `oc_paste.py` from the issue):
  - Bracketed paste is enabled at about 0.8 s. The input box is drawn at 3.3–3.5 s in an
    existing checkout and at 3.3–5.8 s in a new worktree.
  - A paste before the box is dropped, and one after it lands.
  - Through Orca 1.4.217 with `workspaceDir: .orca/worktrees`, 3 of 3 `worker-start` first
    starts landed; `worker-start` took 5–6 s. Captures are in `/tmp/orca-drop/measure*.log`.
- **Real captures of the pre-warmed steps** (`/tmp/orca-drop/`, #12 live test, Orca 1.4.216),
  which become fixtures:
  - `g-create.json`: `terminal create` → `result.terminal.handle`;
  - `g-wait.json`: `terminal wait --for tui-idle` → `wait.satisfied: true`;
  - `g-start.json`: `worker-start --terminal` → `state: ready`, effects `terminal: reused`;
  - `g-release.json`: `worker-release` → `retained` / `external_terminal`;
  - `idle-screen.json` and `race-screen.json`: screen reads after and before the box.
  - In that test the `--terminal` start delivered its brief and `worker_done` was accepted
    (1 of 1).
- **Orca's guide:**
  - `low-level-topology`: "Use `worker-start --terminal <handle>` when lifecycle ownership of
    an existing agent terminal is required", and "wait for readiness only when startup could
    lose injected input".
  - `recovery-and-cleanup`: release retains "reused, pre-existing … terminals".
  - `worker-start` takes `--agent` OR `--terminal`, not both. With `--terminal`, pass
    `--worktree` for that terminal.
- **Captures for the new safeguards** (live, 2026-09-30, Orca 1.4.217;
  `/tmp/orca-drop/cap-*.json`):
  - `request-show` → `state: "completed"` with a `receipt` and an `interpretation`, or
    `state: "absent"` ("Absent is not proof that nothing happened");
  - `run-show --id` → `run.coordinator_handle`;
  - `terminal show` → `connected: true` for a live terminal, or the error
    `terminal_handle_stale` for a closed one.
- **Known upstream risk:** Orca #17741, defect 2. For terminals made with `terminal create`,
  the capability can be bound to the wrong pane (14 of 600 `worker_done` rejected in one
  report). Mitigation: the Task 9 live check verifies that `worker_done` is accepted, and the
  master-plan flow already treats the child plan file as the source of truth.
- **Current code:**
  - `src/orca/dispatch-start.ts` (309 lines): `startOnce`, `startTask`, `cleanupAttempt`,
    `retryPlacement`.
  - `src/orca/mcp-tools-start.ts` (243): the `orca_start` pending/join logic.
  - `src/orca/dispatch.ts` (385): `waitForSettlement`, whose `--types` is at about :288.
  - `src/orca/mcp-tools-wait.ts` (223): `orca_wait`.
  - `src/orca/mcp-tools-settle.ts` (235): `orca_release` adds to `state.released` for every
    answer.
  - `src/orca/mcp-tools.ts` (328): registration and `orca_dispatch`.
  - `src/orca/mcp-tools-shared.ts`: `OrcaToolState`.
- **Patterns:** injected runners and fixtures, never the real `orca` (`dispatch-start.test.ts`
  `queue`, `mcp-tools-settle.test.ts` `fakeOrca`). Redact `dcap_`.
- **Gotchas:**
  - Keep every non-test file under 400 lines. `dispatch.ts` is at 385, so only small edits
    there. The new logic goes in `dispatch-prewarm.ts` and `mcp-tools-coord.ts`.
  - Run the parity regeneration once (Task 7), then `bun run embed-assets`.
  - Set `RED_CONFIRMED` before each implementation write.
  - Tool counts are hand-maintained in `README.md`, `.sentinal/rules/sentinal-mcp-servers.md`,
    `src/mcp/server.test.ts` and `src/orca/mcp-tools.test.ts`.

## Assumptions

- `worker-start --terminal` into a terminal whose input box is already drawn delivers the
  brief. Supported by the #12 live test (1 of 1) and Orca #22580's workaround (2 of 2). Tasks 2
  and 9 depend on this.
- `showsHomeScreen` (logo + framed placeholder) is a reliable "input box mounted" signal. It
  was drawn at 3.3–5.8 s in 20+ measured launches, and the reporter's screens match it.
  Task 2 depends on this.
- `orca terminal close` on a terminal Sentinal created, after the dispatch settled and release
  answered `retained`, affects no worker Orca owns. Task 5 depends on this.
- `orca orchestration run-use --id` rebinds a Run to the calling terminal (confirmed in the
  2026-09-28 spike and by the reporter). Task 4 depends on this.

## Testing Strategy

- Unit tests with the real captures listed above as fixtures:
  - the pre-warmed happy path;
  - the box never appearing → close and fall back;
  - `tui-idle` timing out → fall back;
  - a failed pre-warmed attempt → release, close, and retry once with a fresh terminal;
  - a pending join creating one terminal only;
  - `new-child` and non-listed agents taking the normal path;
  - the environment variable parsed, with `none` disabling pre-warm.
- `orca_wait` heartbeat tests; `orca_release` close tests; `retry_of`-on-ready tests;
  `orca_reply` / `orca_rebind` tool tests; d11 fixture tests.
- Live check on 1.4.217 (Task 9).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Capability bound to the wrong pane (Orca #17741 defect 2) → `worker_done` rejected | Low | A worker that finishes but never reports | Live-verified in Task 9. Documented. Master plans already read the child plan's `Status`; prose says a worker whose plan reads VERIFIED but that never reports is a known Orca issue to raise with the user |
| The input box is detected before OpenCode really accepts input | Low | The drop persists | 1 s slack after detection; `tui-idle` first; fallback reporting shows `start_path` |
| A process restart during a pending pre-warmed start leaves an orphan terminal | Low | A stray tab | Documented limitation; in-process joins never create a second terminal |
| Closing the wrong terminal | Low | Closes a worker's tab | Close only a handle recorded when Sentinal created it, only after a release answer for that dispatch |
| Auto-acking heartbeats hides a real message | Low | A lost message | Only a delivery whose messages are **all** `heartbeat` is auto-acked |

## Pre-Mortem

1. **`worker-start --terminal` pastes before OpenCode is ready, even after the box is drawn**
   (Task 2). → Trigger: the Task 9 live start shows the home screen with no dispatch id at +40 s.
   Adapt: raise the slack, or require two consecutive reads showing the box.
2. **Orca refuses `worker-start --terminal` for a terminal made by `terminal create`, or
   reports `inject_rejected`** (Task 2). → Trigger: a fixture or live error. The fallback path
   covers it; record the finding.
3. **The line budget** (Tasks 2 and 3). → Trigger: a file over 400 lines. The new files are
   planned to prevent it.

## Execution Waves

**Wave 1:** Task 1 (fixtures + types).
**Wave 2** (parallel, disjoint files):

- Task 2: `dispatch-prewarm.ts`, `dispatch-start.ts`, `mcp-tools-start.ts`, shared state.
- Task 3: heartbeat handling in `dispatch.ts` and `mcp-tools-wait.ts`.
- Task 4: `orca_reply` / `orca_rebind` in `mcp-tools-coord.ts` and `mcp-tools.ts`, plus the tool
  lists.

**Wave 3** (parallel, disjoint files):

- Task 5: close created terminals in `mcp-tools-settle.ts`.
- Task 6: `retry_of` on a ready task in `dispatch-start.ts`, which Task 2 is finished with by
  then.

**Wave 4** (parallel, disjoint files): Task 7 (`targets/` prose + one parity regeneration) and
Task 8 (docs).
**Wave 5:** Task 9 (the live check).

## Goal Verification

### Truths

1. A `dispatch-prewarm.test.ts` test replays `terminal create` → `terminal wait` → a home-screen
   read → `worker-start --terminal <handle>`, and asserts the exact argv, with no `--agent` on
   `worker-start`.
2. A test in which the screen never shows the box gives a `terminal close` for that handle,
   then a `worker-start --agent opencode`, and `start_path: "agent-fallback"`.
3. With `SENTINAL_ORCA_PREWARM_AGENTS=none`, or with agent `claude`, `worker-start --agent` is
   used directly.
4. An `orca_release` test where release answers `retained` for a dispatch Sentinal started
   pre-warmed makes exactly one `orca terminal close --terminal <that handle>`. For a dispatch
   not in `createdTerminals`, no close happens.
5. An `orca_wait` test with a heartbeat-only delivery acks it inside the call and returns
   `timed_out: true` with no messages.
6. A `startTask` test with `retryOf` refused as `task_not_startable` with status `ready`
   retries without `--retry-of` and returns `started` with `retrySkipped: true`.
7. `orca_reply` and `orca_rebind` are registered, and `README.md` says 49 tools with 11 in the
   Orca domain.

### Artifacts

| Artifact | Provides | Exports |
| -------- | -------- | ------- |
| `src/orca/dispatch-prewarm.ts` | Pre-warmed start | `prewarmAgents`, `prewarmTerminal`, `usePrewarm` |
| `src/orca/mcp-tools-coord.ts` | `orca_reply`, `orca_rebind` | `registerOrcaCoordTools` |

### Key Links

| From | To | Via | Pattern |
| ---- | -- | --- | ------- |
| `src/orca/dispatch-start.ts` | `dispatch-prewarm.ts` | import | `from "./dispatch-prewarm.js"` |
| `src/orca/dispatch-prewarm.ts` | `stall-terminal.ts` | readiness | `showsHomeScreen` |
| `src/orca/mcp-tools.ts` | `mcp-tools-coord.ts` | registration | `registerOrcaCoordTools` |

## Progress Tracking

- [x] Task 1: Fixtures + types (real pre-warm steps, d11, heartbeat) (Wave 1)
- [x] Task 2: Pre-warmed start with fallback (Wave 2)
- [x] Task 3: Heartbeat nag fix (Wave 2)
- [x] Task 4: `orca_reply` + `orca_rebind` tools (Wave 2)
- [x] Task 5: Close Sentinal-created terminals on a retained release (Wave 3)
- [x] Task 6: `retry_of` on a ready task (Wave 3)
- [x] Task 7: Prose in both targets + parity + embed (Wave 4)
- [x] Task 8: Dev docs, README, `.orca/` ignores (Wave 4)
- [x] Task 9: Live check on Orca 1.4.217 (Wave 5)

**Total Tasks:** 9 | **Completed:** 9 | **Remaining:** 0

## Implementation Notes

- **Task 2:** besides `dispatch-prewarm.ts`, the helpers moved into `dispatch-core.ts` (`mutate`,
  `err`, `pathFromId`) and `dispatch-attempts.ts` (`cleanupAttempt`, `retryPlacement`,
  `deliveryConfirmed`). `dispatch-start.ts` re-exports them and ended at 369 lines after Task 6.
- **Task 3:** the `orca_wait` time budget uses `Date.now()` (the injected `now` is a fixed stall
  clock). Stall collection runs once per round, at most 3 rounds.
- **Task 4:** the handle is read the same way as `orca_status` (`(deps.env ?? process.env)`).
  `orca_reply`'s returned message id is best-effort: no reply fixture was recorded.
- **Task 5:** `mcp-tools-settle.test.ts` `capture` registers the settle tools with an injectable
  state.
- **Task 5 deviation:** `orca_release` closes Sentinal's own terminal after `released` and
  `already_released` as well as `retained` (Orca may already have closed it; a close error is
  then only informative). It still never closes an Orca-created terminal.
- **Spec review fixes (all four should_fix, plus a suggestion):**
  - Every terminal `startTask` closes is reported through `onTerminalClosed`, and `orca_start`
    stops tracking it, so a replay never sends `--terminal` with a closed handle.
  - The plain start after a skipped `retry_of` announces its request id (`onRetrySkipped`, kept
    in `state.startSkips`). A replay then starts plainly under that id (`skipRequestId`), not
    the refused `retry_of` again.
  - `orca_rebind` fails closed: only `terminal_handle_stale` or `connected: false` allows a
    takeover. Any other `terminal show` error is `rebind_unverified` unless `force`.
  - An MCP-level test checks that an in-process replay after `orca_timeout` reuses the recorded
    handle under the same request id.
  - A pre-warmed terminal is closed after a failed `worker-start` only on a structured Orca
    refusal, never on the adapter's own `orca_timeout`/`orca_unavailable`/`orca_bad_output`.
- `dispatch-start.ts` ends at 393 lines.

## Live Verification

Task 9, 2026-09-30, Orca 1.4.217 and OpenCode 1.18.33 on macOS, run through Sentinal's
`startTask` / `waitForSettlement` with the real runner. Run `run_f74310f49e3b`; fresh Orca
worktrees `e2e-v13-*` under `.orca/worktrees` with `bun install`, all removed afterwards.

| Check | Result |
| ----- | ------ |
| (a) 3 pre-warmed first starts in fresh worktrees | ✅ all `start_path: prewarmed` (input box ready after 9.2 s, 6.3 s, 5.7 s including create + tui-idle), brief on screen, `worker_done` accepted, release `retained` → Sentinal closed its own terminal |
| (b) Heartbeats | ✅ the worker sent 2 heartbeats; `waitForSettlement` received them (`--types` includes `heartbeat`); `worker_done` followed |
| (c) Question → reply | ✅ the worker asked through Orca, `orchestration reply` ("blue") reached it, `worker_done` subject "v13 c blue" |
| (d) `orca_rebind` | ✅ "already bound to this terminal", with no mutation |
| (e) Recovery after closing the worker's tab | ✅ the task went back to `ready`; `startTask({retryOf})` was refused, skipped and started plainly (`retrySkipped: true`, pre-warmed), and `worker_done` was accepted |
| Pending deliveries after the run | ✅ none |

**Not covered:**
- Linux's cold-start drop, which doesn't occur on this Mac.
- Orca #17741's pane-binding defect (14/600 in one report); 6 of 6 pre-warmed `worker_done`
  here were accepted. The off switch is `SENTINAL_ORCA_PREWARM_AGENTS=none`.

## Implementation Tasks

### Task 1: Fixtures + types

**Objective:** Real captures for every step the new code calls.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create fixtures in `src/orca/__fixtures__/` (redacted, `/Users/evan` → `/Users/dev`,
  `_provenance`):
  - `terminal-create.json` (from `g-create.json`);
  - `terminal-wait-tui-idle.json` (`g-wait.json`);
  - `worker-start-terminal-ready.json` (`g-start.json`);
  - `worker-release-external-terminal.json` (`g-release.json`);
  - `terminal-read-home.json` (`race-screen.json`) and `terminal-read-conversation.json`
    (`idle-screen.json`);
  - `worker-show-d11-stall.json` and `worker-read-d11-wide.json`, from issue #13 comment 1
    (`/tmp/orca-drop/i13-c1.md`), with placeholders mapped to concrete ids and the handle
    kept consistent;
  - `request-show-completed.json`, `request-show-absent.json`, `run-show.json`,
    `terminal-show-live.json`, `terminal-show-stale.json` (from `cap-*.json`);
  - `check-heartbeat-only.json`: a synthesized `check` result with two `heartbeat` messages
    (shape from `OrcaMessage`; payload `{taskId, dispatchId, phase}`), marked SYNTHESIZED.
- Modify `src/orca/types.ts`: `OrcaTerminalCreateResult` (`terminal.handle`),
  `OrcaTerminalWaitResult` (`wait.satisfied`), `OrcaTerminalReadResult`
  (`terminal.tail: string[]`).
- Test `src/orca/stall-liveness.test.ts`: the d11 pair → `ownTerminalLive` holds through
  `observation`, and also through the read status + handle; `unverifiableAttention` fires at
  +4 min. Test `src/orca/stall-terminal.test.ts`: `showsHomeScreen` is true for the wide
  160-column d11 tail and for `terminal-read-home`, false for `terminal-read-conversation`.

**Definition of Done:**

- [ ] The tests pass, typecheck is clean, and no fixture contains an unredacted `dcap_` token.

**Verify:** `bun test src/orca/stall-liveness.test.ts src/orca/stall-terminal.test.ts`

### Task 2: Pre-warmed start with fallback

**Objective:** OpenCode workers receive the brief after the input box is mounted.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create `src/orca/dispatch-prewarm.ts` (+ test):
  - `prewarmAgents(env)` parses `SENTINAL_ORCA_PREWARM_AGENTS` (default `["opencode"]`; `none`
    or an empty value gives `[]`).
  - `usePrewarm(agent, placement, env)` is true when the agent is listed and the placement is
    `current` or `{path}`.
  - `prewarmTerminal({ placement, agent, taskId, runner, timeoutMs = 30_000, pollMs = 500,
slackMs = 1_000, clock, sleep })` →
    `{ ok: true, handle, readyMs } | { ok: false, handle?: string, reason }`. Steps:
    1. `terminal create --worktree <path:…|current> --command <agent> --title worker-<taskId>`;
    2. `terminal wait --terminal <h> --for tui-idle --timeout-ms <left>`;
    3. poll `terminal read --terminal <h> --screen` until `showsHomeScreen`;
    4. sleep `slackMs`.

    It never throws. `clock` and `sleep` are injected so tests run instantly.
  - `closeTerminal(handle, runner)` → `orca terminal close --terminal <h>`. Only ever called
    for a handle Sentinal created.
- Modify `src/orca/dispatch-start.ts`:
  - `StartTaskOptions` gains `env?`, and `onTerminalCreated?(handle)` so the MCP layer can
    track terminals across a pending/join.
  - `startOnce` takes an optional `terminal`: `worker-start … --terminal <h>` without
    `--agent`, keeping `--worktree`.
  - In `startTask`, when `usePrewarm` holds:
    - prewarm, then start into the terminal;
    - on `prewarm.ok === false`, close the handle if there is one, then use the `--agent` path
      with `startPath: "agent-fallback"` and the reason;
    - on a failed pre-warmed attempt, `cleanupAttempt` (release), then close our handle, then
      the automatic retry pre-warms a new terminal.
  - The `started` result gains `startPath` and `prewarm?: { terminal, readyMs }`.
  - **Required** (plan-review should_fix): move `cleanupAttempt` and `retryPlacement` into a
    new `src/orca/dispatch-attempts.ts`, so that `dispatch-start.ts` is 370 lines or fewer
    after this task, leaving room for Task 6.
  - Replay without a local record: `request-show`, as in Scope 1 (a new
    `requestOutcome(requestId)` in `dispatch-prewarm.ts`).
- Modify `src/orca/mcp-tools-start.ts`:
  - pass `env: deps.env` and an `onTerminalCreated` that records the handle against the request
    id;
  - when the start resolves, copy it to `state.createdTerminals.set(dispatchId, handle)`;
  - output `start_path` and `prewarm`;
  - the in-process join reuses the same promise, so there is one terminal.
- Modify `src/orca/mcp-tools-shared.ts`: `createdTerminals: Map<string, string>`.
- Tests: Truths 1–3, plus:
  - the `tui-idle` timeout;
  - the failed-attempt retry (two creates, two closes, one release);
  - a pending join (one create);
  - an in-process replay reusing the handle;
  - a replay without a record → `request-show`: `completed` → started with no create;
    `absent` → an error with no create and no `worker-start`;
  - `release_unknown` → the terminal is not closed.

**Definition of Done:**

- [ ] `bun test src/orca/` passes, typecheck is clean, every non-test file is 400 lines or
      fewer, and `wc -l src/orca/dispatch-start.ts` is 370 or fewer.

**Verify:** `bun test src/orca/dispatch-prewarm.test.ts src/orca/dispatch-start.test.ts src/orca/mcp-tools-start.test.ts`

### Task 3: Heartbeat nag fix

**Objective:** Heartbeats stop prompting the coordinator.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- `src/orca/dispatch.ts`: `--types worker_done,escalation,question,heartbeat`.
- `src/orca/mcp-tools-wait.ts`: after auto-acking a heartbeat-only delivery, loop
  `waitForSettlement` again with the remaining time, so a heartbeat never ends the wait early.
  Stall checks run once per call.
- `src/orca/mcp-tools-wait.ts`: on a `consumer_fenced` error, add a hint naming
  `orca_rebind({ run_id })` (moved here from Task 4 because the file belongs to this wave's
  Task 3).
- `src/orca/mcp-tools-wait.ts`:
  - When every message is a `heartbeat`, call `ackDelivery` inside `orca_wait` and render a
    timed-out checkpoint with `heartbeats_acked: N`.
  - In a mixed delivery, leave heartbeats out of `messages`, set `heartbeats: N`, and leave the
    normal `orca_ack` to cover them.
  - For a `question`, the Next line names `orca_reply({run_id, message_id, body})`.
- Tests in `src/orca/mcp-tools-wait.test.ts` and `src/orca/dispatch.test.ts` (the `--types`
  argv).

**Definition of Done:**

- [ ] Truth 5 holds; a mixed delivery is not auto-acked; a heartbeat-only delivery followed
      by a `worker_done` inside the same call returns that `worker_done`; `consumer_fenced`
      gives the `orca_rebind` hint.

**Verify:** `bun test src/orca/mcp-tools-wait.test.ts src/orca/dispatch.test.ts`

### Task 4: `orca_reply` + `orca_rebind`

**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create `src/orca/mcp-tools-coord.ts` (+ test):
  - `orca_reply({ run_id, message_id, body })` → `mutate(["reply","--run",…,"--id",…,"--body",…])`.
  - `orca_rebind({ run_id, force? })`:
    1. `run-show` gives `coordinator_handle`;
    2. if it is the handle from `ORCA_TERMINAL_HANDLE`, answer "already bound";
    3. otherwise `terminal show`: `connected: true` → refuse (`rebind_refused`) unless `force`;
       stale or error → continue;
    4. `mutate(["run-use","--id", run_id])`.

    Tests use the `run-show` and `terminal-show-*` fixtures.
- Modify `src/orca/mcp-tools.ts` (register the tools; header comment),
  `src/orca/mcp-tools.test.ts` and `src/mcp/server.test.ts` (tool lists).
- The `consumer_fenced` hint lives in Task 3 (it edits `mcp-tools-wait.ts`).

**Definition of Done:**

- [ ] Tool tests (argv, `--retry-request`, errors) pass, and the tool lists include both.

**Verify:** `bun test src/orca/mcp-tools-coord.test.ts src/orca/mcp-tools.test.ts src/mcp/server.test.ts`

### Task 5: Close Sentinal-created terminals on a retained release

**Dependencies:** Task 2
**Wave:** 3

**Files:** `src/orca/mcp-tools-settle.ts` (+ test).

- After `releaseWorker` answers `retained` for a dispatch in `state.createdTerminals`, run
  `closeTerminal(handle)`.
- Report `closed_terminal: handle`, or the close error (still `ok: true` for the release).
- Delete the entry either way.
- Other `retained` answers are unchanged: the line "Orca kept the terminal" stays.

**Definition of Done:**

- [ ] Truth 4 holds.

**Verify:** `bun test src/orca/mcp-tools-settle.test.ts`

### Task 6: `retry_of` on a ready task

**Dependencies:** Task 2
**Wave:** 3

**Files:** `src/orca/dispatch-start.ts` (+ test) and `src/orca/mcp-tools-start.ts`, for the
output line only. Task 5 does not touch these.

- When the **caller's** `retryOf` attempt (never the automatic retry) fails with
  `task_not_startable`, `data.status === "ready"` and no unmet dependencies, retry once without
  `retry_of`, with a fresh request id. If this start pre-warmed a terminal, reuse it.
- Return `retrySkipped: true` plus Orca's message. `orca_start` shows "retry_of was refused
  because the task is already ready (its previous attempt settled); started it plainly".

**Definition of Done:**

- [ ] Truth 6 holds. When status is not `ready`, the result is still `blocked`; the automatic
      retry is unaffected; a pre-warmed terminal is reused (one create).
      `wc -l src/orca/dispatch-start.ts` is 400 or fewer.

**Verify:** `bun test src/orca/dispatch-start.test.ts src/orca/mcp-tools-start.test.ts`

### Task 7: Prose in both targets

**Dependencies:** Tasks 2–6
**Wave:** 4

**Files:** `targets/claude-code/commands/spec-master-execute.md`,
`targets/opencode/skills/spec-master-execute/SKILL.md`,
`targets/claude-code/commands/spec-implement.md` and
`targets/opencode/skills/spec-implement/SKILL.md`; then the parity baselines (once) and
`embed-assets`.

- The Start step says `orca_start` pre-warms OpenCode automatically (`start_path`).
- The attention bullet says what to tell the user: "the brief was probably dropped (a known
  OpenCode/Orca cold-start race: Orca #22580). Please close only that worker's terminal tab —
  not Orca's stop, which can delete the worktree — and I'll start the task again", then call
  `orca_start` for the task again.
- A `question` is answered with `orca_reply` before the worker's `ask` times out.
- After an Orca restart, or on `consumer_fenced`, use `orca_rebind({ run_id })`.
- Apply the edits symmetrically; the hunk counts must stay unchanged.

**Definition of Done:**

- [ ] `rg -n "orca_reply|orca_rebind|close only" targets/` matches both targets, and
      `bun test src/cli/` passes.

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

### Task 8: Dev docs, README, `.orca/` ignores

**Dependencies:** Tasks 2–6
**Wave:** 4

**Files:**

- `README.md`: 49 tools; Orca 11 (`orca_reply`, `orca_rebind`).
- `.sentinal/rules/sentinal-mcp-servers.md`: the header count, the Orca table rows, and a
  paragraph on the pre-warmed start (steps, environment variable, fallback, closing created
  terminals, the #17741 risk).
- `.sentinal/rules/sentinal-project.md`: one sentence.
- `.sentinal/skills/sentinal-orca-cli/SKILL.md`: facts about the `--agent` vs `--terminal`
  exclusivity, the macOS timing measurements, the `.orca/worktrees` layout, and the heartbeat
  deliveries.
- The already-added `.orca/.gitignore`, `eslint.config.mjs` ignore and `.prettierignore`
  (recorded here and committed with this work).

**Definition of Done:**

- [ ] `bunx prettier --check` passes on the touched files, and the counts match
      `registerOrcaTools`.
- [ ] The docs name `SENTINAL_ORCA_PREWARM_AGENTS=none` as the off switch.

**Verify:** `bunx prettier --check README.md .sentinal/rules/sentinal-mcp-servers.md .sentinal/rules/sentinal-project.md .sentinal/skills/sentinal-orca-cli/SKILL.md && rg -n "49 tools" README.md .sentinal/rules/sentinal-mcp-servers.md`

### Task 9: Live check on Orca 1.4.217

**Dependencies:** Tasks 1–8
**Wave:** 5

A bun script with the real runner and throwaway Orca worktrees (`e2e-v13-…`, `bun install`
setup) does the following:

- (a) Starts 3 OpenCode workers pre-warmed. Each `start_path` is `prewarmed`, the dispatch id
  is on screen, `worker_done` is accepted (this checks capability-to-pane binding, #17741), the
  release answers `retained`, and Sentinal closes its own terminal.
- (b) A heartbeat-only delivery is auto-acked: brief a worker to heartbeat once, then wait.
- (c) `orca_reply` answers a worker's `ask`.
- (d) `orca_rebind` on the current Run answers "already bound". On a Run bound to a closed
  terminal, it rebinds.
- (e) **Recovery:** close a pre-warmed idle worker's terminal (standing in for the user
  closing the tab), then `startTask` with `retryOf` → the retry is skipped → it starts
  plainly, and `worker_done` is accepted.
- (f) **Nag:** with a worker sending heartbeats, count the "You have N orchestration message"
  prompts that reach this coordinator session during the waits. The expectation is zero.
- **Not covered statistically:** Orca #17741's pane-binding defect (14 of 600 in one report).
  Three starts detect it only about 7% of the time, so the docs name the off switch instead.

Record the results under "## Live Verification", then clean up the worktrees and branches.

**Definition of Done:**

- [ ] (a)–(d) pass and are recorded; no `e2e-v13` worktree or branch remains.
