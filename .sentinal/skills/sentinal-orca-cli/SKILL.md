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
  reached its agent (issue #12), (10) pre-warmed starts, heartbeats nagging the
  coordinator, or `orca_rebind` / `request-show` (issue #13).
author: Claude Code
version: 1.2.0
---

# Orca CLI — verified behaviour (Orca 1.4.218, `orchestration.contract.v1`)

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
| `worker-start --terminal <handle>` waits for agent readiness, but the terminal is then `external_terminal` and release answers `retained`                                                                                                                                       | Pre-warmed starts (issue #13) use it; `orca_release` then closes the terminal Sentinal created (`state.createdTerminals`) — never an Orca-created one                                                                    |
| `worker-start` takes `--agent` OR `--terminal`, never both; with `--terminal`, pass `--worktree` for that terminal                                                                                                                                                              | `startOnce` sends exactly one of them (`src/orca/dispatch-start.ts`)                                                                                                                                                     |
| **Paste window (macOS, 2026-09-30, OpenCode 1.18.33):** bracketed paste on at ~0.8 s; input box drawn at 3.3–3.5 s warm, 3.3–5.8 s in a new worktree; a paste before the box is **dropped**, after it lands. Linux (#13): box at 5.2–6.6 s cold, 9/9 first starts failed        | `worker-start --agent` pastes at ~0.8 s → pre-warm: `terminal create` + `wait --for tui-idle` + poll `terminal read --screen` for the home screen + 1 s, then `worker-start --terminal` (`src/orca/dispatch-prewarm.ts`) |
| `terminal create` terminals can get the dispatch capability bound to the wrong pane (Orca #17741 defect 2; 14/600 `worker_done` rejected in one report)                                                                                                                         | Known risk of pre-warming; off switch `SENTINAL_ORCA_PREWARM_AGENTS=none`                                                                                                                                                |
| `orchestration request-show --request <id>` → `state: "completed"` (with `receipt` + `interpretation`), `"pending"`, or `"absent"` — Orca: "Absent is not proof that nothing happened"                                                                                          | A replay with no local record asks it: completed → the receipt, pending → pending, absent → `start_outcome_unknown` and nothing is started                                                                               |
| `orchestration run-show --id <run>` → `run.coordinator_handle`; `terminal show --terminal <h>` → `connected: true` for a live terminal, error `terminal_handle_stale` for a closed one                                                                                          | `orca_rebind` refuses (`rebind_refused`) while the old coordinator is connected, unless `force`; then `run-use`                                                                                                          |
| Orca nudges the coordinator for **every** pending delivery; heartbeats excluded by `check --types` stayed pending and nagged it                                                                                                                                                 | `orca_wait` asks for `heartbeat` too and auto-acks heartbeat-only deliveries (≤3 rounds); mixed ones report `heartbeats: N`                                                                                              |
| With Orca's `workspaceDir: .orca/worktrees`, child worktrees live **inside the repo**                                                                                                                                                                                           | Ignored by `.orca/.gitignore` (`worktrees/`), `eslint.config.mjs` (`.orca/**`), `.prettierignore` (`.orca/`); `bun test` already skips dot-folders                                                                       |
| `worker-show` `dispatchedAt` is `"YYYY-MM-DD HH:MM:SS"` UTC **without a zone**; a fast successful worker can still have `lastHeartbeatAt: null`                                                                                                                                 | Parse as UTC (`parseDispatchedAt`); a missing heartbeat alone proves nothing                                                                                                                                             |
| `worker-list` rows carry `terminalState: "reclaimable"` after settlement (and no `dispatchedAt`/heartbeat)                                                                                                                                                                      | `orca_wait` lists them as `reclaimable`; `worker-show` only for home-screen suspects and gap-unverifiable rows                                                                                                           |
| The echoed preamble shows `--dispatch-capability dcap_…` on screen                                                                                                                                                                                                              | Redact `dcap_[A-Za-z0-9_-]+` in every evidence string and fixture (`redactCapabilities`)                                                                                                                                 |
| `dispatch-show --preamble` omits the capability (issue #12)                                                                                                                                                                                                                     | Never use it to resend a brief; recover with `orca_stop` + `orca_start({retry_of})`                                                                                                                                      |
| `worker-stop` → `stop_unknown` when Orca marked the terminal `user_owned`/`user_takeover` (live, cause unknown); then `--retry-of` is refused                                                                                                                                   | Explicit `worker-abandon` (Sentinal: `orca_abandon`, gated on `worker-show` = `stop_unknown`) → dispatch `failed` → `--retry-of` accepted                                                                                |
| **1.4.209 (Linux, issue #12):** OpenCode `worker-read --source auto` → `fallbackReason: "session_not_reported"` (not `provider_unsupported`)                                                                                                                                    | Same terminal-tail evidence path; do not key anything on the exact `fallbackReason`                                                                                                                                      |
| **1.4.209:** a live PTY (`status.liveness: "live"` on the worker's own handle) showing the home screen was projected `provider: null`, `liveness: unverifiable/missing_status`, `attention: {categories: ["unverifiable"], requiresAction: true}`, `nextAction: {kind: "none"}` | Resolves to `absent` → no stall; with every never-started fact it becomes a `never-started-unverifiable` attention entry (no `evidence_id`). Bare `["unverifiable"]` rows are not reported: healthy workers carry it too |
| Orca's guide (1.4.209 and 1.4.216, `--reference recovery-and-cleanup`): "`unverifiable` liveness \| Keep waiting or inspect; never stop, abandon, retry, or release"; for `missing_status`/`capability_unsupported` a `worker-show` verdict outranks the row                    | `resolveLiveness` (`src/orca/stall-liveness.ts`) uses `worker-show` only for a positive `live`/`exited`; `host_unavailable` never consults it                                                                            |
| **1.4.209:** a manual `worker-stop` on that worker settled it as `exited/worker_stop` (`observation: {status: "exited", exactWorker: true}`) with `nextAction: worker-release`, and `--retry-of` then worked                                                                    | Outside the guide — the user did it by hand. Never automate it: Sentinal only reports attention and the user decides                                                                                                     |
| `orca terminal create --command "env OPENCODE_CONFIG_CONTENT='…' opencode"` works (2026-10-01, OpenCode 1.18.34), and Orca still reports `agentIdentity: opencode`                                                                                                              | Pre-warmed OpenCode workers get an inline per-process config (`src/orca/worker-access.ts`); nothing is written to the user's config                                                                                      |
| OpenCode's "Allow always" on an "Access external directory" prompt is a **session-only** rule; `external_directory` defaults to `ask` and takes absolute globs                                                                                                                  | Allow the coordinator/main checkouts up front in the inline config (`"<abs>/**": "allow"`)                                                                                                                               |
| OpenCode `edit` permission patterns match `path.relative(worktree, file)` — **absolute denies never match**; the last matching rule wins and agent rules come last; `*` matches deeper files                                                                                    | Read-only denies are relative (`"../../../*"`) and repeated for `build`/`plan`/`general`/`explore` (a `general` subagent's write was denied)                                                                             |
| **1.4.218:** `orchestration.contract.v1` unchanged; the OpenCode composer-wait PR #20451 is still open; Linux input box at 7.5–8.5 s cold (confirms #13)                                                                                                                        | Pre-warming is still needed; no adapter change for 1.4.218                                                                                                                                                               |
| `orca worktree rm` (no `--force`) can refuse once with a stale status — "Failed to delete worktree … ?? <file>" — just after that file was deleted (seen 2026-10-02, 1.4.218)                                                                                                   | `orca_remove_worktree` retries exactly once after 1.5 s, still without `--force`; a worktree that really has untracked files fails the retry too                                                                         |
| A worker's `ask` raises `attention: {categories: ["input"], requiresAction: true}` beside its `question` message                                                                                                                                                                | `orca_wait` hides that `input` entry while the dispatch has an open question (`state.openQuestions`, cleared by `orca_reply`); an `input` entry without one is still shown                                               |
| `orca terminal close` on a worker leaves its release `release_unknown` forever; closing the tab in the Orca UI settles cleanly (#13, Linux)                                                                                                                                     | Recovery prose says: close the tab in the Orca UI, never with `orca terminal close`                                                                                                                                      |

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
- `src/orca/dispatch-prewarm.ts` (pre-warmed start, `request-show`, closing Sentinal's terminals)
- `docs/plans/2026-09-30-orca-prewarmed-start.md` (issue #13)
- `src/orca/worker-access.ts` (inline `OPENCODE_CONFIG_CONTENT`: read-only directory access for
  pre-warmed workers; `docs/plans/2026-10-01-orca-worker-access.md`)
- Measuring the paste window: the reporter's `oc_startup.py` / `oc_paste.py` (issue #13,
  attachment 1) — time the input box and whether an early paste lands
- `docs/plans/2026-09-28-orca-orchestration.md` (Spike table, Live E2E)
- `docs/plans/2026-09-29-orca-dropped-prompt.md` (issue #12)
- `docs/plans/2026-09-30-orca-unverifiable-never-started.md` (unverifiable → attention)
- `orca skills get orchestration [--reference recovery-and-cleanup]`
