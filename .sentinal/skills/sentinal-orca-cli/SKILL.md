---
name: sentinal-orca-cli
description: |
  Verified behaviour of the Orca CLI (`orca orchestration …`, `orca worktree …`)
  that Sentinal's src/orca adapter and Orca Mode skills depend on. Use when:
  (1) editing src/orca/* or the Orca Mode sections of spec-master-execute /
  spec-implement, (2) `json.load`/`JSON.parse` of orca output fails with
  "Extra data", (3) `orca orchestration check` returns `consumer_fenced`,
  (4) a worker never sends worker_done, (5) `worker-start` fails at
  `agent_readiness` / `terminal_handle_stale`, (6) the same worker_done arrives
  twice, (7) `worker-release` answers `retained`, (8) testing Orca end to end
  without touching the user's real repo state.
author: Claude Code
version: 1.0.0
---

# Orca CLI — verified behaviour (Orca 1.4.215, `orchestration.contract.v1`)

## When to Use

Any change to how Sentinal drives Orca, or any live experiment against Orca.
Everything below was observed live (spike + two-phase e2e, 2026-09-28).

## Solution

**Parse output with `scripts/orca-json.py`** (last real JSON document; skips
NDJSON keepalives; exits 1 on `ok:false`):

```bash
orca orchestration check --wait --timeout-ms 20000 --json 2>&1 | .sentinal/skills/sentinal-orca-cli/scripts/orca-json.py
orca status --json | .sentinal/skills/sentinal-orca-cli/scripts/orca-json.py runtime.state
```

**Facts that shaped the design:**

| Behaviour                                                                                                                                     | Consequence                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error envelopes go to **stdout** with exit 1; `check --wait` keepalives go to **stderr**                                                      | Parse both streams; take the last document                                                                                                                                                                        |
| Orca **enforces task deps**: early `worker-start` → `task_not_startable` + `unmetDependencies`; the dependent turns `ready` after worker_done | Express waves as `task-create --deps`; `blocked` is not an error                                                                                                                                                  |
| A **Run is bound to ONE coordinator terminal**; another terminal gets `consumer_fenced`                                                       | Resume in a new session with `orca orchestration run-use --id <run>` (Sentinal: `orca_dispatch({run_id})`)                                                                                                        |
| An **un-acked delivery is re-sent** by the next `check`                                                                                       | `check --ack <delivery>` before the next wait; dedupe worker_done by dispatch                                                                                                                                     |
| A worker whose agent cannot log in (**401 / "Please run /login"**) receives the task and goes **silent** — no worker_done, Orca waits forever | Preflight with `orca account list --json` (claude/codex only) and detect stalls from `worker-read --source auto`                                                                                                  |
| First `worker-start` can fail `agent_readiness` / `terminal_handle_stale`                                                                     | One `--retry-of <dispatch>` with the SAME explicit `--worktree path:` + `--agent`                                                                                                                                 |
| `worker-release` of a failed attempt or of a worker owned by another coordinator → `retained`                                                 | `orca terminal close --terminal <handle>` only for terminals listed in that receipt                                                                                                                               |
| `--worktree new-child` creates the worktree AND starts the agent in one step; `--setup skip` leaves no `node_modules`                         | Create with `orca worktree create --name --base-branch --parent-worktree current --setup skip` (no agent), adopt with `worktree_ensure(owner external)` (runs `setup`), then `worker-start --worktree path:<dir>` |
| The MCP server inherits `ORCA_TERMINAL_HANDLE` from the agent's Orca terminal                                                                 | `run-create` from the MCP process binds the agent's terminal                                                                                                                                                      |
| `--retry-request` must be a UUID; `worktree create/rm` and `terminal close` don't accept it                                                   | Recover a lost `worktree create` via `orca worktree show --worktree name:<n>`                                                                                                                                     |

⛔ Never stop/abandon/release on `unverifiable` liveness — only on `exited`,
an auth error in the last assistant turn, or long idle without worker_done
(`orca skills get orchestration --reference recovery-and-cleanup`).

**Live e2e without touching real state:** `orca worktree create --name
e2e-… --repo path:<repo> --base-branch <branch> --setup skip --no-parent`
for a throwaway coordinator; run the driver inside it via `orca terminal
create --worktree path:<dir> --command <script>` (so it has its own
`ORCA_TERMINAL_HANDLE`); isolate with `SENTINAL_HOME=/tmp/…`; use `--agent
opencode` when the Claude login is stale. Clean up: `orca terminal close`,
`orca worktree rm --force`, `git branch -D`.

## Verification

`orca status --json | scripts/orca-json.py runtime.state` prints `"ready"`;
`bun test src/orca/` replays the recorded fixtures in `src/orca/__fixtures__/`.

## When NOT to Use

- Unit tests: never run the real `orca` binary — inject the runner and replay
  fixtures.
- Handoffs without supervision (`orca-cli` skill territory).

## References

- `src/orca/` (adapter, dispatch, stall), `src/orca/__fixtures__/`
- `docs/plans/2026-09-28-orca-orchestration.md` (Spike table, Live E2E)
- `orca skills get orchestration [--reference recovery-and-cleanup]`
