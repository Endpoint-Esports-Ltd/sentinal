# Surfacing Dropped Briefs When Orca's Agent Liveness Is Unverifiable (issue #12 follow-up) Implementation Plan

Created: 2026-09-30
Status: VERIFIED
Approved: Yes
Iterations: 2
Worktree: No
Type: Feature

## Summary

**Goal:** When a brief was probably dropped but Orca reports the worker's agent liveness as
`unverifiable`, as happened on Orca 1.4.209 in issue #12, `orca_wait` makes that **visible**. It
reports a `never-started-unverifiable` attention entry with **no `evidence_id`**, so the
coordinator tells the user instead of silently seeing `stalls: []`. Sentinal never stops or
retries in that state, because Orca's guide forbids it.

Where Orca's guide does sanction better evidence, it is used for real stall verdicts: for a
client-side gap, `worker-show`'s verdict outranks the list row. Other dispatches that Orca flags
with `requiresAction` but that have no stall verdict are also surfaced.

**Why detection only (iteration 2).** The reporter's correction on issue #12 (2026-09-30 10:15)
quotes Orca's guide (1.4.209 and 1.4.216): "`unverifiable` liveness | Keep waiting or inspect;
never stop, abandon, retry, or release". An `unverifiable` case must therefore never produce an
`evidence_id`. The user confirmed this revision on 2026-09-30, replacing the earlier "retry first
then ask" for this case. The earlier iteration's option 2, a stall verdict with basis
"terminal", is withdrawn.

**Architecture:**

- A new pure module, `src/orca/stall-liveness.ts`, resolves agent liveness in Orca's documented
  precedence:
  1. The list's `projection.liveness` is used.
  2. If it is `unverifiable` for a **client-side gap** (`missing_status`,
     `capability_unsupported`), `worker-show`'s projection verdict outranks it.
  3. Otherwise the result is `absent`.
- `stallVerdict` is unchanged in spirit. Only `live` and `exited` (from either source) can
  produce a stall.
- `collectStalls` additionally calls `worker-show` for gap-unverifiable rows, and returns
  `attention` entries, which are never stalls.
- `orca_wait` renders them. Its registration moves to `mcp-tools-wait.ts`, because
  `mcp-tools-settle.ts` is at 393 of 400 lines.

**Tech Stack:** TypeScript, Bun test, the `orca` CLI adapter, zod, MCP SDK.

## Scope

### In Scope

- **Better evidence (option 1).** For an `unverifiable` row whose reason is `missing_status` or
  `capability_unsupported`, `worker-show`'s `projection.liveness` is used if it says `live` or
  `exited`:
  - `live` → every existing check applies (transcript, tail auth, `never-started`, idle), with a
    normal `evidence_id`, because Orca itself said the agent is live;
  - `exited` → an `exited` stall.

  `host_unavailable` (contact loss) never takes `worker-show` into account.
- **The `never-started-unverifiable` attention entry (option 2, revised).** When liveness
  resolves to `absent`, the reason is a client gap other than `host_unavailable`, and ALL of the
  existing never-started conditions hold, `collectStalls` emits
  `{ kind: "never-started-unverifiable", dispatchId, taskId?, evidence }`. The conditions are:
  - the splash logo and the framed input placeholder are in the tail;
  - the dispatch id is absent from the joined tail;
  - no heartbeat;
  - `dispatchedAt` more than 3 min ago;
  - the worker's own terminal is positively live, via either:
    - `worker-read` `status.liveness: "live"`, with `terminal.handle` equal to `worker-show`'s
      `dispatch.assigneeHandle` or `worker.agentTerminalHandle`; or
    - `worker-show` `observation: { status: "live", exactWorker: true }`.

  The entry has **no `evidence_id`**, and `state.verdicts` never records it, so `orca_stop`
  refuses it.
- **Other attention rows (option 3).** These are active dispatches with
  `projection.attention.requiresAction === true`, no stall verdict, and no
  `never-started-unverifiable` entry, reported as `{ kind: "orca-attention", categories,
  nextAction }`. Rows whose categories are exactly `["unverifiable"]` are excluded: on 1.4.209
  every healthy OpenCode worker carries that category, and its only actionable form is the entry
  above.
