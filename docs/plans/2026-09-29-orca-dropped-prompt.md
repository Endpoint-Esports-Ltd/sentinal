# Orca Dropped-Prompt Detection and Recovery (issue #12) Implementation Plan

Created: 2026-09-29
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** A supervised Orca worker whose launch prompt never reached its agent is reported by
`orca_wait` as a stall with an `evidence_id`, so the coordinator can `orca_stop` it and retry it
with a fresh capability through `orca_start({ retry_of })`. Stall detection also works for
workers whose output is terminal text rather than a transcript (every OpenCode worker today).

**Architecture:** A new pure module, `src/orca/stall-terminal.ts`, reads the terminal tail that
`worker-read --source auto` already returns when there is no transcript. `stallVerdict` gains a
`never-started` reason and detects auth errors in that tail. `collectStalls` calls
`worker-show` only for suspect rows, to confirm the dispatch age and the missing heartbeat.
`orca_start` gets a `retry_of` parameter and reports whether Orca could confirm delivery. A failed
start no longer runs `orca terminal close`. `orca_wait` also reports settled workers whose
terminals still await release. Prose in both targets now defers generic Orca rules to Orca's
version-matched guide (`orca skills get orchestration`, served by the binary, so it needs no
installed skill files). The prose keeps only Sentinal-specific steps, aligns worker briefs with
Orca's Task-spec contract, and routes a dispatched worker's questions through its preamble's
`ask` command. The dev docs follow.

**Tech Stack:** TypeScript, Bun test, the `orca` CLI adapter (`src/orca/cli.ts`), zod 4, the MCP SDK.

## Scope

### In Scope

- `never-started` stall: live agent, no `worker_done`, no heartbeat, dispatched more than
  `neverStartedMs` ago (default 3 min), and a terminal tail that shows the agent's empty home
  screen and does not contain the dispatch id (i.e. the preamble was never echoed).
- `auth-error` stall detected from the terminal tail (the transcript path is unchanged).
- `orca_start({ retry_of })` → `worker-start --retry-of <dispatch>`, plus
  `delivery_confirmed: false` when Orca's receipt says the provider cannot confirm submission.
- Remove the `terminal close` fallback in `cleanupAttempt`. Report retained terminals and Orca's
  recovery text instead.
- `orca_wait`'s "Next" hint names the retry path for `never-started`.
- `orca_wait` reports **reclaimable** terminals: settled dispatches whose terminal still awaits
  release. The data comes from the `worker-list` call it already makes. Orca's guide says a
  coordinator must not end its turn while any remain.
- Orca Mode prose in both targets (`spec-master-execute`, `spec-implement`):
  - the new stall kind and recovery with `retry_of`;
  - never resending a brief with `dispatch-show --preamble` or `terminal send`;
  - **defer to Orca's guide**: replace restated generic Orca rules with pointers to
    `orca skills get orchestration [--reference …]`, keeping only Sentinal-specific steps;
  - **worker briefs**: follow Orca's Task-spec contract (Target / Change / Constraints /
    Ownership / Observable acceptance) and drop lifecycle CLI flags such as `--outcome` and
    `--files-modified`, which the injected preamble owns. Keep only the success criterion.
- **Worker question routing**: the `/spec` dispatcher (`spec.md`, both targets) says that when
  the conversation holds a live Orca dispatch preamble, every question goes through the
  preamble's `ask` command, never a local question prompt (Orca worker contract).
- Dev docs: `.sentinal/rules/sentinal-mcp-servers.md`, `sentinal-project.md`, and the
  `sentinal-orca-cli` skill, trimmed to facts specific to our adapter. Generic Orca rules defer
  to the guide.
- A live check against the real Orca (no code) of the negative case and the stop → retry path.

### Out of Scope

- Gating starts on TUI readiness (user decision: detect and recover only).
- An `idle-no-report` stall for terminal-output workers (no timestamps in a terminal tail, so it
  would rest on absence).
