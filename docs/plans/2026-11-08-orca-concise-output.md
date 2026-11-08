# Orca 1.4.253 Concise Output Breaks orca_* Tools Fix Plan

Created: 2026-11-08
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** On Orca 1.4.253, `orca_dispatch` fails with
`orca_bad_output: run-create returned no run`. Every `orca_*` tool that reads an
`orca orchestration …` result is affected; `orca_status` still works.
**Trigger:** Any Orca-Mode `/spec` run (or direct `orca_*` call) against Orca ≥ 1.4.253.
Found while starting master plan `docs/plans/2026-11-05-cross-project-scope.md`.
**Root Cause:** `src/orca/cli.ts` `runOrca` (~line 238) appends only `--json`. Orca 1.4.253
changed every `orca orchestration` subcommand to print a **concise view** by default and the full
record only with `--full` ("Print the full record Orca returned instead of the concise view").
Sentinal's callers read the full record (`result.run`, `result.task`, `result.dispatch`, …), e.g.
`ensureRun` (`src/orca/dispatch.ts:133`) reads `made.result?.run` but now receives
`{runId, objective}`.

## Investigation

- Live, 1.4.253: `orca orchestration run-create --objective X --json` →
  `{"ok":true,"result":{"runId":"run_9efdbab4d99f","objective":"…"}}`;
  `run-show --id … --json --full` → the old shape `{"result":{"run":{id, objective,
  coordinator_handle, consumer_generation, …}, …}}`, matching
  `src/orca/__fixtures__/run-create.json` (recorded on 1.4.215).
- `--full` exists on `run-current`, `run-use`, `run-create`, `run-show`, `task-create`,
  `task-list`, `worker-start`, `worker-list`, `worker-show`, `worker-read`, `worker-release`,
  `worker-stop`, `check`, `reply`, `request-show`. **Not** on `ack`. Non-orchestration commands
  Sentinal calls (`worktree create|show|list|rm`, `terminal create|read|wait|close|show`,
  `status`, `account list`, `repo list`) have no `--full` and still print full records.
- `orca status` (used by `orca_status`) is unchanged, so detection reports "ready" while every
  lifecycle tool fails — a misleading combination.
- `runOrca` is the single chokepoint (28 call sites go through it), so the fix belongs there.
- Orca ≤ 1.4.2xx without `--full` would reject an unknown flag with
  `{"ok":false,"error":{"code":"invalid_argument","message":"Unknown flag --full for command: …"}}`
  (same error shape as observed for `--run` on `run-show`). Flag validation happens before any
  mutation runs, so retrying without the flag cannot double-apply a mutation (and mutations
  carry `--retry-request` anyway).
- A Run `run_9efdbab4d99f` was created during diagnosis and is bound to this coordinator
  terminal; the master run will reuse it (`orca_dispatch({run_id})`).

## Behavior Contract

### Fix Property (C => P)

**When** `runOrca` runs an `orchestration` subcommand other than `ack` against an Orca that
supports `--full`, **then** the argv carries `--full` and callers receive the full record
(`orca_dispatch` creates the Run/tasks; `orca_start`/`orca_wait`/… parse as before).

### Preservation Property (!C => unchanged)

- Non-orchestration commands and `orchestration ack`: argv unchanged (`… --json` only).
- An Orca that rejects `--full` (`invalid_argument` naming `--full`): the call is retried once
  without it and the process remembers not to send it again; results identical to today.
- Callers that already pass `--full` or `--json`: no duplicate flags.

## Fix Approach

**Files:** `src/orca/cli.ts`, `src/orca/cli.test.ts`, fixtures
`src/orca/__fixtures__/run-create-concise-1.4.253.json` (live, documents the break), test argv
expectations in `src/orca/dispatch.test.ts`, `src/orca/stall.test.ts`, `src/orca/detect.test.ts`
only where they assert exact orchestration argv; `.claude/skills/sentinal-orca-cli/SKILL.md`
(note); `src/orca/cli.ts` header comment (output facts now 1.4.253).
**Strategy:** In `runOrca`: if `args[0] === "orchestration"`, `args[1] !== "ack"`, `--full` not
present, and the module flag `fullUnsupported` is false → append `--full` (before `--json`).
If the parsed result is `invalid_argument` and its message mentions `--full`, set
`fullUnsupported = true` and rerun once without it. Export a test-only reset
(`__resetOrcaFullSupportForTests`). Keep the module `bun:sqlite`/zod-free.
**Tests:** argv gets `--full` for orchestration (not ack, not worktree/terminal/status); no
duplicate; unknown-flag fallback retries once and caches; a mutation retry carries the same
`--retry-request`. End-to-end through `ensureRun` with a runner that returns the concise shape
without `--full` and the full shape with it → `ok: true`.
**Live check:** after the fix, `orca_dispatch` for the cross-project-scope Phase 1 task succeeds
(it is the next step of the master run).

## Progress

- [x] Task 1: Fix
- [x] Task 2: Verify

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write regression tests → verify FAIL → implement `--full` + fallback → all PASS.
**Files:** `src/orca/cli.ts`, `src/orca/cli.test.ts`, `src/orca/dispatch.test.ts` (and other
exact-argv tests as needed), new fixture, skill note.
**TDD:** Regression test through `ensureRun` + argv tests first (RED), then `cli.ts`.
**Verify:** `bun test src/orca/`

### Task 2: Verify

**Objective:** Full suite + quality checks + the live `orca_dispatch`.
**Verify:** `bun test && bun run typecheck && bun run typecheck:plugin && bun run lint && bun run format:check`

## Verification Notes

- `bun test` 4615 pass / 0 fail; typecheck, plugin typecheck, lint, format:check clean.
- Live (Orca 1.4.253): `ensureRun({runId: "run_9efdbab4d99f"})` through the fixed adapter →
  `ok, reused`; `task-list` parses. The installed `sentinal` binary (1.44.0) serving this
  session's MCP server still has the old adapter until rebuilt/reinstalled and restarted.
- Exact-argv test expectations in `stall.test.ts` / `dispatch.test.ts` updated to include `--full`.
