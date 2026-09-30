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
  without touching the user's real repo state, (9) a worker's brief never
  reached its agent (issue #12).
author: Claude Code
version: 1.1.0
---

# Orca CLI — verified behaviour (Orca 1.4.216, `orchestration.contract.v1`)

## When to Use

Any change to how Sentinal drives Orca, or any live experiment against Orca.
Everything below was observed live (spike + two-phase e2e, 2026-09-28; dropped-
prompt test, 2026-09-29, Orca 1.4.216, OpenCode 1.18.33).

## Solution

Generic Orca rules (retry, release, stop, the worker contract) live in Orca's
version-matched guide: `orca skills get orchestration [--reference <file>]`.
This skill keeps only what Sentinal's adapter and tests depend on.

**Parse output with `scripts/orca-json.py`** (last real JSON document; skips
NDJSON keepalives; exits 1 on `ok:false`):

```bash
orca orchestration check --wait --timeout-ms 20000 --json 2>&1 | .sentinal/skills/sentinal-orca-cli/scripts/orca-json.py
orca status --json | .sentinal/skills/sentinal-orca-cli/scripts/orca-json.py runtime.state
```

**Facts that shaped the design:**

| Behaviour                                                                                                                                                                                                                                                                       | Consequence                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Error envelopes go to **stdout** with exit 1; `check --wait` keepalives go to **stderr**                                                                                                                                                                                        | Parse both streams; take the last document                                                                                                                                                                               |
| Orca **enforces task deps**: early `worker-start` → `task_not_startable` + `unmetDependencies`; the dependent turns `ready` after worker_done                                                                                                                                   | Express waves as `task-create --deps`; `blocked` is not an error                                                                                                                                                         |
| A **Run is bound to ONE coordinator terminal**; another terminal gets `consumer_fenced`                                                                                                                                                                                         | Resume in a new session with `orca orchestration run-use --id <run>` (Sentinal: `orca_dispatch({run_id})`)                                                                                                               |
| An **un-acked delivery is re-sent** by the next `check`                                                                                                                                                                                                                         | `check --ack <delivery>` before the next wait; dedupe worker_done by dispatch                                                                                                                                            |
| A worker whose agent cannot log in (**401 / "Please run /login"**) receives the task and goes **silent** — no worker_done, Orca waits forever                                                                                                                                   | Preflight with `orca account list --json` (claude/codex only) and detect stalls from `worker-read --source auto`                                                                                                         |
| First `worker-start` can fail `agent_readiness` / `terminal_handle_stale`                                                                                                                                                                                                       | One `--retry-of <dispatch>` with the SAME explicit `--worktree path:` + `--agent`                                                                                                                                        |
| `worker-release` of a failed attempt or of a worker owned by another coordinator → `retained`                                                                                                                                                                                   | Report the residual terminals (`unclosedTerminals`), never close them — the guide says never substitute `terminal close` for release (`--reference recovery-and-cleanup`)                                                |
| `--worktree new-child` creates the worktree AND starts the agent in one step; `--setup skip` leaves no `node_modules`                                                                                                                                                           | Create with `orca worktree create --name --base-branch --parent-worktree current --setup skip` (no agent), adopt with `worktree_ensure(owner external)` (runs `setup`), then `worker-start --worktree path:<dir>`        |
| The MCP server inherits `ORCA_TERMINAL_HANDLE` from the agent's Orca terminal                                                                                                                                                                                                   | `run-create` from the MCP process binds the agent's terminal                                                                                                                                                             |
| `--retry-request` must be a UUID; `worktree create/rm` and `terminal close` don't accept it                                                                                                                                                                                     | Recover a lost `worktree create` via `orca worktree show --worktree name:<n>`                                                                                                                                            |
| OpenCode `worker-read --source auto` → `source: "terminal"`, `fallbackReason: "provider_unsupported"`, a `terminal.tail`, **no `transcript`**                                                                                                                                   | Stall evidence for OpenCode comes from the tail (`src/orca/stall-terminal.ts`)                                                                                                                                           |
| OpenCode's `worker-start` receipt has `turnStart: "unsupported"` and `prompt.observation: "unsupported"`                                                                                                                                                                        | Delivery is unconfirmable: `orca_start` reports `delivery_confirmed: false`                                                                                                                                              |
| Raw `orca terminal send` to a still-booting OpenCode TUI returns `accepted: true`, yet the text is **lost** (screen: splash + `Ask anything…`)                                                                                                                                  | A dropped brief shows the home screen and no dispatch id → `never-started` stall                                                                                                                                         |
| `orca terminal wait --for tui-idle` works for OpenCode (~3 s)                                                                                                                                                                                                                   | Usable by probes before sending to a fresh TUI                                                                                                                                                                           |
| `worker-start --terminal <handle>` waits for agent readiness, but the terminal is then `external_terminal` and release answers `retained`                                                                                                                                       | Sentinal starts workers with `--worktree`, not a caller-created terminal                                                                                                                                                 |
| `worker-show` `dispatchedAt` is `"YYYY-MM-DD HH:MM:SS"` UTC **without a zone**; a fast successful worker can still have `lastHeartbeatAt: null`                                                                                                                                 | Parse as UTC (`parseDispatchedAt`); a missing heartbeat alone proves nothing                                                                                                                                             |
| `worker-list` rows carry `terminalState: "reclaimable"` after settlement (and no `dispatchedAt`/heartbeat)                                                                                                                                                                      | `orca_wait` lists them as `reclaimable`; `worker-show` only for home-screen suspects and gap-unverifiable rows                                                                                                           |
| The echoed preamble shows `--dispatch-capability dcap_…` on screen                                                                                                                                                                                                              | Redact `dcap_[A-Za-z0-9_-]+` in every evidence string and fixture (`redactCapabilities`)                                                                                                                                 |
| `dispatch-show --preamble` omits the capability (issue #12)                                                                                                                                                                                                                     | Never use it to resend a brief; recover with `orca_stop` + `orca_start({retry_of})`                                                                                                                                      |
| `worker-stop` → `stop_unknown` when Orca marked the terminal `user_owned`/`user_takeover` (live, cause unknown); then `--retry-of` is refused                                                                                                                                   | Explicit `worker-abandon` (Sentinal: `orca_abandon`, gated on `worker-show` = `stop_unknown`) → dispatch `failed` → `--retry-of` accepted                                                                                |
| **1.4.209 (Linux, issue #12):** OpenCode `worker-read --source auto` → `fallbackReason: "session_not_reported"` (not `provider_unsupported`)                                                                                                                                    | Same terminal-tail evidence path; do not key anything on the exact `fallbackReason`                                                                                                                                      |
| **1.4.209:** a live PTY (`status.liveness: "live"` on the worker's own handle) showing the home screen was projected `provider: null`, `liveness: unverifiable/missing_status`, `attention: {categories: ["unverifiable"], requiresAction: true}`, `nextAction: {kind: "none"}` | Resolves to `absent` → no stall; with every never-started fact it becomes a `never-started-unverifiable` attention entry (no `evidence_id`). Bare `["unverifiable"]` rows are not reported: healthy workers carry it too |
| Orca's guide (1.4.209 and 1.4.216, `--reference recovery-and-cleanup`): "`unverifiable` liveness \| Keep waiting or inspect; never stop, abandon, retry, or release"; for `missing_status`/`capability_unsupported` a `worker-show` verdict outranks the row                    | `resolveLiveness` (`src/orca/stall-liveness.ts`) uses `worker-show` only for a positive `live`/`exited`; `host_unavailable` never consults it                                                                            |
| **1.4.209:** a manual `worker-stop` on that worker settled it as `exited/worker_stop` (`observation: {status: "exited", exactWorker: true}`) with `nextAction: worker-release`, and `--retry-of` then worked                                                                    | Outside the guide — the user did it by hand. Never automate it: Sentinal only reports attention and the user decides                                                                                                     |

⛔ Never stop/abandon/release/retry on `unverifiable` liveness — it yields an
`attention` entry only (no `evidence_id`; `orca_stop` refuses it). Act only on positive
evidence: `exited`, an auth error (last assistant turn or terminal tail), long
idle without worker_done, or `never-started`. Everything else about stop,
retry and release: `orca skills get orchestration --reference recovery-and-cleanup`.

**Live e2e without touching real state:** `orca worktree create --name
e2e-… --repo path:<repo> --base-branch <branch> --setup skip --no-parent`
for a throwaway coordinator; run the driver inside it via `orca terminal
create --worktree path:<dir> --command <script>` (so it has its own
`ORCA_TERMINAL_HANDLE`); isolate with `SENTINAL_HOME=/tmp/…`; use `--agent
opencode` when the Claude login is stale. Clean up: `orca terminal close`
only for terminals the probe itself created (never a worker's — release
those), then `orca worktree rm --force`, `git branch -D`.

## Verification

`orca status --json | scripts/orca-json.py runtime.state` prints `"ready"`;
`bun test src/orca/` replays the recorded fixtures in `src/orca/__fixtures__/`.

## When NOT to Use

- Unit tests: never run the real `orca` binary — inject the runner and replay
  fixtures.
- Handoffs without supervision (`orca-cli` skill territory).
- Generic Orca rules — read `orca skills get orchestration` instead.

## References

- `src/orca/` (adapter, dispatch, stall, stall-terminal), `src/orca/__fixtures__/`
- `docs/plans/2026-09-28-orca-orchestration.md` (Spike table, Live E2E)
- `docs/plans/2026-09-29-orca-dropped-prompt.md` (issue #12)
- `docs/plans/2026-09-30-orca-unverifiable-never-started.md` (unverifiable → attention)
- `orca skills get orchestration [--reference recovery-and-cleanup]`