- Home-screen signatures for agents other than OpenCode (only OpenCode's was observed live).
  Other agents keep today's behaviour: no `never-started` verdict from a terminal tail.
- The upstream Orca race itself, a release, and commenting on or closing GitHub issue #12. These
  follow verification, with the user's go-ahead.

## Context for Implementer

- **Live-test facts (2026-09-29, Orca 1.4.216, OpenCode 1.18.33, macOS; memory #1897).**
  Raw captures are in `/tmp/orca-drop/` (`round2/read-1-0.json`, `round2/show-1-0.json`,
  `round2/list-0.json`, `race-screen.json`, `g-release.json`, `round1/start-1.json`).
  - `worker-read --source auto` for OpenCode returns
    `{ source: "terminal", fallbackReason: "provider_unsupported", terminal: { handle, status,
tail: string[], truncated, … }, projection }` and **no `transcript`**. So `stallVerdict`
    (`src/orca/stall.ts`) answers "no transcript turn to judge" for every OpenCode worker.
  - When the prompt lands, the tail shows the echoed preamble, which contains the dispatch id
    (`ctx_…`), and it also shows `--dispatch-capability dcap_…`. ⛔ That capability is a secret.
    Evidence strings and fixtures must redact `dcap_[A-Za-z0-9_-]+`.
  - A dropped prompt (reproduced with `orca terminal send` to a booting OpenCode) leaves the
    splash logo and a prompt box reading `Ask anything… "…"`, with no dispatch id anywhere.
  - `worker-show --dispatch <id>` → `result.dispatch.{status, dispatchedAt, lastHeartbeatAt}`.
    `dispatchedAt` is `"YYYY-MM-DD HH:MM:SS"` in **UTC without a zone**: parse it as UTC.
    A worker that finished in under 30 s still had `lastHeartbeatAt: null`, so a missing
    heartbeat alone proves nothing.
  - `worker-list` rows carry no `dispatchedAt` or heartbeat, so `worker-show` is required, but
    only for rows whose tail already looks never-started.
  - `worker-start` receipt: `turnStart: "unsupported"`,
    `prompt.observation: "unsupported"`, `stage: "input_accepted"` (see the existing fixture
    `src/orca/__fixtures__/worker-start-ready.json`).
  - `worker-release` after a start on a caller-created terminal → `retained` / `external_terminal`.
- **Orca's rules** (`orca skills get orchestration --reference references/recovery-and-cleanup.md`):
  retry only a proven failed or stopped attempt, with `--retry-of` and an explicit placement
  and agent; never substitute `terminal close` for release; absence never authorizes a stop.
- **Patterns to follow:**
  - Pure verdict plus injected runner: `src/orca/stall.ts` (`stallVerdict`, `collectStalls`
    with a shared time budget).
  - Tests replay fixtures and never run the real `orca`: `src/orca/stall.test.ts:12-60`,
    `src/orca/dispatch-start.test.ts:130-160` (the `queue` runner).
  - Evidence map and one-shot `evidence_id`: `src/orca/mcp-tools-settle.ts:80-160`
    (`orca_wait`) and `:240-280` (`orca_stop`).
- **Gotchas:**
  - Keep every file under 400 lines. `stall.ts` is 231 lines, which is why tail analysis gets
    its own file.
  - `src/orca/types.ts` is shared. Only Task 1 edits it, so Wave 2 tasks do not collide.
  - After any `targets/` edit, run `bun run embed-assets` and regenerate parity baselines once
    (`UPDATE_PARITY_BASELINES=1 bun test src/cli/target-parity.test.ts`). Only Task 5 touches
    `targets/`.
  - The TDD guard needs `sentinal_tdd_set_state RED_CONFIRMED` immediately before each
    implementation write.

## Assumptions

- A dispatch id in the tail means the preamble was delivered. Supported by the live test: all 9
  landed workers showed `ctx_…` on screen. Tasks 1 and 2 depend on this.
- OpenCode's home screen is identified by `Ask anything`, which disappears once a conversation
  exists. Supported by `race-screen.json` versus `idle-screen.json`. Tasks 1 and 2 depend on
  this.
- Orca accepts `worker-start --retry-of` for a dispatch stopped with `worker-stop`, and mints a
  new capability. Supported by the guide's recovery table ("`stopped` → start a replacement with
  `--retry-of`"). Tasks 3 and 7 depend on this, and Task 7 verifies it live.
- A three-minute default is long enough. Starts took 9–21 s and all nine prompts were echoed
  within 22 s. Task 2 depends on this.

## Testing Strategy

- Unit tests with recorded or composite fixtures. The runner is injected, never the real `orca`.
- Parity and embed tests for the prose.
- Task 7 is a live check against the real Orca, using throwaway worktrees and no MCP tools. It
  runs a bun script that calls `collectStalls` / `startTask` with the real runner.

## Risks and Mitigations

| Risk                                                                                              | Likelihood | Impact                               | Mitigation                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| False `never-started` on a working OpenCode whose preamble scrolled out of the tail               | Low        | A wrongly stopped worker             | All four conditions must hold: the home screen is visible (it disappears once a conversation exists), the dispatch id is absent from the joined tail, there is no heartbeat, and the age exceeds the threshold. **The coordinator stops and retries a `never-started` worker automatically, once per task** (Task 5). This is safe because a worker showing the empty home screen has, by construction, done no work, so a stop loses nothing. A second `never-started` stall on the same task, and every other stall kind, go to the user (Retry / Skip / Stop) |
| OpenCode changes its placeholder text                                                             | Med        | Detection silently off (today's state) | Signatures are one exported table with a test per entry. Failure is fail-safe (no verdict)                                                                                |
| Capability token leaks into evidence or fixtures                                                  | Med        | Secret disclosure                     | `redactCapabilities()` runs on every tail string before use; a test asserts no `dcap_` survives                                                                            |
| Removing `terminal close` leaves stray tabs after failed starts                                   | Med        | Clutter                              | Report `unclosedTerminals` with Orca's recovery text (the user chose this)                                                                                                 |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **The tail is not the whole screen** (Tasks 1–2). `worker-read --limit 20` returns the last 20
   lines, and the splash plus `Ask anything` may not fall inside them. → Trigger: the composite
   fixture built from `race-screen.json` has `Ask anything` more than 20 lines from the bottom.
   The fix is to raise `READ_LIMIT`, or to use `terminal read --screen` for suspects.
2. **`--retry-of` is refused after `worker-stop`** (Tasks 3, 7). → Trigger: Task 7's live retry
   returns `task_not_startable` with `data.retryOf`. Record it, and change the prose to whatever
   Orca's `nextSteps` says.
3. **Terminal-source reads lack `projection.liveness`** (Task 2), so the verdict never reaches the
   tail check. → Trigger: `round2/read-1-0.json` has `projection`, but the live list row must also
   carry `liveness: live` for an in-progress worker. Check this in Task 7.

## Execution Waves

**Wave 1**, foundations: Task 1 (pure tail analysis, types, fixtures).
**Wave 2**, parallel: Task 2 (`stall.ts`) and Task 3 (`dispatch-start.ts`,
`mcp-tools-start.ts`). The two share no files and both depend on Task 1's types.
**Wave 3**, parallel: Task 4 (`mcp-tools-settle.ts`) and Task 6 (`.sentinal/` docs and skill).
The two share no files.
**Wave 4**: Task 5 (all `targets/` prose, and the one parity regeneration). It comes after
Task 4 because the prose names Task 4's `reclaimable` output. Keeping every `targets/` edit in
one task means the baselines are regenerated once and no two tasks write the fixture directory.
**Wave 5**: Task 8 (worker question routing across the 12 `/spec` phase files). This is a
separate wave from Task 5 because both regenerate the same parity fixture directory.
**Wave 6**: Task 7 (live verification), which needs everything above.
**Wave 7**: Task 9 [NEW], added after Task 7 found that `worker-stop` can answer
`stop_unknown`. This task touches `src/orca/` code, `targets/` prose (one regeneration) and the
docs, which is why it runs as a single sequential task.

## Goal Verification

### Truths

1. `src/orca/stall.ts` contains `"never-started"` in `StallReason`.
2. `bun test src/orca/stall.test.ts` includes a test in which the composite home-screen fixture,
   an age over 3 minutes and `lastHeartbeatAt: null` produce `stalled: true, reason:
"never-started"`. The same input with the dispatch id in the tail produces no stall.
3. `src/orca/dispatch-start.ts` no longer contains `"terminal", "close"`.
4. The `orca_start` schema has `retry_of`, and a test asserts that `worker-start` receives
   `--retry-of <id>`.
5. `rg -n "dispatch-show --preamble" targets/` shows a "never" rule in both
   `spec-master-execute` files.
6. `rg -o --no-filename "dcap_[A-Za-z0-9_-]+" src/orca/__fixtures__ docs/plans/2026-09-29-orca-dropped-prompt.md | rg -vx "dcap_REDACTED"`
   is empty.
7. `src/orca/mcp-tools-settle.ts` contains `reclaimable`, and a test asserts that `orca_wait`
   lists a settled, unreleased dispatch.
8. `rg -n -- "--outcome|--files-modified" targets/` is empty, and
   `rg -n "Supervised Orca worker" targets/` matches all 12 `/spec` phase files.

### Artifacts

| Artifact                          | Provides                                 | Exports                                                                          |
| --------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `src/orca/stall-terminal.ts`      | Pure terminal-tail analysis              | `terminalTail`, `redactCapabilities`, `showsHomeScreen`, `mentionsDispatch`, `AUTH_PATTERNS` |
| `src/orca/stall.ts`               | `never-started` + tail auth verdicts     | `stallVerdict`, `collectStalls`, `DEFAULT_NEVER_STARTED_MS`                      |
| `src/orca/dispatch-start.ts`      | `retryOf` start; no `terminal close`     | `startTask`                                                                      |
| `src/orca/mcp-tools-start.ts`     | `orca_start({ retry_of })`               | `registerOrcaStartTool`                                                          |
| `src/orca/mcp-tools-settle.ts`    | `orca_wait` recovery hints + reclaimable | `registerOrcaSettleTools` (existing)                                             |
| `targets/*/commands/spec.md`      | Worker question routing through `ask`    | prose rule                                                                       |

### Key Links

| From                          | To                          | Via                           | Pattern                   |
| ----------------------------- | --------------------------- | ----------------------------- | ------------------------- |
| `src/orca/stall.ts`           | `src/orca/stall-terminal.ts` | import                        | `from "./stall-terminal.js"` |
| `src/orca/stall.ts`           | `orca worker-show`          | suspect confirmation          | `"worker-show"`           |
| `src/orca/mcp-tools-start.ts` | `startTask`                 | `retryOf: args.retry_of`      | `retryOf: args\.retry_of` |

## Progress Tracking

- [x] Task 1: Terminal-tail analysis module, types, fixtures (Wave 1)
- [x] Task 2: `never-started` and tail-auth verdicts in `stallVerdict` / `collectStalls` (Wave 2)
- [x] Task 3: `orca_start({ retry_of })`, `delivery_confirmed`, no `terminal close` (Wave 2)
- [x] Task 4: `orca_wait` / `orca_stop` hints for `never-started` recovery + reclaimable terminals (Wave 3)
- [x] Task 5: Orca Mode prose in both targets: recovery, defer to Orca's guide, Task-spec briefs, worker `ask` routing (Wave 4)
- [x] Task 6: Dev rules and a trimmed `sentinal-orca-cli` skill (Wave 3)
- [x] Task 8: Supervised-worker question routing in every `/spec` phase, both targets (Wave 5)
- [x] Task 7: Live verification against the real Orca (Wave 6)
- [x] Task 9: [NEW] `orca_abandon` for a `stop_unknown` stop, found in Task 7 (Wave 7)

**Total Tasks:** 9 | **Completed:** 9 | **Remaining:** 0

## Implementation Notes

- **Task 2:** the plan's `waitRun` is really `waitForSettlement` (`src/orca/dispatch.ts`), the
  only production caller of `collectStalls`. It now passes `neverStartedMs` and returns
  `reclaimable`. The task added two exports: `parseDispatchedAt` and `ReclaimableTerminal`.
  Also added: a null dispatch id never yields `never-started`, because the tail check cannot
  run.
- **Task 3:** `closedTerminals` stays in the type for back-compat and is always `[]`. A
  `retained` release with no reason reads `retained: retained`.
- **Task 4:** `StallVerdict` gained an optional `taskId`, taken from the `worker-list` row, so
  `orca_stop`'s never-started hint can name the exact `orca_start({ task_id, …, retry_of })`
  call. `orca_wait` stalls carry `task_id`.
- **Verification review (should_fix, fixed):**
  - The home-screen signature now needs **both** the splash logo's top row and the framed
    `┃  Ask anything…` placeholder, each anchored at a line start. An agent that greps or
    prints the phrase, or cats a fixture, is no longer taken for the home screen.
  - A tail `auth-error` now needs the provider's own wording (the loose `401 … token` pattern
    is left out) within the last 8 non-blank lines.
  - When the stall check fails, `orca_wait` reports `reclaimable_unknown: true` rather than an
    empty list that could be read as "wave done".
  - A `pending` answer to a `retry_of` start repeats `retry_of` in its replay hint and result,
    so the replay keeps the same argv. The realistic-looking token in a test was replaced with
    an obviously fake one.
- **Task 8:** `spec.diff` went from 2 to 3 hunks. The shared "Supervised Orca worker" section is
  byte-identical in both `spec.md` files, and the per-phase pointer lines are identical in all
  five pairs. The extra hunk appeared only because the new common block sits between two
  regions that already differed, so diff splits the old first hunk in two. That is context,
  not drift. The expected state of the `sentinal-parity-baselines` skill is now `spec 3`.

## Verification

- **Gates (final run):** `typecheck`, `typecheck:plugin`, `lint`, `format:check` and
  `scripts/check-embed-assets.mjs` all exit 0. `bun test` gives 4463 pass, 0 fail.
- **Spec review:** 8/8 truths verified. Two should_fix and three suggestions, all fixed (see
  Implementation Notes).
- **Parity baselines:** hunk counts are unchanged except `spec` going 2→3 (explained in
  Implementation Notes); `spec-verify.diff` is still 0 bytes.
- **`impact_analysis` said HIGH, but these are false alarms.** Its 23 "unexpected" files are all
  in the plan, written as brace globs or relative names that its parser does not read. Its five
  over-length files are all test files, which are exempt. No non-test file exceeds 393 lines.
- **Not verified:**
  - A real dropped prompt: it could not be produced through `worker-start` on this machine, so
    the positive case rests on a composite fixture.
  - Claude workers: the Claude login inside Orca is stale, so only OpenCode workers were run
    live.

## Live Verification

Task 7, 2026-09-29, Orca 1.4.216 and OpenCode 1.18.33 on macOS. Driven through Sentinal's
adapter with the real runner. Run `run_92d5d3ae5ff3`. The throwaway worktrees
`e2e-v12-a`/`-d` were removed afterwards.

| Check | Result |
| ----- | ------ |
| (a) A worker whose brief landed is not `never-started` (`collectStalls`, `neverStartedMs: 1000`) | ✅ `ctx_fdaf6ee50c0f` → `stalled: false`, "live; terminal tail shows no home screen"; `deliveryConfirmed: false` as expected for OpenCode |
| (b) `worker-stop` → `--retry-of` | ⚠️ `worker-stop` answered **`stop_unknown`**: Orca had marked the terminal `user_owned` / `user_takeover` (nobody typed into it; cause unknown). `--retry-of` was then refused ("cannot retry from Dispatch"), which is Pre-Mortem 2. Orca's documented recovery, **`worker-abandon`**, then `--retry-of` → new dispatch `ctx_ada165312fe2`, whose `worker_done` ("probe B ok") was **accepted**, so the fresh capability works. This led to Task 9 |
| (b2) `reclaimable` | ✅ It listed `ctx_ada165312fe2` before `worker-release` and no longer listed it after (`released`) |
| (b3) A brief with no lifecycle flags still reports | ✅ Both the retried worker and probe D sent a correct `worker_done` from a brief that only said "report completion through your Orca preamble" |
| (d) Question routing | ✅ `ctx_17d7fd780646` asked through `orca orchestration ask`. The question arrived as an Orca `question`, no local prompt appeared on screen, and after the reply the worker sent `worker_done` |
| Redaction | ✅ No `dcap_` token in any capture; Orca's own `worker-read` showed "[dispatch capability redacted]" in this output |
| (c) A real dropped prompt | ➖ Not reproducible through `worker-start` on this machine (9/9 landed in the earlier probe). The positive case rests on the composite fixture |

**Open (not verified live):** Claude workers (the Claude login inside Orca is stale). They get
the same Orca preamble, which carries the exact `worker_done`/`ask` commands.

## Implementation Tasks

### Task 1: Terminal-tail analysis module, types, fixtures

**Objective:** Pure helpers that read a terminal-fallback `worker-read` result, plus the types and
fixtures that the later tasks need.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/orca/stall-terminal.ts`
- Create: `src/orca/stall-terminal.test.ts`
- Modify: `src/orca/stall.ts` (only to import `AUTH_PATTERNS` from the new module)
- Modify: `src/orca/types.ts`: add
  `terminal?: { handle?: string; status?: string; tail?: string[] }` and
  `fallbackReason?: string` to `OrcaWorkerReadResult`; add `OrcaWorkerShowResult`
  (`dispatch: { id; status; dispatchedAt?; lastHeartbeatAt? }`, `worker?`, `projection?`); add
  `turnStart?` and `prompt?: { observation?: string; provider?: string }` to the start receipt
  type.
- Create fixtures in `src/orca/__fixtures__/`, each with a `_provenance` note and `dcap_` tokens
  redacted:
  - `worker-read-terminal-started.json`, from `/tmp/orca-drop/round2/read-1-0.json`.
  - `worker-read-terminal-home.json`, a **composite**: the read envelope with `race-screen.json`'s
    tail and an in-progress projection with `liveness: live`.
  - `worker-show-dispatched.json`, from `round2/show-1-0.json` with `status: "dispatched"`,
    `completedAt` null and `lastHeartbeatAt` null.
  - If `/tmp/orca-drop` is gone, rebuild the fixtures from the shapes documented in Context.

**Key Decisions / Notes:**

- Move `AUTH_PATTERNS` from `stall.ts` into this module and export it, and in the same task
  change `stall.ts` to import it. That is the only `stall.ts` edit in Task 1. Task 2, which
  rewrites `stall.ts`, runs in a later wave, so there is no conflict. This means Task 1 also
  lists `Modify: src/orca/stall.ts (import only)`.
- `terminalTail(read): string[] | null` returns lines only when `source === "terminal"` and
  `terminal.tail` is an array.
- `redactCapabilities(s)` replaces `dcap_[A-Za-z0-9_-]+` with `dcap_REDACTED`.
- `HOME_SCREEN_SIGNATURES: ReadonlyArray<{ agent: string; pattern: RegExp }>` has one entry,
  OpenCode: `/Ask anything/`. `showsHomeScreen(tail)` tests the signatures.
- `mentionsDispatch(tail, id)` joins the tail, strips whitespace and the box-drawing
  characters (`┃ ╹ │`), then does a substring test. This way a `ctx_…` id wrapped across two
  terminal lines still matches. Test it with an id split across lines.
- Tail window: in the recorded home screen (`race-screen.json`, 12 lines) `Ask anything` is 7
  lines from the bottom, well inside `READ_LIMIT = 20`. Add a test that asserts the composite
  fixture's tail length is ≤ 20 and that `showsHomeScreen` is true for its **last 20** lines
  (Pre-Mortem 1).
- `authErrorInTail(tail)` returns the redacted, clipped matching line or `null`.

**Definition of Done:**

- [ ] `bun test src/orca/stall-terminal.test.ts src/orca/stall.test.ts` passes.
- [ ] Tests: the started fixture has the dispatch id and no home screen; the home fixture has the
      home screen and no dispatch id; `redactCapabilities` leaves no `dcap_` token apart from
      `dcap_REDACTED`; a tail containing `Please run /login` yields an auth line.
- [ ] `rg -o --no-filename "dcap_[A-Za-z0-9_-]+" src/orca/__fixtures__ | rg -vx "dcap_REDACTED"` is
      empty. It matches **tokens**, not lines, so a line that also contains `dcap_REDACTED`
      cannot hide a real token.
- [ ] `bun run typecheck` is clean.

**Verify:** `bun test src/orca/`

### Task 2: `never-started` and tail-auth verdicts

**Objective:** `stallVerdict` recognises a never-started worker and an auth error from a terminal
tail. `collectStalls` confirms suspects with `worker-show`.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/orca/stall.ts`
- Modify: `src/orca/dispatch.ts`: `waitRun` (around `:289`) is the only production caller of
  `collectStalls`. It must pass `neverStartedMs` through and return `reclaimable` on its
  result. Otherwise the real `orca_wait` path drops both while the `collectStalls` unit tests
  still pass.
- Test: `src/orca/stall.test.ts`, `src/orca/dispatch.test.ts` (a `waitRun` test asserting that
  `reclaimable` and a `never-started` stall reach its result)

**Key Decisions / Notes:**

- `StallReason` adds `"never-started"`.
- `StallInput` adds `show?: OrcaWorkerShowResult | null` and `neverStartedMs?: number`
  (`DEFAULT_NEVER_STARTED_MS = 180_000`).
- Evaluation order, after the `worker_done` and liveness gates (unchanged, so `unverifiable` still
  authorizes nothing):
  1. The transcript path as today.
  2. Otherwise, if `terminalTail` exists:
     - `authErrorInTail` → `auth-error`.
     - Otherwise, if `showsHomeScreen && !mentionsDispatch && show?.dispatch.lastHeartbeatAt == null && age > neverStartedMs`
       → `never-started`. The evidence states the age, "no heartbeat", "home screen visible" and
       "dispatch id never shown".
     - Otherwise, not stalled, with a reason explaining which condition failed.
- `dispatchedAt` parsing: append `Z` when the string has no zone, then replace the space with
  `T`. If it doesn't parse, there is no verdict (absence).
- `collectStalls` also returns
  `reclaimable: Array<{ dispatchId, taskId?, terminal? }>` from the **same** `worker-list`
  call. These are rows with `terminalState === "reclaimable"` (an observed value; see
  `/tmp/orca-drop/round2/list-0.json`), and **settled** rows are included, which the stall
  filter excludes. This makes no extra Orca call. It is also reported when the stall reads run
  out of budget.
- `collectStalls`: after each `worker-read`, **only if** the tail shows the home screen without
  the dispatch id, call `orchestration worker-show --dispatch <id>` within the shared budget. If
  that call fails, it counts as absence and produces no verdict. Pass `neverStartedMs` through
  `CollectStallsOptions`.
- Evidence strings pass through `redactCapabilities`.

**Definition of Done:**

- [ ] Tests:
  - Home fixture, show fixture and age 4 min → `never-started`.
  - Age 2 min → not stalled.
  - A heartbeat present → not stalled.
  - The dispatch id present in the tail → not stalled.
  - `unverifiable` liveness → not stalled.
  - The started fixture never calls `worker-show` (assert on the runner calls).
  - A failed `worker-show` → not stalled.
  - A tail containing a 401 → `auth-error`.
  - A transcript fixture still behaves as before.
  - A `worker-list` with one reclaimable settled row and one active row → `reclaimable` lists
    only the settled one, and there is still exactly one `worker-list` call.
- [ ] `bun test src/orca/` passes; `stall.ts` is under 400 lines.

**Verify:** `bun test src/orca/stall.test.ts`

### Task 3: `orca_start({ retry_of })`, `delivery_confirmed`, no `terminal close`

**Objective:** A supported retry that mints a fresh capability, honest reporting of unconfirmed
delivery, and no `terminal close` fallback.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/orca/dispatch-start.ts`, `src/orca/mcp-tools-start.ts`
- Test: `src/orca/dispatch-start.test.ts`, `src/orca/mcp-tools-start.test.ts`

**Key Decisions / Notes:**

- `StartTaskOptions.retryOf?: string`. The first attempt passes `--retry-of <retryOf>` and keeps
  `--retry-request <requestId>`, so a pending replay still works. The automatic one-time retry
  after a failed attempt is unchanged: it retries the failed attempt's own dispatch.
- `orca_start` schema: `retry_of: z.string().optional().describe("Dispatch id of a STOPPED or
FAILED attempt of this task (after orca_stop): starts a replacement with a fresh capability")`.
  The description names the tool's recovery role.
- `StartTaskResult` `started` gains `deliveryConfirmed: boolean`. It is `false` when the receipt
  has `turnStart === "unsupported"` or `prompt.observation === "unsupported"`. `orca_start`
  returns `delivery_confirmed` and, when it is `false`, the line "Orca cannot confirm this agent
  received the brief; orca_wait reports a never-started stall if it did not".
- `cleanupAttempt`: delete the `terminal close` loop. When the release answers `retained`, every
  residual terminal goes to `unclosedTerminals` with `reason: "retained: <reason>"` and Orca's
  `recovery` text. Update the doc comment.
- Update the existing test at `dispatch-start.test.ts:130` ("failed → closes the residual
  terminal") so that it expects no `terminal close` call and the terminal listed as unclosed.

**Definition of Done:**

- [ ] Tests:
  - `retry_of` → argv contains `--retry-of ctx_old`.
  - The ready fixture → `delivery_confirmed: false`.
  - A receipt with `turnStart: "confirmed"` → `true`.
  - `retained` → no `terminal close` call, and the terminal appears in `unclosedTerminals`.
- [ ] `rg -n '"terminal", "close"' src/orca/` is empty (apart from tests asserting absence).
- [ ] `bun test src/orca/` passes.

**Verify:** `bun test src/orca/dispatch-start.test.ts src/orca/mcp-tools-start.test.ts`

### Task 4: `orca_wait` / `orca_stop` hints

**Objective:** The coordinator is told how to recover each kind of stall.
**Dependencies:** Tasks 2, 3
**Wave:** 3

**Files:**

- Modify: `src/orca/mcp-tools-settle.ts`
- Test: `src/orca/mcp-tools-settle.test.ts`

**Key Decisions / Notes:**

- The `orca_wait` "Next" hint for a `never-started` stall reads: "orca_stop(dispatch_id,
  evidence_id), then orca_start({task_id, worktree, agent, retry_of: dispatch_id}); never resend
  the brief by hand (dispatch-show --preamble omits the capability)". Other stalls keep "ask the
  user Retry / Skip / Stop".
- `orca_stop`'s success text for `never-started` names the `retry_of` call, with the task id
  taken from the verdict when it is known.
- Update the `orca_wait` tool description: "stall verdicts (exited, auth error, idle, or a brief
  that never reached the agent)".
- `orca_wait` prints and returns `reclaimable` (dispatch id + task id) for **this Run only**
  (`worker-list --run`). It excludes every dispatch for which this session already got **any**
  release answer. `orca_release` adds to `state.released` for every answer, `retained`
  included (`mcp-tools-settle.ts:301`). So a terminal that Orca retains, and that may stay
  `reclaimable` in Orca's eyes, cannot keep the coordinator looping. When the list is non-empty, the "Next" hint
  adds: "orca_release each reclaimable dispatch once its worker_done is processed; do not end
  the coordinator turn while any remain".

**Definition of Done:**

- [ ] Tests: a runner that yields a `never-started` verdict → the output names `retry_of`, and
      `orca_stop` success names it too.
- [ ] Tests: reclaimable rows appear in the output and in structured content; a dispatch whose
      release was answered `retained` is omitted on the next wait.
- [ ] `bun test src/orca/` passes.

**Verify:** `bun test src/orca/mcp-tools-settle.test.ts`

### Task 5: Orca Mode prose in both targets (recovery, defer to Orca's guide, briefs, worker questions)

**Objective:** Coordinators follow the new recovery and defer generic Orca rules to Orca's
version-matched guide. Worker briefs follow Orca's Task-spec contract. A dispatched worker
running `/spec` asks its questions through Orca rather than a local prompt nobody can answer.
**Dependencies:** Tasks 2, 3, 4 (the prose names `retry_of`, `delivery_confirmed` and
`reclaimable`)
**Wave:** 4

**Files:** (prose only; all `targets/` edits live in this one task so the parity baselines are
regenerated once)

- Modify: `targets/claude-code/commands/spec-master-execute.md`,
  `targets/opencode/skills/spec-master-execute/SKILL.md`,
  `targets/claude-code/commands/spec-implement.md`,
  `targets/opencode/skills/spec-implement/SKILL.md`
- Regenerate: parity baselines (once) and `src/cli/embedded-assets.ts`
  (`bun run embed-assets`).

**Key Decisions / Notes:**

- **Recovery.** Step 6 "Stalls" in both `spec-master-execute` files:
  - A `never-started` stall → `orca_stop`, then `orca_start({ …, retry_of })`, **without asking**,
    once per task. A second `never-started` stall on the same task, or any other stall kind →
    ask Retry / Skip / Stop as now.
  - ⛔ Never resend a brief with `orca orchestration dispatch-show --preamble` or
    `orca terminal send`: the capability is not in it, and the dispatch can never settle.
  - `orca_start` returning `delivery_confirmed: false` is normal for OpenCode.
  - A failed start's retained terminal is reported, not closed by hand.
  - Before the wave ends, `orca_wait`'s `reclaimable` list must be empty. Release each entry
    once its `worker_done` has been processed. Any release answer, `retained` included, removes
    the entry, so this cannot loop.
  - `spec-implement`'s one-line stall rule mirrors this.
- **Defer to Orca's guide** (item 3 of the fan-out review):
  - The Orca Mode intro in both files says: "The `orca_*` tools wrap the lifecycle; for any Orca
    step they do not wrap, load the version-matched guide with `orca skills get orchestration`
    (and `--reference recovery-and-cleanup` for failed, stopped or uncertain attempts). The
    guide comes from the `orca` binary itself, so it needs no installed skill."
  - Remove prose that only restates generic Orca rules, such as general release/retry/abandon
    semantics, and point to the guide instead.
  - **Keep** everything Sentinal-specific: commit-before-merge, `worktree_ensure` adoption,
    VERIFIED as the only success, `worktree_sync` / `worktree_abandon` /
    `orca_remove_worktree` order, `run_id` resume through `orca_dispatch`, and the evidence rule.
- **Worker briefs** (item 1): both brief templates (the master-execute child brief and the
  `spec-implement` task brief) are restructured under Orca's Task-spec headings: **Target /
  Change / Constraints / Ownership / Observable acceptance**.
  - Remove the lifecycle CLI details ("Report with worker_done exactly once: --outcome …",
    "--files-modified …"). Replace them with: "Report completion through your Orca preamble:
    succeeded only when <acceptance>, otherwise failed with the blocker; list the files you
    changed."
  - The acceptance criterion itself (child plan reads `Status: VERIFIED`) is unchanged.
  - The master-execute brief also gets: "Questions: use your preamble's `ask` command."
- Worker question routing (item 2) is Task 8.
- Load the `sentinal-parity-baselines` skill before regenerating.

**Definition of Done:**

- [ ] `rg -n "retry_of" targets/*/commands/spec-master-execute.md targets/opencode/skills/spec-master-execute/SKILL.md`
      matches both.
- [ ] `rg -n "dispatch-show --preamble" targets/` shows the "never" rule in both
      `spec-master-execute` files.
- [ ] `rg -n "orca skills get orchestration" targets/` matches both `spec-master-execute` and
      both `spec-implement` files.
- [ ] `rg -n -- "--outcome|--files-modified" targets/` is empty (lifecycle flags are left to
      the preamble).
- [ ] `rg -n "Observable acceptance" targets/` matches both brief templates in both targets.
- [ ] `bun test src/cli/` passes (parity + embedded assets); `bun run check-embed-assets` if
      present.

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

### Task 8: Supervised-worker question routing in every `/spec` phase

**Objective:** A dispatched Orca worker running `/spec` never opens a local question prompt
that nobody can answer. It asks the coordinator through its preamble's `ask` command, as Orca's
worker contract requires. Non-Orca runs are unchanged.
**Dependencies:** Task 5 (same parity fixture directory; one regeneration per wave)
**Wave:** 5

**Files:** (prose only)

- Modify, Claude Code: `targets/claude-code/commands/spec.md`, `spec-plan.md`,
  `spec-bugfix-plan.md`, `spec-verify.md`, `spec-bugfix-verify.md`, `spec-master-plan.md`
- Modify, OpenCode: `targets/opencode/commands/spec.md`,
  `targets/opencode/skills/{spec-plan,spec-bugfix-plan,spec-verify,spec-bugfix-verify,spec-master-plan}/SKILL.md`
- Regenerate: parity baselines (once) and `src/cli/embedded-assets.ts`.

**Key Decisions / Notes:**

- **Trigger (strict, so non-Orca runs cannot trip it).** You are a supervised Orca worker only
  when **the session's first user message** is an Orca dispatch preamble. That message must
  contain all three of: a Task ID (`task_…`), a Dispatch ID (`ctx_…`), and a
  `--dispatch-capability dcap_…` token. Text that merely mentions these (docs, plan files, tool
  output, this plan) never counts.
- **Rule** (`spec.md` of both targets, a section "Supervised Orca worker"):
  - Never open a local question prompt (Claude Code: `AskUserQuestion`; OpenCode: the Question
    tool).
  - Ask the coordinator with the preamble's `ask` command, then resume the same message id
    after a timeout. The command comes from the preamble, never reconstructed.
  - Plan approval, the squash-merge choice and worktree decisions are settled by the brief. Do
    not ask about them; follow the brief's Constraints (e.g. "do not merge").
  - The rule **overrides** every phase's "⛔ ALWAYS use `AskUserQuestion`".
- **Each phase file** gets one line where its question rule sits (next to the existing
  "⛔ ALWAYS use `AskUserQuestion`" line or the approval step): "Supervised Orca worker? See
  `/spec` → Supervised Orca worker: questions go through the preamble's `ask`, never this
  tool." This makes the override visible in the file the worker is actually reading.
- The `SENTINAL_PLAN_QUESTIONS_ENABLED=false` path is unaffected. It already skips questions.

**Definition of Done:**

- [ ] `rg -n "Supervised Orca worker" targets/` matches all 12 files.
- [ ] `rg -n "first user message" targets/*/commands/spec.md` matches both.
- [ ] `bun test src/cli/` passes (parity + embedded assets).

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

### Task 6: Dev rules and the `sentinal-orca-cli` skill

**Objective:** Dev docs describe the new behaviour and correct the old `terminal close` fact.
**Dependencies:** Tasks 2, 3
**Wave:** 3

**Files:**

- Modify: `.sentinal/rules/sentinal-mcp-servers.md` (Orca domain: `never-started`, the
  terminal-tail source, `retry_of`, no `terminal close`),
  `.sentinal/rules/sentinal-project.md` (Orca orchestration paragraph),
  `.sentinal/skills/sentinal-orca-cli/SKILL.md`
- In the skill's facts table, replace the "`retained` → `orca terminal close`" row. Add rows for:
  OpenCode's terminal-only `worker-read`; the UTC `dispatchedAt`; `turnStart: unsupported`; raw
  `terminal send` to a booting TUI being lost; `terminal wait --for tui-idle`; `--terminal`
  starts being retained as `external_terminal`; `terminalState: "reclaimable"`. Bump the version
  to Orca 1.4.216.
- `.opencode/skills` and `.claude/skills` are both symlinks to `.sentinal/skills` (checked
  2026-09-29), so editing `.sentinal/skills/sentinal-orca-cli/SKILL.md` updates every copy that
  agents load.
- **Trim to facts specific to our adapter** (item 4 of the fan-out review):
  - Add a first line: "Generic Orca rules (retry, release, stop, the worker contract) live in
    Orca's version-matched guide: `orca skills get orchestration [--reference <file>]`. This
    skill keeps only what Sentinal's adapter and tests depend on."
  - Remove rows that only restate that guide, such as the `--retry-request` semantics in
    general, the release rules and the absence rule. Keep the output streams, last-JSON parsing,
    `consumer_fenced`/`run-use`, the un-acked re-send, the auth-silent worker, the `new-child`
    versus `worktree create` recipe, the fixtures, the live-test recipe and today's findings.
  - Where a rule is removed, add a pointer naming the guide reference instead.
- `.sentinal/rules/sentinal-mcp-servers.md`, Orca domain: add the `reclaimable` output of
  `orca_wait`. State that `orca_*` tools remain Sentinal's own because they enforce the safety
  floor in code and integrate adoption, VERIFIED and merge. State that prose defers everything
  else to `orca skills get orchestration`.

**Definition of Done:**

- [ ] `rg -n "terminal close" .sentinal/skills/sentinal-orca-cli/SKILL.md` no longer recommends
      closing (it survives only in the cleanup of Sentinal's own probe terminals).
- [ ] `rg -n "orca skills get orchestration" .sentinal/skills/sentinal-orca-cli/SKILL.md .sentinal/rules/sentinal-mcp-servers.md`
      matches both.
- [ ] `bunx prettier --check` passes on the touched files.

**Verify:** `bunx prettier --check .sentinal/rules/sentinal-mcp-servers.md .sentinal/rules/sentinal-project.md .sentinal/skills/sentinal-orca-cli/SKILL.md`

### Task 7: Live verification against the real Orca

**Objective:** Confirm on real Orca the negative case (a working OpenCode worker is not
`never-started`) and the stop → `--retry-of` path, including a new capability.
**Dependencies:** Tasks 1–6, 8
**Wave:** 6

**Files:**

- Create (scratch, not committed): `/tmp/orca-drop/verify.ts`, a bun script that uses the real
  runner.

**Key Decisions / Notes:**

- Throwaway worktrees (`orca worktree create --name e2e-v12-… --repo id:<sentinal repo id>
--setup skip --no-parent`), `SENTINAL_HOME=/tmp/orca-drop/home`, `--agent opencode`.
- (a) Brief a worker to "wait for a coordinator message, do not send anything". After it echoes,
  run `collectStalls` with `neverStartedMs: 1_000` → **not** stalled, because the dispatch id is
  in the tail. Record the `worker-read` capture for Pre-Mortem 1 and 3.
- (b) `orca orchestration worker-stop --dispatch <id>` on that worker, then
  `startTask({ retryOf })` → a new dispatch whose worker sends `worker_done` (accepted, so the
  new capability works).
- (b2) After (b)'s `worker_done`, and before release, `collectStalls` lists that dispatch in
  `reclaimable`. After `worker-release`, the list no longer contains it.
- (b3) The retried worker gets a brief in the new Task-spec format containing "Report
  completion through your Orca preamble". Its `worker_done` arrives, which proves that
  dropping the lifecycle flags from the brief does not stop a worker from reporting.
- (d) **Question routing:** brief one worker to "run a step that needs a user decision". Its
  question must arrive at the coordinator as an Orca `question` message in `orca_wait`, and must
  not appear as a local prompt in its terminal (check with `orca terminal read --screen`).
- **Limitation, recorded:** the flag-free brief (b3) and question routing (d) are verified
  live with **OpenCode workers only**. The user's Claude login inside Orca is stale. Claude
  workers get the same preamble from Orca, and the preamble carries the exact `worker_done`
  and `ask` commands, so the risk is low. Record it as an open item, not as verified.
- **Redaction:** every capture quoted in the plan, and every capture copied into
  `src/orca/__fixtures__/`, passes through `redactCapabilities` first. The DoD re-runs Truth 6.
- (c) A real dropped prompt cannot be produced through `worker-start` on this machine (9/9
  landed). Record that the positive case rests on the composite fixture.
- Clean up with ack, `worker-release`, `orca worktree rm --force` and `git branch -D`, and close
  only terminals the script created.
- Record the results in this plan under "## Live Verification".

**Definition of Done:**

- [ ] (a) not stalled, (b) retry `worker_done` accepted. Both recorded in the plan with dispatch
      ids.
- [ ] (d) the question arrives as an Orca `question`, and no local prompt is on screen.
- [ ] Truth 6 (no unredacted `dcap_` token in the fixtures or this plan) holds after the
      captures are recorded.
- [ ] No `e2e-v12` worktrees or branches remain.

**Verify:** `git -C /Users/evan/Projects/endpoint_esports/sentinal worktree list | rg -c e2e-v12` prints 0

### Task 9: [NEW] `orca_abandon` for a stop Orca cannot prove

**Objective:** Close the gap found live in Task 7. `worker-stop` can answer `stop_unknown`, for
example when Orca has marked the worker's terminal `user_takeover`. `--retry-of` is then
refused. Orca's documented recovery is an explicit `worker-abandon`, which was verified live:
after it, `--retry-of` is accepted and the replacement's `worker_done` is accepted too.
**Dependencies:** Task 7
**Wave:** 7

**Files:**

- Modify: `src/orca/dispatch.ts`: `abandonWorker(dispatchId, o)` → `worker-abandon --dispatch`
  (a mutation with `--retry-request`). Keep the file under 400 lines, moving code to a sibling
  if needed.
- Create: `src/orca/mcp-tools-abandon.ts` (+ test). `orca_abandon({ dispatch_id })` is
  DESTRUCTIVE. It is **gated on Orca's own evidence**: `worker-show` must report
  `worker.state === "stop_unknown"` or `worker.stage === "stop_outcome_unknown"`, otherwise it
  refuses. A healthy worker can therefore never be abandoned, and the gate survives a new
  session. `mcp-tools-settle.ts` is at 381 lines, which is why the tool gets its own file.
- Modify: `src/orca/mcp-tools.ts` (register the tool, header comment),
  `src/orca/mcp-tools-settle.ts` (a `stop_unknown` answer from `orca_stop` names the recovery:
  ask the user, then `orca_abandon`, then `orca_start({ …, retry_of })`), and the test files.
- Create: fixture `src/orca/__fixtures__/worker-show-stop-unknown.json`, from the recorded
  worker-show (worker `stop_unknown` / `stop_outcome_unknown`, lastError "The worker terminal
  is user_owned; no terminal was closed.").
- Modify: `src/mcp/server.test.ts` and `src/orca/mcp-tools.test.ts` (tool lists).
- Modify: `README.md` and `.sentinal/rules/sentinal-mcp-servers.md` (46 → 47 tools, Orca 8 → 9,
  table rows), `.sentinal/skills/sentinal-orca-cli/SKILL.md` (a `stop_unknown` row).
- Modify (prose, one parity regeneration): both `spec-master-execute` files and both
  `spec-implement` files. `orca_stop` → `stop_unknown` → **ask the user** → `orca_abandon` →
  `orca_start({ …, retry_of })`.

**Definition of Done:**

- [ ] Tests:
  - `orca_abandon` refuses when worker-show reports a live or ready worker.
  - It abandons when worker-show reports `stop_unknown`.
  - A failed `worker-show` refuses (absence).
  - `orca_stop` with a `stop_unknown` answer names `orca_abandon` and `retry_of`.
- [ ] `bun test src/orca/ src/mcp/ src/cli/` passes; `bun run typecheck` is clean.
- [ ] README and the rules say 47 tools, with 9 in the Orca domain.