- **Once per session.** `orca_wait` reports each attention dispatch once per session (a new
  `state.attentionReported` set) and never after release. Its Next hint says: "tell the user;
  attention entries never authorize orca_stop, orca_abandon or a retry".
- **Fixtures:**
  - the real 1.4.209 stall-time `worker-read` (a dropped prompt);
  - the real post-stop `worker-show`;
  - a composite stall-time `worker-show`.
- **Prose** (both targets): `unverifiable` + home screen means the brief was probably dropped.
  Orca forbids an automated stop or retry there, so report it to the user with its evidence and
  let the user decide; the coordinator does not act on its own. Other attention rows are
  reported to the user.
- **Dev docs** and the `sentinal-orca-cli` skill, which gets the 1.4.209 facts and the guide rule.
- A live regression smoke on 1.4.216: a healthy worker gets no stall and no attention entry.

### Out of Scope

- Any stop, retry or abandon for an `unverifiable` dispatch, per Orca's guide and the reporter's
  correction.
- Reproducing `missing_status` live. It is not reproducible on 1.4.216.
- `idle-no-report` / `auth-error` for unverifiable dispatches.
- Filing the upstream Orca report (a live PTY on the home screen reported as `unverifiable` /
  `missing_status`). It is offered to the user separately.
- The release and the issue comment come after verification.

## Context for Implementer

- **Issue data** (issue #12 comments on 2026-09-29 at 23:18, and on 2026-09-30 at 09:39 and
  10:15; Orca 1.4.209 on Linux):
  - **Stall-time `worker-read`:**
    - `fallbackReason: "session_not_reported"`,
      `status: { worker: "ready", terminal: "running", liveness: "live" }`;
    - `terminal.handle: <terminal-handle-1>`, and a 13-line tail with the splash logo and
      `┃  Ask anything… "Fix a TODO in the codebase"`, with no dispatch id;
    - `projection`: `provider: null`, `stage.activity: "unknown"`,
      `liveness: { verdict: "unverifiable", reason: "missing_status" }`,
      `evidence.liveStatus: "unavailable"`, `nextAction: { kind: "none" }`,
      `attention: { categories: ["unverifiable"], requiresAction: true }`.
  - **Post-stop `worker-show`:**
    - `dispatch.assigneeHandle` = `worker.agentTerminalHandle` = `<terminal-handle-1>`;
    - `lastHeartbeatAt: null`, `dispatchedAt: "<date> 23:11:43"`;
    - `observation: { status: "exited", exactWorker: true }`,
      `projection.liveness: exited/worker_stop`.
  - **The correction:** do not treat `unverifiable` as `live`. Report attention with no
    `evidence_id`.
- **Orca's guide** (`orca skills get orchestration --reference
references/recovery-and-cleanup.md`):
  - "`unverifiable` liveness | Keep waiting or inspect; never stop, abandon, retry, or release".
  - For client-gap reasons, "a `worker-show` verdict sourced from the execution host is the
    better evidence and outranks the row. … This never promotes absence. `unverifiable` from
    either command still authorizes nothing — only a positive `live` or `exited` verdict does."
  - `observation.status` is PTY liveness only. It may **inform** an attention entry and never
    authorizes an action.
- **Current code:**
  - `src/orca/stall.ts:190` returns "absence never authorizes a stop" for any verdict other than
    `live`. Keep that semantics.
  - `tailVerdict` holds the never-started checks. Reuse them: extract a pure
    `neverStartedEvidence(tail, dispatchId, show, now, limitMs)` returning the facts or `null`,
    which both the stall path and the attention path call.
  - `collectStalls` calls `worker-show` only for home-screen suspects.
  - `waitForSettlement` (`src/orca/dispatch.ts`) wraps it.
  - `orca_wait` / `orca_stop` live in `src/orca/mcp-tools-settle.ts` (393 lines).
  - `orca_stop` only accepts ids stored in `state.verdicts`.
- **Patterns:** injected runners and fixtures (`src/orca/stall.test.ts`,
  `mcp-tools-settle.test.ts`). Never run the real `orca`. Redact `dcap_`.
- **Gotchas:**
  - Keep every non-test file at 400 lines or fewer.
  - Regenerate the parity baselines once (Task 4), then run `bun run embed-assets`.
  - Set `RED_CONFIRMED` before each implementation write.

## Assumptions

- `.opencode/skills` and `.claude/skills` are symlinks to `.sentinal/skills` (checked
  2026-09-29).
- In the 1.4.209 case, `worker-show`'s projection was also unverifiable at stall time, so option
  1 alone would not have helped. The real signal therefore comes from the attention entry. The
  evidence: `evidence.liveStatus: unavailable` and `lastObservedAt: null`, both before and after
  the stop. Tasks 2 and 3 depend on this.
- The real fields `read.status.liveness` and `read.terminal.handle`, together with the show's
  handles, are enough to tie the live terminal to the dispatch, so no composite `observation`
  is needed for the positive test. Task 2 depends on this.
- On 1.4.216, healthy OpenCode workers report `liveness: live`, so none of this engages there.
  Task 6 checks it.

## Testing Strategy

- **Unit tests:**
  - The real 1.4.209 read with the real handles gives a `never-started-unverifiable` attention
    entry and **no stall**. `orca_stop` refuses it (no verdict).
  - Negative cases for the attention entry: `host_unavailable`, a handle mismatch, the dispatch
    id present, age under 3 min, a heartbeat, a conversation on screen.
  - Option 1: `worker-show` `live` enables the normal checks, and `exited` gives an `exited`
    stall.
  - The existing "never stalls on unverifiable" tests are kept unchanged.
- **`orca_wait` tests:** attention rendering, once per session, no `evidence_id`.
- **A live smoke on 1.4.216.**

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| The attention entry is misread by a coordinator as permission to stop | Med | A stop Orca forbids | No `evidence_id` is issued; `orca_stop` refuses without a stored verdict; the entry text, the Next hint and the prose all say "tell the user; do not stop, abandon or retry" |
| Option 1 trusts a stale `worker-show` verdict | Low | A wrong stop | Only `missing_status`/`capability_unsupported` qualify (never `host_unavailable`), and only a positive `live`/`exited`, as Orca's guide sanctions |
| Attention spam on 1.4.209 | Med | Noise | Pure-`unverifiable` rows are excluded unless all the never-started evidence holds; each dispatch is reported once per session |
| Extra `worker-show` calls exceed the 10 s budget | Med | Missed checks | Shared deadline; unread rows get nothing (absence) |

## Pre-Mortem

1. **A coordinator stops the worker anyway, with a raw `orca` command** (Task 4). → Trigger: the
   prose tells the coordinator to inspect or act. Mitigation: the prose says "tell the user" and
   never names `worker-stop` for this case. Only the user may decide to stop it, outside
   Sentinal.
2. **The line budget** (Tasks 2 and 3). → Trigger: a non-test file over 400 lines. The planned
   splits (`stall-liveness.ts`, `mcp-tools-wait.ts`) prevent it.

## Execution Waves

**Wave 1**: Task 1 (types and fixtures).
**Wave 2**: Task 2 (liveness resolution, never-started evidence helper, attention in
`collectStalls` / `waitForSettlement`).
**Wave 3**, parallel with disjoint files: Task 3 (`orca_wait` split + rendering), Task 4
(`targets/` prose + one parity regeneration), Task 5 (dev docs).
**Wave 4**: Task 6 (live regression smoke).

## Goal Verification

### Truths

1. A test feeds the real 1.4.209 `worker-read` fixture, a `worker-show` with matching handles and
   an unverifiable projection, and an age over 3 min. It gets `stalls: []` and one attention
   entry with `kind: "never-started-unverifiable"`.
2. In an `orca_wait` test, that entry has no `evidence_id`, and a following `orca_stop` for that
   dispatch with any evidence id is refused (`stop_refused`).
3. A test where `worker-show` says `live` for a `missing_status` row gives the normal
   `never-started` stall with an `evidence_id`.
4. The same inputs with `host_unavailable` give neither a stall nor a `never-started-unverifiable`
   entry.
5. `src/orca/stall-liveness.ts` exports `resolveLiveness`, and `stall.ts` imports it.
6. `wc -l` of every non-test `src/orca/*.ts` file is 400 or fewer; the fixtures contain no
   unredacted `dcap_` token.

### Artifacts

| Artifact | Provides | Exports |
| -------- | -------- | ------- |
| `src/orca/stall-liveness.ts` | Orca-precedence liveness resolution | `resolveLiveness`, `GAP_REASONS` |
| `src/orca/mcp-tools-wait.ts` | `orca_wait` with stalls, attention, reclaimable | `registerOrcaWaitTool` |
| `src/orca/__fixtures__/worker-read-terminal-home-unverifiable.json` | Real 1.4.209 dropped prompt | fixture |

### Key Links

| From | To | Via | Pattern |
| ---- | -- | --- | ------- |
| `src/orca/stall.ts` | `stall-liveness.ts` | import | `from "./stall-liveness.js"` |
| `src/orca/mcp-tools-settle.ts` | `mcp-tools-wait.ts` | registration | `registerOrcaWaitTool` |

## Progress Tracking

- [x] Task 1: Types + fixtures from the 1.4.209 capture (Wave 1)
- [x] Task 2: Liveness precedence (option 1) + `never-started-unverifiable` / `orca-attention` entries in `collectStalls` (Wave 2)
- [x] Task 3: `orca_wait` split to `mcp-tools-wait.ts` + attention rendering (no evidence_id) (Wave 3)
- [x] Task 4: Prose in both targets: report, never act (Wave 3)
- [x] Task 5: Dev rules + `sentinal-orca-cli` skill (Wave 3)
- [x] Task 6: Live regression smoke on 1.4.216 (Wave 4)

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Notes

- **Task 2:** `parseDispatchedAt` and `DEFAULT_NEVER_STARTED_MS` moved to `stall-liveness.ts`;
  `stall.ts` re-exports them. `neverStartedEvidence` is shared by the stall path (`tailVerdict`)
  and the attention path (`unverifiableAttention`).
- **Task 3:** `orca_wait` moved out of `mcp-tools-settle.ts` unchanged (393 → 235 lines).
- **Spec review, suggestions applied:** `attentionReported` is keyed on `<dispatch>:<kind>`, so
  an earlier `orca-attention` for a dispatch cannot hide a later `never-started-unverifiable`.
  The `orca-attention` line also carries "tell the user; never a stop" inline.

## Verification

- **Gates:** `typecheck`, `typecheck:plugin`, `lint`, the embed guard and `bun test` all passed
  (4488 pass, 0 fail). `format:check` failed on one fixture, which was fixed and re-checked
  clean.
- **Spec review:** 6/6 truths. The constraint that an `unverifiable` dispatch never gets an
  `evidence_id`, a stall, or prose saying to stop/abandon/retry holds across the code and the
  prose. One should_fix (record Task 6) and two suggestions were addressed.
- **Not verified live:** the `unverifiable` case itself, which cannot be reproduced on 1.4.216.
  It is covered by the real 1.4.209 `worker-read` capture plus a composite stall-time
  `worker-show` (real handles and `dispatchedAt`, only its stop fields reverted).

## Live Verification

Task 6, 2026-09-30, Orca 1.4.216 and OpenCode on macOS, run through Sentinal's adapter with the
real runner, Run `run_92d5d3ae5ff3`, worktree `e2e-v12b-a`:

| Check | Result |
| ----- | ------ |
| A healthy idle worker, `collectStalls` with `neverStartedMs: 1000` | ✅ `ctx_dc9e0f8f46f0`: `stalls: []`, `attention: []`, verdict "live; terminal tail shows no home screen" |
| Follow-up → `worker_done` | ✅ received |
| Release | ✅ `released` |
| Cleanup | ✅ `e2e-v12b-a` worktree and branch removed |

## Implementation Tasks

### Task 1: Types + fixtures from the 1.4.209 capture

**Objective:** Record the real dropped prompt and the shapes the resolver reads.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/orca/types.ts`:
  - `OrcaWorkerProjection` adds `evidence?` and `provider?`, and `attention.requiresAction`
    where it is missing.
  - `OrcaWorkerShowResult` adds `observation?: { status?: string; exactWorker?: boolean }`, and
    `assigneeHandle?` on `dispatch` / `agentTerminalHandle?` on `worker`.
  - `OrcaWorkerReadResult` adds `status?: { worker?: string; terminal?: string; liveness?:
string }`.
- Create fixtures, each with `_provenance`:
  - `worker-read-terminal-home-unverifiable.json`: the issue's stall-time `worker-read`
    completed into `{id, ok, result}`, with dispatch id `ctx_d209000000a1` and handle
    `term_d209-worker`.
  - `worker-show-unverifiable-209.json`: the **composite** stall-time state, built from the
    recorded post-stop `worker-show` by reverting only its stop fields (`dispatch.status:
dispatched`, `completedAt: null`, `worker.state: ready`, `projection.liveness`
    unverifiable/`missing_status`). Handles and `dispatchedAt` are unchanged from the recording.
    No `observation` is added.
  - `worker-show-stopped-209.json`: the recorded post-stop `worker-show`.
- Test: `src/orca/stall-terminal.test.ts`. The new real tail passes `showsHomeScreen` and fails
  `mentionsDispatch`.

**Definition of Done:**

- [ ] The tests pass, typecheck is clean, and the fixtures contain no `dcap_` token.

**Verify:** `bun test src/orca/stall-terminal.test.ts`

### Task 2: Liveness precedence + attention entries

**Objective:** Stalls come only from `live`/`exited`, including `worker-show`'s verdict for gap
reasons. A dropped brief under `unverifiable` becomes a `never-started-unverifiable` attention
entry.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/orca/stall-liveness.ts` (+ `stall-liveness.test.ts`):
  - `GAP_REASONS = ["missing_status", "capability_unsupported"]`. `host_unavailable` is
    deliberately left out.
  - `resolveLiveness({ row, read, show })` →
    `{ verdict: "live" | "exited" | "absent", source: "list" | "worker-show" | null, reason? }`.
  - Resolution:
    1. The list or read projection says `live` or `exited` → use it.
    2. If it is `unverifiable` with a reason in `GAP_REASONS` and `show.projection.liveness` is
       `live` or `exited`, use that, with source `worker-show`.
    3. Else `absent`, carrying the unverifiable `reason`.
  - `ownTerminalLive({ read, show })` returns true when:
    - `read.status.liveness === "live"` and `read.terminal.handle` matches the show's
      `dispatch.assigneeHandle` or `worker.agentTerminalHandle`; or
    - `show.observation.status === "live"` and `show.observation.exactWorker === true`.
- Modify: `src/orca/stall.ts`:
  - `stallVerdict` uses `resolveLiveness`; `absent` → no stall, as today.
  - Extract `neverStartedEvidence(...)` from `tailVerdict`; both call sites use it.
  - `collectStalls`:
    - call `worker-show` for a row when (a) the tail shows the home screen without the dispatch
      id, or (b) its liveness is unverifiable with a `GAP_REASONS` reason; once per row, within
      the budget;
    - for a row with verdict `absent` and a `GAP_REASONS` reason, where `neverStartedEvidence`
      is non-null and `ownTerminalLive` holds → push
      `{ kind: "never-started-unverifiable", dispatchId, taskId?, evidence }` to `attention`
      (redacted evidence naming the liveness reason and "the worker's own terminal is live");
    - for other active rows with `requiresAction`, no verdict, no entry above, and categories
      other than exactly `["unverifiable"]` → push
      `{ kind: "orca-attention", dispatchId, taskId?, categories, nextAction }`;
    - return `attention`.
- Modify: `src/orca/dispatch.ts`: `waitForSettlement` passes `attention` through (`[]` when stall
  collection failed).
- Tests:
  - Truths 1, 3 and 4.
  - Negative cases: a handle mismatch, the id present, age under 3 min, a heartbeat, a
    conversation on screen (no entry); `worker-show` `exited` for a gap row gives an `exited`
    stall.
  - A healthy gap-unverifiable worker gives no stall and no attention.
  - An `orca-attention` row appears for categories `["failure"]` with `requiresAction`.
  - The existing unverifiable tests are unchanged.
  - `waitForSettlement` passes `attention` through.

**Definition of Done:**

- [ ] `bun test src/orca/` passes, typecheck is clean, and `stall.ts` and `dispatch.ts` are 400
      lines or fewer.

**Verify:** `bun test src/orca/stall-liveness.test.ts src/orca/stall.test.ts src/orca/dispatch.test.ts`

### Task 3: `orca_wait` split + attention rendering

**Objective:** Make room under the line limit, and show attention entries that can never be
acted on.
**Dependencies:** Task 2
**Wave:** 3

**Files:**

- Create: `src/orca/mcp-tools-wait.ts` (+ `mcp-tools-wait.test.ts`):
  - move `registerWait` and `messageRow` out of `mcp-tools-settle.ts`, unchanged;
  - add `attention` to the structured result, with no `evidence_id` field, excluding released
    dispatches and those already in `state.attentionReported` (a new set in
    `mcp-tools-shared.ts`);
  - render these lines:
    - `- **attention** <dispatch> (never-started-unverifiable): <evidence> — the brief was
probably dropped; Orca's agent liveness is unverifiable, so Orca forbids stop/retry: tell
the user`;
    - `- **attention** <dispatch> (<categories>): Orca's next action: <argv> | none — inspect`;
  - add the Next hint: "tell the user about each attention entry; attention never authorizes
    orca_stop, orca_abandon or a retry";
  - update the tool description to mention attention.
- Modify: `src/orca/mcp-tools-settle.ts` (register via `registerOrcaWaitTool`, drop the moved
  code) and `src/orca/mcp-tools-shared.ts` (`attentionReported`).
- Tests:
  - the entry is rendered with no `evidence_id`;
  - `orca_stop` with any evidence id for that dispatch → `stop_refused` (Truth 2);
  - it is reported once per session;
  - it is omitted after release;
  - the existing `orca_wait` tests are unchanged.

**Definition of Done:**

- [ ] The tests pass, and `mcp-tools-settle.ts` is under 360 lines.

**Verify:** `bun test src/orca/mcp-tools-wait.test.ts src/orca/mcp-tools-settle.test.ts`

### Task 4: Prose in both targets

**Objective:** Coordinators report the unverifiable case to the user and never act on it.
**Dependencies:** Task 2
**Wave:** 3

**Files:** `targets/claude-code/commands/spec-master-execute.md`,
`targets/opencode/skills/spec-master-execute/SKILL.md`,
`targets/claude-code/commands/spec-implement.md`,
`targets/opencode/skills/spec-implement/SKILL.md`; then the parity baselines (once) and
`embed-assets`.

**Key Decisions / Notes:**

- In the Stalls step, add a bullet: "**`attention` entries are never stalls.**
  `never-started-unverifiable` means the brief was probably dropped, but Orca cannot confirm the
  agent is running, and Orca's guide forbids stopping, abandoning or retrying an `unverifiable`
  worker. Tell the user, with the evidence, and let them decide. Do not stop, abandon or retry it
  yourself. Report any other attention entry to the user with Orca's next action."
- In `spec-implement`, a one-line mirror of this.
- Apply the edits symmetrically; the hunk counts must stay unchanged.

**Definition of Done:**

- [ ] `rg -n "never-started-unverifiable" targets/` matches all four files, and
      `bun test src/cli/` passes.

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

### Task 5: Dev docs

**Dependencies:** Task 2
**Wave:** 3

**Files:**

- `README.md`: the `orca_wait` wording, if the catalog mentions its outputs.
- `.sentinal/rules/sentinal-mcp-servers.md`, Orca domain:
  - the liveness precedence;
  - that attention entries never carry `evidence_id`, with the guide quote;
  - the `orca_wait` row.
- `.sentinal/rules/sentinal-project.md`: one sentence.
- `.sentinal/skills/sentinal-orca-cli/SKILL.md`, with these rows:
  - 1.4.209: `fallbackReason: session_not_reported`;
  - projection `provider: null`, `unverifiable` / `missing_status`, and `requiresAction` with
    `nextAction: none` on a live PTY showing the home screen;
  - the guide's "never stop, abandon, retry, or release" on `unverifiable`;
  - `worker-stop` settling as `exited` / `worker_stop` when it was run by hand.

**Definition of Done:**

- [ ] `bunx prettier --check` passes on the touched files.

### Task 6: Live regression smoke on 1.4.216

**Objective:** Healthy workers are unaffected.
**Dependencies:** Tasks 1–5
**Wave:** 4

**Key Decisions / Notes:** A bun script with the real runner and a throwaway worktree
(`e2e-v12b-…`) does the following:

1. Start an OpenCode worker briefed to idle.
2. Run `collectStalls` with `neverStartedMs: 1000`. Expect: no stall and no attention entry.
3. Send a follow-up telling it to report `worker_done`.
4. Release it and clean up.
5. Record the result under "## Live Verification".

**Definition of Done:**

- [ ] The healthy worker gets no stall and no attention entry, and no `e2e-v12b` worktree or
      branch remains.
