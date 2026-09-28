# Orca Orchestration for Spec Execution Implementation Plan

Created: 2026-09-28
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Spike (2026-09-28) — what Orca 1.4.215 actually does

Run `run_93672f816e9f`: task A (Orca-owned `new-child` worktree) and task B (`--deps [A]`, Sentinal-owned worktree from `worktree_create`, placed with `--worktree path:<dir>`). All resources removed afterwards.

| # | Finding | Evidence | Consequence for the design |
| --- | --- | --- | --- |
| S1 | **Dependencies are enforced by Orca.** Starting B early → `task_not_startable`, `unmetDependencies:[A]`; after A's `worker_done` A became `completed` and B `ready` automatically. | `worker-start` error payload; `task-list` | Waves can be expressed as a task DAG; Sentinal need not gate them itself. |
| S2 | **Full lifecycle works with an OpenCode worker**: `worker-start` → `ready`/`input_accepted` → `worker_done` (structured payload `outcome`, `filesModified`) → `check --ack` → `worker-release` (terminal closed, output archived). | `ctx_4c968df3149b`, `ctx_f82d5759596b` | A completion signal exists that Sentinal can parse. |
| S3 | **Both worktree owners work.** Orca `new-child` and a Sentinal `worktree_create` directory placed via `path:` both ran. | B ran in `.sentinal/worktrees/spec-…` | Worktree ownership is a free choice (decision below). |
| S4 | **A worker can stall without ever reporting.** Claude worker: `401 OAuth access token is invalid · Please run /login` — task injected, agent idle, no `worker_done`; Orca kept waiting. (Claude login on this host is stale: `orca account list` → `stale-token`.) | transcript of `ctx_f359d5e49a0b` | Sentinal needs its own stall detection (transcript/turn-ended-without-`worker_done`) and a preflight of the chosen agent's auth. |
| S5 | **First start failed at `agent_readiness` with `terminal_handle_stale`**; retry with `--retry-of` + explicit placement succeeded. `worker-release` on the failed attempt left its terminal "retained (user_takeover)" — needed a manual `terminal close`. | `ctx_854b8828942e` | Start must handle `failed` → one `--retry-of` retry, and clean residual terminals itself. |
| S6 | **Orca child worktrees with `--setup skip` have no `node_modules`** → the worker's tests could not run (zod unresolved). | worker A's report | Worktrees need dependency setup (Sentinal's seeding / `bun install`, or Orca `--setup run` with a repo setup hook). |
| S7 | **Sentinal is live inside Orca workers**: OpenCode plugin loaded (session banner), `spec_status` MCP answered. But the worker saw the *identity* project's current spec (a plan in another checkout) while its worktree banner named a different plan. | worker B's report | Every dispatched spec must name the plan path and task explicitly; never rely on discovery. |
| S8 | **CLI output shapes**: `check --wait --json` streams NDJSON keepalive lines before the final JSON object; most mutations print pretty JSON. Timeouts are checkpoints (`timedOut:true`), not failures. | `/tmp/spike-chk*.json` | A robust parser: take the last JSON document; treat timeout as "keep waiting". |
| S9 | `worker-start --agent` supports `claude`, `codex`, `opencode`, … ; `--model`/`--effort` only for Claude/Codex/Cursor. This session is itself an Orca terminal (`ORCA_TERMINAL_HANDLE`), so it can be the coordinator; a coordinator binds one Run per terminal. | `worker-start --help`, env | "Same agent as the coordinator" is implementable on both targets; Orca mode needs the coordinator to run inside Orca. |

## Deferred Issues

- `plan_impact` reported "No tasks found" for this plan while a `## Spike` appendix (with tables) followed `## Implementation Tasks`; `spec_plan_parse` parsed all 13. Moving the appendix above the Summary fixed it. Likely a section-boundary bug in `src/analysis/plan-files.ts` — out of scope here.

## Summary

**Goal:** Let `/spec` execute waves through Orca supervised workers — master-plan phases by default when running inside Orca, single-plan wave tasks opt-in — with Sentinal able to *adopt* worktrees another tool created (slot, `.env` seeding, row, merge) without ever destroying them.

**Architecture:** Four layers. (1) Worktree ownership: a `worktrees.owner`/`slug` schema, ownership-safe exits, merge in the worktree that holds the base, and `ensureWorktree` (create-or-adopt) with an optional `setup` step from `.sentinal/runtime.json`. (2) An Orca adapter (`src/orca/`): CLI wrapper, detection/auth preflight, a dispatch engine (start with one retry, bounded wait, stall detection, stop/release). (3) Surfaces: `worktree_ensure` + `sentinal worktree ensure`, and `orca_*` MCP tools. (4) The spec skills/commands in both targets switch to Orca mode when enabled, falling back to today's subagents.

**Tech Stack:** TypeScript (strict), Bun 1.3.10, `bun:test`, SQLite (migration V15), Orca CLI 1.4.215 (`orchestration.contract.v1`), both targets.

## Scope

### In Scope

- **Ownership (Tasks 1, 5, 7):** `worktrees.owner` (`sentinal` | `external`, default `sentinal`) and `slug`; cleanup/abandon/sync never delete an external worktree or branch; squash-merge in the worktree holding the base.
- **Adopt (Tasks 3, 8, 9):** `ensureWorktree` + `worktree_ensure` MCP tool + `sentinal worktree ensure` CLI; `setup` field in `runtime.json`, run once after create/adopt.
- **Orca (Tasks 2, 6, 10):** adapter, dispatch engine with stall detection and auth preflight, `orca_*` MCP tools.
- **Enablement (Task 4):** `SENTINAL_ORCHESTRATION=auto|orca|subagents` (default `auto` = Orca when the coordinator runs in an Orca terminal and `orca status` is ready) and a plan header `Orchestration: orca|subagents` overriding it.
- **Skills/commands (Tasks 11, 12):** `spec-master-execute` Orca mode (Orca creates each phase worktree with `new-child`, Sentinal adopts it as `external`); `spec-implement` opt-in Orca mode for wave tasks (`--worktree current`, shared directory). Workers run the coordinator's agent (Claude Code → `claude`, OpenCode → `opencode`), overridable per plan.
- **Stall handling:** a worker whose last turn ended without `worker_done` (or whose agent failed auth) is stopped under Orca's positive-evidence rule and the user is asked Retry / Skip / Stop.

### Out of Scope

- Codex/other agents as a default (only via explicit override; they have no Sentinal hooks).
- Remote Orca servers (`--on`), decision gates, Orca automations.
- Auto-adopting foreign worktrees on read paths (`reconcile` stays exact-match — adoption is always explicit).
- Changing Orca itself; fixing the user's stale Claude login.

## Context for Implementer

> Linked git worktree (Orca) of `/Users/evan/Projects/endpoint_esports/sentinal`. Read `.sentinal/rules/sentinal-project.md` ("Worktree slot pool…", identity vs workspace) and `sentinal-mcp-servers.md` (Worktree domain ⛔ notes) first. The spike table below is the ground truth about Orca.

### Worktree facts (verified)

- `createWorktree` (`src/worktree/create.ts:38-181`): steps that need Sentinal to have made the worktree are only naming (`:80-84`, branch `sentinal/spec-<slug>`, dir `<main>/.sentinal/worktrees/spec-<slug>-<hex>`), `ALREADY_EXISTS` (`:87-92`), `git worktree add` (`:96-99`) and the rollback (`:151-161`, `git worktree remove --force` — must never run on an adopted dir). Scope (`slot-scope.ts:41-58`), slot insert (`slot-pool.ts:126-175`), seeding (`worktree-config.ts:282-391`, non-throwing `seedNonFatally` `:375`) work on any worktree of the repo.
- `reconcile.ts:73-144` already re-registers an on-disk worktree (merge-base for `baseCommit` `:89-94`, `ensureSlot` `:158-197`) but only for branch `sentinal/spec-<slugify(slug)>` (`:78`) — keep that exact match.
- Row schema: `migrations-legacy.ts:148-160` + `slot` (`migrations-v12.ts:52-59`); `branch_name`/`worktree_path` are free text; **no owner, no slug column**. `resolveBySlug` (`store.ts:322-375`) finds rows by `spec_id` or branch prefix only.
- ⛔ Destructive exits with no ownership check: cleanup default pass runs `git branch -D` for any active row whose dir is gone (`cleanup.ts:139-159`, non-force, routine); `abandon` does `git worktree remove --force` → `rmSync` → `branch -D` (`manager.ts:323-369`); `squashMerge` → `removeMergedWorktree` (`merge-guards.ts:229-256`, `manager.ts:298`). Force-pass guards 1 (branch prefix, `cleanup.ts:245`) and 2 (under `<any checkout>/.sentinal/worktrees`, `:200-205,248-252`) stay.
- Merge: `inMainCheckout` + `assertBaseFreeForMerge` (`merge-guards.ts:160-217`) refuse when the base is checked out in another worktree (`BASE_CHECKED_OUT`) — an Orca child branched off the coordinator's branch always hits this.
- Membership: `resolveSlotScope(path)` → `roots` (every `git worktree list` entry, raw + realpath) and `key` (main checkout). Adopt requires `realpath(path) ∈ roots`, `≠ key`, non-null branch ≠ base.
- Sizes: `manager.ts` 399, `store.ts` 397, `parser.ts` 399, `worktree.ts` (CLI) 394, `worktree/mcp-tools.ts` 342 — extract before adding.
- `src/worktree/` must not import `src/runtime/` (`runtime/no-module-cycle.test.ts`); runtime config is threaded down (`src/mcp/server.ts:51-60`). The `setup` runner therefore lives in `src/runtime/` and is injected.
- `runtime.json` is `.strict()` and currently rejects `bootstrap` (`schema.test.ts:132-134`); the Phase 3 plan cut it "until it has a defined lifecycle position (once per worktree creation, before first up)" — this plan supplies that position, under the name `setup`.
- Tests to extend: `create`, `cleanup` (guard-1 Orca regressions `:620-641`), `reconcile`, `store` (`resolveBySlug` `:297-423`), `merge-guards`, `manager`, `mcp-tools`, `cleanup-mcp-tool`, `sidecar/worktree-routes`, `cli/commands/worktree*`, `runtime/worktree-deps.test.ts` (`SITES` `:32-36`, construction count `:292-298`), `mcp/server.test.ts`.

### Orca facts

See the Spike table (S1–S9). Orca commands used: `status --json`, `account list --json`, `orchestration run-create|run-current|task-create --deps|worker-start (--task|--spec) --worktree new-child|current|path:<dir> --agent <id> [--retry-of]|check --wait --types … --timeout-ms|check --ack|worker-list --run|worker-show|worker-read --source auto|worker-stop|worker-release`, `terminal close`, `worktree rm`. Load `orca skills get orchestration --reference recovery-and-cleanup` before touching recovery logic. ⛔ Never stop/abandon/release a worker on absence (`unverifiable`); only on positive evidence.

### Cross-cutting gotchas

- `quality_report` only with `file`; CI gates tsc/plugin tsc/eslint/prettier — run `bun run format` on your files.
- Editing `targets/*/commands|skills|rules` → one baseline-regenerating task per wave (`sentinal-parity-baselines`); then `bun run embed-assets`.
- Orchestrator-only builds in parallel waves (`build:opencode`, `embed-assets`).
- Tests never spawn the real `orca` binary against the user's app: inject a fake runner (a script on PATH or a function) that replays the spike's JSON shapes, including NDJSON keepalives.
- Tool counts: `sentinal-mcp-servers.md` header + README catalog (37 → 37 + 1 worktree + N orca).

## Key Decisions

- **D1 — Ownership.** V15 adds `worktrees.owner TEXT NOT NULL DEFAULT 'sentinal'` and `worktrees.slug TEXT` (+ a **non-unique** index `(project_path, slug)` — a unique one could fail `unifyLiveKeys` re-keying the way `idx_wt_slot_live` can); `spec_id` is written only when the plan's spec row resolves (V14 FK), else NULL and linked later; recorded only after verification, never throwing out of the constructor. Existing rows stay `sentinal`: current behaviour unchanged.
- **D2 — External exits.** `owner='external'`: abandon = *release* (stop Sentinal's own runtime, strip only Sentinal-seeded files — `.sentinal/worktree.env`, and `.env` only if Sentinal wrote it and it is unchanged — then mark terminal); never `worktree remove`/`rmSync`/`branch -D`. Cleanup default pass marks terminal only. New force guard 6: never touch a path with an external row. Squash-merge commits then strips seeded files and marks `merged` without removing dir/branch. Deleting an external worktree requires an explicit takeover (`ensure --owner sentinal --path`).
- **D3 — Merge location.** If the base branch is checked out in a worktree of the repo, squash-merge there (e.g. the coordinator's checkout); otherwise the main checkout as today. The holder must be clean (the existing check, `merge-guards.ts:141`, raises `DIRTY_MAIN_CHECKOUT`); the coordinator therefore commits its master-plan edits before each sync (D8), and the error message names the dirty files and this remedy.
- **D4 — `ensureWorktree({slug, project, path?, base?, owner, seed})`.** Idempotent: existing live row by slug → return it (+`ensureSlot`); same path with a different slug/owner → `ALREADY_EXISTS`, never silent re-own. No path + `sentinal` → reconcile-then-create (today's behaviour). With a path: validate membership, `base` required for `external`, `baseCommit = merge-base`, `insertWithSlot` with owner+slug, `seedNonFatally`, then `setup`. Failure after insert deletes only the row, never the directory.
- **D5 — `setup` in `runtime.json`.** `setup: string` (slot-interpolated like `up`), run once in the worktree after create/adopt + seeding, with a timeout, output tail in `.sentinal/runtime.log`, result reported as a warning on failure; never part of a rollback. Opt-in per project; Sentinal's own repo declares `bun install --frozen-lockfile`.
- **D6a — Verified after review:** the Sentinal MCP server process inherits `ORCA_TERMINAL_HANDLE` from the agent's Orca terminal (`ps eww` on the live servers), and `run-create` from a child process binds that terminal as coordinator (spike). Tools still accept an explicit `coordinator_handle` override.
- **D6 — Enablement.** `SENTINAL_ORCHESTRATION=auto|orca|subagents` (default `auto`), shown by `spec_config`; plan header `Orchestration: orca|subagents` wins. `auto` = Orca iff `ORCA_TERMINAL_HANDLE` is set and `orca status --json` reports `runtime.state: ready` and capability `orchestration.contract.v1`. Otherwise subagents, with one line saying why.
- **D7 — Dispatch engine.** One Run per coordinator execution (`run-current` reused if bound). Per task: optional auth preflight (`account list`: refuse `claude` when its status is `error`/`stale-token`, suggest `opencode` or `/login`); `worker-start`; on `failed` exactly one `--retry-of` with explicit placement, then close residual terminals listed in `residualResources`. Waves = `task-create --deps` (Orca enforces order, S1). `orca_wait` does one bounded `check --wait` (default 40 s, max 45 s — below the MCP SDK's 60 s request timeout; NDJSON-tolerant parser) and returns settled `worker_done` payloads plus stall verdicts; the skill loops. Stall = `worker-list` liveness `exited`, or a transcript whose last assistant turn is older than N minutes (default 10) without `worker_done`, or an auth error in the last turn → `worker-stop`, then ask the user Retry / Skip / Stop. `release` after the coordinator has recorded each settlement.
- **D8 — Master mode (revised after review: prepare the worktree BEFORE the worker starts).** Per phase: `orca worktree create --name spec-<slug> --base-branch <coordinator branch> --parent-worktree current --setup skip` (no agent) → `worktree_ensure(path, owner=external, base=<coordinator branch>)` (slot, seeding, `setup`) → `worker-start --task <id> --worktree path:<dir> --agent <coordinator's agent>` (path placement proven in S3). The worker runs `/spec <child plan path>` with the plan path, phase and "report `worker_done` with the child plan's final Status" spelled out (S7). Completion = child plan file says `VERIFIED` (the existing rule: never trust the report), then the coordinator commits its own master-plan checkbox edits and `worktree_sync` merges into the coordinator's branch (D3); then `worktree_abandon` (external → release: slot freed, seeded files stripped) and `orca worktree rm`. The same release runs on Skip/Stop, so no slot leaks.
- **D9 — Single-plan mode (opt-in).** Wave tasks → `worker-start --worktree current`, one Task per plan task, same spec contract as today's sub-agent prompt; the orchestrator still runs builds once per wave and updates checkboxes.

## Implementation Notes (Wave 1)

- Full suite 4,206 pass / 0 fail; tsc, plugin tsc, eslint, prettier, bundle guard, no-module-cycle green.
- Task 1: V15 (`migrations-v15.ts`), `store-rows.ts` split (`store.ts` 331). `owner` optional in the type (absent ⇒ sentinal) — **Task 5 must test `owner === "external"`**. Slug stored slugified. Rehearsal on a DB copy: 65 worktrees → owner sentinal, FK/quick_check clean.
- Task 2: `src/orca/{cli,detect,types}.ts` + real fixtures. `agentAuth` returns `ok:false` with the real `failureKind` (e.g. `rate-limited`) — **callers refuse on `ok === false`, not on a reason string**. Error envelopes on stdout (exit 1); `check --wait` keepalives on stderr.
- Task 3: `setup` in schema/loader/`interpolate.ts`; `runWorktreeSetup` (`src/runtime/setup.ts`, kills only `sh` on timeout — no second signalling path); repo `.sentinal/runtime.json` = `{"setup":"bun install --frozen-lockfile"}` (untracked, to commit).
- Task 4: `parser-header.ts` split (`parser.ts` 325); async `resolveOrchestrationMode`; env `orca` does not enable single plans — only the header does.

## Implementation Notes (Wave 2)

- Full suite 4,273 pass / 0 fail; all gates green.
- Task 5: `src/worktree/abandon.ts` (external → release: `worktree.env` removed unless tracked; `.env` only if untracked and byte-identical to the template for the row's slot; Sentinal `.gitignore` entries only if the file starts with Sentinal's header; `rmdir` never recursive; failed runtime stop aborts). Cleanup default pass: external rows → `abandoned` + warning, no `branch -D`/prune. Force guard 6 (any status). `manager.ts` 309. **Carry to Task 9:** `worktree_abandon` tool (`mcp-tools.ts:~335`) and `POST /worktree/abandon` (`worktree-routes.ts:~177`) must return `result.message`/`warnings`/`outcome`.
- Task 6: `src/orca/dispatch.ts` + `dispatch-start.ts` + `stall.ts`. Every mutation sends a UUID `--retry-request`. Retry of a failed `new-child` reuses the created worktree via `path:`. `terminal close` only when a release reports `retained`. Shapes read from Orca's CLI source (not live): `worker-list`, `worker-release/stop`, `run-current`, `worktree create/show` — **verify live in the e2e run**. **Carry to Task 10:** `worker-start` may take ~60 s (> MCP 60 s request timeout).

## Implementation Notes (Wave 3)

- Full suite 4,312 pass / 0 fail; all gates green.
- Task 7: `src/worktree/merge.ts` (`squashMergeWorktree` → `{commit, mergedIn, outcome}`), `resolveMergeCheckout` in `merge-guards.ts`; `manager.squashMerge` still returns a string, `squashMergeDetailed` returns the full result. A dirty holder raises `DIRTY_MAIN_CHECKOUT` naming files + remedy (D3 wording wins over the Task 7 DoD typo). One existing test rewritten: "base checked out in a linked worktree" now merges INTO that holder (D3). `stripSeededFiles` exported from `abandon.ts`.
- Task 8: `src/worktree/adopt.ts` `ensureWorktree`; `create.ts` gains `createWorktreeWithSetup` + `runSetupNonFatally` (setup failures are warnings, never delete the row or dir); adoption failures during seeding delete only the row. **Carry to Task 9:** setup runner injected via `WorktreeConfig.runSetup` filled by `runtimeWorktreeConfig()`.

## Implementation Notes (Wave 4)

- Task 9: `worktree_ensure` (`src/worktree/adopt-mcp-tool.ts`) + `sentinal worktree ensure` (`worktree-adopt.ts`); `WorktreeConfig.runSetup` filled by `runtimeWorktreeConfig()`; `manager.createWithSetup()` (the `worktree_create` tool uses it — the CLI `worktree create` does not run setup; `ensure` without `--path` does); abandon tool/route return `outcome`/`message`/`warnings`; `worktree_sync` reports `Merged in`. `client-routes.ts` `abandonWorktree` now returns the payload.
- Task 10: 8 tools — `orca_status`, `orca_dispatch` (creates Run/tasks and prepare-child worktrees, never starts workers), `orca_start` (≤45 s budget; `pending` + same `request_id` joins or replays via `--retry-request`), `orca_wait` (≤45 s, never acks), `orca_ack`, `orca_stop` (needs a one-shot evidence id from the latest `orca_wait`), `orca_release`, `orca_remove_worktree` (no `--force`). Split across `src/orca/mcp-tools{,-start,-settle,-shared}.ts`. Tool count 37 → 46 (8 domains).
- Integration fix: `orca_status.scope` switched to `requiredEnum()` (the repo's required-enum drift guard caught it).

## Implementation Notes (Waves 5–7)

- Task 11: Step 0 (`orca_status` → mode) and an "Orca Mode" section added verbatim to both targets' `spec-master-execute`: commit own edits → `orca_dispatch` (prepare-child) → `worktree_ensure(external)` → `orca_start` → loop `orca_wait` → child file VERIFIED → `worktree_sync` → `orca_release` → `worktree_abandon` (release) → `orca_remove_worktree`; stalls → `orca_stop` + ask. Parity: only line headers moved.
- Task 12: opt-in Orca Mode paragraph in both targets' `spec-implement` (`Orchestration: orca` header only; `worktree: "current"`). Parity hunk counts unchanged.
- Task 13: 46 tools / 8 domains (counted from `createSentinalServer`); `sentinal-mcp-servers.md` (Worktree 7, new Orca domain, ownership + merge ⛔ notes), README catalog, `cli-tools.md` both targets (`worktree_ensure`), `sentinal-project.md` (ownership/adoption, `setup`, Orca orchestration, directory tree).

## Live E2E (2026-09-28) — two-phase master plan through Orca

Driven with the working-tree source and the real `orca` runner (Orca 1.4.215), OpenCode workers, a throwaway coordinator worktree `e2e-orca-coord` (Orca-created), isolated `SENTINAL_HOME`. Sequence = Task 11's Orca Mode.

| Step | Result |
| --- | --- |
| `orca worktree create` (no agent) ×2 → `ensureWorktree(external)` | ✅ slots 1, 2; owner `external`; `setup` ran ok (this repo's `bun install`) |
| Removal guard | ✅ refused the coordinator's own checkout and the live adopted worktree ("call worktree_abandon first") |
| Start B before A settled | ✅ `blocked`, `unmetDependencies:[A]` (Orca enforces the DAG) |
| A: start → worker commits → `worker_done` | ✅ ~13 s |
| Merge A | ✅ squash commit landed in the coordinator's checkout (D3); child dir + branch survived until `orca worktree rm` (D2) |
| B started after A, committed, `worker_done` | ✅ |
| Resume in a NEW coordinator terminal | ⚠️→✅ first attempt got `consumer_fenced` (a Run is bound to one terminal) → **fixed**: `ensureRun({runId})` / `orca_dispatch({run_id})` binds with `run-use`; resumed run then worked |
| Re-sent un-acked delivery | ⚠️→✅ my driver acked late and saw A's `worker_done` twice → **fixed**: `orca_wait` flags `replayed` for dispatches already released in the session; skill says ack each batch before the next wait and skip replayed rows |
| Merge B | ✅ second squash commit on the coordinator branch; final tree has both phase files |
| End state | ✅ both rows `merged`, slots freed; Orca child worktrees + branches removed by Orca; all e2e artifacts cleaned |

Shapes confirmed live that Task 6 had read from Orca's source: `run-current`, `worktree create`, `worker-list` (`projection.liveness.verdict`), `worker-release` (`released` / `retained`).

Not run live: a stalled worker (covered by the spike's real 401 transcript fixture), and the opt-in single-plan mode (same tools with `worktree: "current"`; unit-tested).

## Spec Review (2026-09-28) — 1 must_fix, 4 should_fix

| Finding | Resolution |
| --- | --- |
| **must** `orca_remove_worktree` only checked the path was absolute — could remove the main checkout, the coordinator's checkout, or a worktree Sentinal still held | `src/worktree/removal-guard.ts` `guardOrcaWorktreeRemoval`, injected by `src/mcp/server.ts` (opens the DB per check since `store` is null under the sidecar); refuses non-members, the main checkout, the calling session's checkout, and live Sentinal rows (→ "call worktree_abandon first"). Real-git tests + server wiring test; mutation-checked |
| should: `worktree_ensure(owner:"sentinal", path)` silently took over a worktree Sentinal did not create (later deletable) | Requires explicit `takeover: true` (tool) / `--takeover` (CLI); otherwise refused with guidance to use `owner: "external"` |
| should: `orca_wait` total time unbounded (stall checks after the wait) | Wait default 35 s / max 40 s; `collectStalls` shares one ≤10 s deadline across list + reads and skips rows once it runs out (absence, never a stall). Worst case ≈ 40 + 5 slack + 10 = 55 s |
| should: `orca_start` budget may not cover the auth preflight | Not an issue: the 45 s `Promise.race` wraps the whole `startTask`, preflight included |
| should: `orca_release` does not check the worker has settled | Orca enforces it (`worker-release` acts only on settled workers; anything else is `retained` without process action — `--help`), so no extra check |
| suggestions (MAX_ACTIVE outside the tx; silent stale-row release; prose↔schema test) | Deferred; prose params spot-checked by hand in Task 11/12 |

## Plan Review (2026-09-28) — 3 must_fix, 5 should_fix, 3 consider

| Finding | Resolution |
| --- | --- |
| **must** Workers start before adoption/setup (S6 again) | D8: `orca worktree create` (no agent) → `worktree_ensure` → `worker-start --worktree path:` |
| **must** Coordinator's own checkout is dirty with checkbox edits → every sync refused (`DIRTY_MAIN_CHECKOUT`) | D3/D8: coordinator commits its plan edits before each sync; error names files + remedy |
| **must** Task 3 misses `loader.ts` interpolation and the `up`⇒`readiness` assumptions | Added `loader.ts`, `lifecycle.ts`; setup-only contract must parse |
| should: `ORCA_TERMINAL_HANDLE` in the MCP process unverified | Verified (D6a); explicit override kept |
| should: `orca_wait` 100 s > MCP 60 s timeout | Default 40 s, max 45 s |
| should: V15 slug index / spec FK | Non-unique index; `spec_id` only when it resolves |
| should: `new-child` flag combination and `orca worktree rm` effects | Moot for creation (D8 uses `orca worktree create`, flags documented there); release through Sentinal before `orca worktree rm`, also on Skip/Stop |
| should: slot leak when Orca removes a worktree | Same release path |
| consider: paste the destructive-site list into Task 5 | Done |
| consider: pass the coordinator's agent explicitly | Done (Task 11) |
| consider: plugin transitively imports `parser.ts`? | Task 4 runs the bundle guard |

## Execution Waves

**Wave 1** (parallel): Tasks 1, 2, 3, 4 — schema, Orca adapter, `setup` field, enablement; disjoint files.
**Wave 2** (parallel): Tasks 5, 6 — ownership-safe abandon/cleanup (needs 1); dispatch engine (needs 2).
**Wave 3** (parallel): Tasks 7, 8 — merge location (touches `manager.ts` after 5); `ensureWorktree` (needs 1, 3; no `manager.ts` edit).
**Wave 4** (parallel): Tasks 9, 10 — worktree surfaces; Orca MCP tools.
**Wave 5**: Task 11 — `spec-master-execute` Orca mode (both targets; regenerates parity baselines).
**Wave 6**: Task 12 — `spec-implement` opt-in Orca mode (both targets; regenerates baselines).
**Wave 7**: Task 13 — docs, counts, `cli-tools.md` rows (regenerates baselines).

⛔ Parallel tasks must not run `build:opencode`/`embed-assets`; the orchestrator does after each wave.

## Assumptions

- Orca's CLI shapes seen in the spike (S1–S9) are stable within `orchestration.contract.v1` — Tasks 2, 6, 10; the adapter checks the capability and degrades to subagents if absent.
- `git worktree list` from any checkout lists Orca-created worktrees (they are plain linked worktrees) — Task 8.
- Running `/spec` inside an Orca OpenCode worker behaves like a normal session (S7: plugin + MCP live) — Task 11.

## Testing Strategy

- Unit tests with a fake `orca` runner replaying spike JSON (pretty JSON, NDJSON keepalives + final object, `task_not_startable`, `failed/agent_readiness/terminal_handle_stale`, `worker_done` payloads, auth `stale-token`, stall transcripts).
- Real git fixtures for adopt/ownership: an "external" worktree created with plain `git worktree add` on a non-`sentinal/spec-` branch; assert abandon/cleanup/sync never remove it or its branch (mutation-checked), merge lands in the base-holding worktree.
- Migration V15 via the real `runMigrations` on a V14 DB; rehearse on a copy of the user's DB.
- Live end-to-end (verification): a two-phase scratch master plan run through Orca with OpenCode workers, from this Orca terminal, plus a two-task single-plan wave in opt-in mode.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| An ownership-blind exit deletes an Orca worktree | Medium | **High** | D2 at every exit; guard 6; tests with real external worktrees; mutation checks |
| Orca CLI changes shape | Medium | Medium | Capability check; one adapter module; fake-runner fixtures; fall back to subagents |
| Silent worker stall blocks a wave | High (seen in spike) | Medium | Auth preflight + stall verdicts in `orca_wait`; user decides |
| Merge in the coordinator's checkout surprises the user | Low | Medium | Only when that checkout holds the base and is clean; reported in the sync result |
| `setup` slows every create/adopt | Medium | Low | Opt-in; timeout; runs once |
| Both targets drift | Medium | Medium | Shared MCP tools carry the logic; prose only calls them; parity baselines |

## Pre-Mortem

1. **An adopted worktree is deleted anyway** through a path we did not audit (e.g. the OpenCode workspace adaptor's `remove()`). (Tasks 5, 7) → Trigger: grep for `worktree remove|rmSync|branch -D` in `src/` finds a call site without an owner check.
2. **Workers never report because the prompt did not tell them how** (the `/spec` run ends without `worker_done`). (Task 11) → Trigger: the live e2e phase finishes (plan VERIFIED) but `orca_wait` reports a stall.
3. **`auto` picks Orca in a non-Orca session** (env var inherited by a subprocess). (Task 4) → Trigger: `orca status` ready but `run-current`/`run-create` binds to a different terminal handle than `ORCA_TERMINAL_HANDLE`.

## Goal Verification

### Truths

1. An `external` worktree survives `worktree_abandon`, `worktree_cleanup` (default and force) and `worktree_sync`: directory and branch still exist (tests).
2. `worktree_ensure` on an Orca-style worktree yields a live row with a slot, `owner=external`, seeded `.env`/`worktree.env`, and a second call returns the same row (tests).
3. `worktree_sync` of a child whose base is checked out in a clean linked worktree commits there (test).
4. `orca_wait` returns `worker_done` payloads from NDJSON output and a stall verdict for a transcript ending in `401` (tests).
5. With `ORCA_TERMINAL_HANDLE` unset, `auto` resolves to subagents (test); `spec_config` lists `SENTINAL_ORCHESTRATION`.
6. `targets/*/commands|skills/spec-master-execute` call `orca_dispatch`/`orca_wait` in Orca mode and keep the subagent path (grep).
7. Live: a two-phase scratch master plan completes through Orca with both phases VERIFIED and merged, and no worker terminal or worktree left behind.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/memory/migrations-v15.ts` | owner/slug columns | `migrateV15` |
| `src/worktree/adopt.ts` | create-or-adopt | `ensureWorktree` |
| `src/runtime/setup.ts` | post-create setup | `runWorktreeSetup` |
| `src/orca/cli.ts`, `src/orca/detect.ts`, `src/orca/dispatch.ts` | Orca adapter + engine | `runOrca`, `detectOrca`, `startTask`, `waitForSettlement` |
| `src/orca/mcp-tools.ts` | MCP surface | `registerOrcaTools` |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/mcp/server.ts` | `src/orca/mcp-tools.ts` | registration | `registerOrcaTools` |
| `src/worktree/adopt-mcp-tool.ts` | `src/worktree/adopt.ts` | tool handler | `ensureWorktree` |
| `targets/*/…/spec-master-execute` | `orca_dispatch` | Orca mode | `orca_dispatch` |

## Progress Tracking

- [x] Task 1: V15 — `worktrees.owner` + `slug`; store support (Wave 1)
- [x] Task 2: Orca CLI adapter + detection + auth preflight (Wave 1)
- [x] Task 3: `setup` in `runtime.json` + runner (Wave 1)
- [x] Task 4: Enablement — env toggle + plan header (Wave 1)
- [x] Task 5: Ownership-safe abandon and cleanup (Wave 2)
- [x] Task 6: Orca dispatch engine (Wave 2)
- [x] Task 7: Merge in the worktree holding the base; external merge (Wave 3)
- [x] Task 8: `ensureWorktree` (create-or-adopt) + setup wiring (Wave 3)
- [x] Task 9: `worktree_ensure` MCP tool + `sentinal worktree ensure` CLI (Wave 4)
- [x] Task 10: `orca_*` MCP tools (Wave 4)
- [x] Task 11: `spec-master-execute` Orca mode, both targets (Wave 5)
- [x] Task 12: `spec-implement` opt-in Orca mode, both targets (Wave 6)
- [x] Task 13: Docs, counts, CLI rows (Wave 7)

**Total Tasks:** 13 | **Completed:** 13 | **Remaining:** 0

## Implementation Tasks

### Task 1: V15 — `worktrees.owner` + `slug`; store support

**Objective:** Rows record who owns the worktree and the slug it was ensured under.
**Dependencies:** None
**Wave:** 1

**Files:**
- Create: `src/memory/migrations-v15.ts`, `src/memory/migrations-v15.test.ts`
- Modify: `src/memory/migrations.ts`, `src/memory/types.ts` (`SCHEMA_VERSION` 15), `src/worktree/types.ts`, `src/worktree/store.ts` (insert/deserialize owner+slug; `resolveBySlug` matches the slug column between `spec_id` and branch; slugify consistently with `create.ts:80`), `src/worktree/slot-pool.ts` (`insertWithSlot` carries owner+slug)
- Test: `src/worktree/store.test.ts`, `src/memory/migrations.test.ts`

**Key Decisions / Notes:** D1. `store.ts` is 397 lines — move row (de)serialization to `src/worktree/store-rows.ts` first. Rehearse V15 on a copy of the user's DB.

**Definition of Done:**
- [ ] Fresh DB and a V14 DB both reach V15; existing rows `owner='sentinal'`; FK/`quick_check` clean
- [ ] `resolveBySlug(slug)` finds a row whose branch has no Sentinal prefix via its `slug` (test)

**Verify:** `bun test src/memory/migrations*.test.ts src/worktree/`

---

### Task 2: Orca CLI adapter + detection + auth preflight

**Objective:** One module talks to `orca`; everything else sees typed results.
**Dependencies:** None
**Wave:** 1

**Files:**
- Create: `src/orca/cli.ts` (spawn `orca … --json` with timeout; parse the LAST JSON document — pretty or NDJSON; typed `{ok, result|error}`), `src/orca/detect.ts` (`detectOrca()`: `ORCA_TERMINAL_HANDLE`, `status --json` → ready + `orchestration.contract.v1`; `agentAuth(agent)` from `account list --json`), tests with a fake runner

**Key Decisions / Notes:** Injectable runner (function) for tests; never the real binary in tests. Binary path from `PATH` (`orca`) or `ORCA_CODEX_LAUNCH_PREFLIGHT`'s sibling is NOT assumed. No `bun:sqlite`/zod imports (may be reachable from the plugin later).

**Definition of Done:**
- [ ] Parses every spike output shape (fixtures), including keepalive NDJSON and error envelopes
- [ ] `detectOrca` false without the env var or on a non-ready runtime; `agentAuth("claude")` reports stale on the spike's `account list` shape

**Verify:** `bun test src/orca/`

---

### Task 3: `setup` in `runtime.json` + runner

**Objective:** Projects can declare a once-per-worktree setup command.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/runtime/schema.ts` (optional `setup: string`; a contract with only `setup` must parse — relax the `up`⇒`readiness` refinement only as far as needed), `src/runtime/loader.ts` (slot interpolation + token checks `:199-223` must cover `setup`), `src/runtime/lifecycle.ts` (`runtime_up` must report "no `up` declared" instead of assuming `readiness`, `:338`), `src/runtime/schema.test.ts` (still reject unknown keys incl. `bootstrap`), `.sentinal/runtime.json` of this repo if present (else create with `setup: "bun install --frozen-lockfile"` only if the schema allows a setup-only contract — check `up`/`readiness` requirements)
- Create: `src/runtime/setup.ts` (`runWorktreeSetup(worktreePath, contract, {timeoutMs})` → `{ran, ok, exitCode, tail}`; appends to `.sentinal/runtime.log`), `src/runtime/setup.test.ts`

**Key Decisions / Notes:** D5. Lives in `src/runtime/` and is injected into worktree code (no-module-cycle rule). Never throws; timeout default 10 min.

**Definition of Done:**
- [ ] Schema accepts `setup`, still rejects unknown keys; runner reports success/failure/timeout (tests with a temp script)

**Verify:** `bun test src/runtime/`

---

### Task 4: Enablement — env toggle + plan header

**Objective:** One function decides subagents vs Orca.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/spec/parser.ts` (header `Orchestration:` → `spec.metadata.orchestration`; parser is 399 lines — extract header parsing to `src/spec/parser-header.ts` first), `src/spec/types.ts`, `src/spec/status-mcp-tools.ts` (`spec_config` lists `SENTINAL_ORCHESTRATION`)
- Create: `src/spec/orchestration-mode.ts` (`resolveOrchestrationMode({ env, planHeader, detect })` → `{ mode: "orca"|"subagents", reason }`) + test
- Test: `src/spec/parser.test.ts`, `src/spec/mcp-tools.test.ts`

**Key Decisions / Notes:** D6. `detect` injected (Task 2's `detectOrca` wired in Task 10). Pre-Mortem 3: also require that `run-current`'s coordinator handle, when a Run is bound, equals `ORCA_TERMINAL_HANDLE` (checked in Task 10).

**Definition of Done:**
- [ ] Matrix test (env × header × detect); `spec_config` shows the toggle

**Verify:** `bun test src/spec/` (orchestrator runs the bundle guard after the wave — the plugin may import the parser transitively)

---

### Task 5: Ownership-safe abandon and cleanup

**Objective:** Sentinal never deletes an external worktree or branch.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `src/worktree/abandon.ts` (moved from `manager.ts:323-369`, plus the external *release* path) + test
- Modify: `src/worktree/manager.ts` (delegate), `src/worktree/cleanup.ts` (default pass: no `branch -D` for external; force guard 6), `src/opencode/workspace-adaptor.ts` if its `remove()` bypasses abandon (Pre-Mortem 1 — grep every `worktree remove|rmSync|branch -D`)
- Test: `src/worktree/cleanup.test.ts`, `src/worktree/manager.test.ts`, `src/worktree/mcp-tools.test.ts`, `src/sidecar/worktree-routes.test.ts`

**Key Decisions / Notes:** D2. Strip only files Sentinal seeded (record what was seeded, or verify `.env` equals the rendered template). Real git fixture: external worktree on branch `feature-x` outside `.sentinal/worktrees` AND one placed inside it with a `sentinal/spec-` branch (guard 6).

**Definition of Done:**
- [ ] Truth 1 for abandon + cleanup (both passes), mutation-checked
- [ ] Audit covers every destructive site (review list): `create.ts:154` (rollback — Task 8 keeps it off adopted dirs), `manager.ts:336-365` (abandon), `cleanup.ts:149-151` (default pass), `cleanup.ts:280-291` (force pass), `merge-guards.ts:231-255` (post-merge — Task 7). None in `workspace-adaptor.ts` or the plugin.

**Verify:** `bun test src/worktree/ src/sidecar/worktree-routes.test.ts src/opencode/`

---

### Task 6: Orca dispatch engine

**Objective:** Start, wait, detect stalls, stop and release — reliably.
**Dependencies:** Task 2
**Wave:** 2

**Files:**
- Create: `src/orca/dispatch.ts` (`ensureRun`, `createTask({title, spec, deps})`, `startTask({taskId, worktree, agent, name?, baseBranch?})` with one `--retry-of` + residual cleanup, `waitForSettlement({timeoutMs})`, `stopWorker`, `releaseWorker`), `src/orca/stall.ts` (verdict from `worker-list` + `worker-read` transcript: last assistant turn age, auth-error patterns such as `401`/`Please run /login`), tests
**Key Decisions / Notes:** D7. Never stop on `unverifiable`. Every mutation passes a `--retry-request` id so a lost response can be recovered.

**Definition of Done:**
- [ ] Fake-runner tests for: success, `failed` → retry → ready, retry failure surfaced with residuals closed, dependency refusal, timeout checkpoint, stall by auth error, stall by age, no stall on `unverifiable`

**Verify:** `bun test src/orca/`

---

### Task 7: Merge in the worktree holding the base; external merge

**Objective:** Child phases merge back into the branch they came from; external worktrees survive the merge.
**Dependencies:** Task 5
**Wave:** 3

**Files:**
- Create: `src/worktree/merge.ts` (moved from `manager.ts:213-320`)
- Modify: `src/worktree/manager.ts` (delegate), `src/worktree/merge-guards.ts` (`resolveMergeCheckout`: base holder if clean, else main checkout; external: skip `removeMergedWorktree`'s remove + `branch -D`, strip seeded files, mark `merged`)
- Test: `src/worktree/merge-guards.test.ts`, `src/worktree/manager.test.ts`

**Key Decisions / Notes:** D3. Keep H3 (restore the checkout's original branch) and "never mark merged while a Sentinal-owned dir survives". Result states which checkout received the commit.

**Definition of Done:**
- [ ] Truth 3; dirty holder → `BASE_CHECKED_OUT`; Sentinal-owned behaviour unchanged (existing tests)

**Verify:** `bun test src/worktree/`

---

### Task 8: `ensureWorktree` (create-or-adopt) + setup wiring

**Objective:** One entry point creates or adopts a worktree and gives it the full Sentinal treatment.
**Dependencies:** Tasks 1, 3
**Wave:** 3

**Files:**
- Create: `src/worktree/adopt.ts` (`ensureWorktree`, D4) + `src/worktree/adopt.test.ts`
- Modify: `src/worktree/create.ts` (optional injected `setup` step after seeding, outside the rollback), `src/worktree/reconcile.ts` only if a helper must be exported

**Key Decisions / Notes:** D4. No `manager.ts` edit (Task 7 owns it this wave) — callers use `ensureWorktree` directly. Real fixtures: Orca-style worktree via `git worktree add ../name -b name`.

**Definition of Done:**
- [ ] Truth 2; path outside the repo / main checkout / base branch refused; failure after insert leaves the directory intact (tests)

**Verify:** `bun test src/worktree/ src/runtime/`

---

### Task 9: `worktree_ensure` MCP tool + `sentinal worktree ensure` CLI

**Objective:** Agents and scripts can adopt worktrees.
**Dependencies:** Tasks 7, 8
**Wave:** 4

**Files:**
- Create: `src/worktree/adopt-mcp-tool.ts` (+ test), `src/cli/commands/worktree-adopt.ts` (+ test)
- Modify: `src/worktree/mcp-tools.ts` (register), `src/cli/commands/worktree.ts` (register line), `src/runtime/worktree-deps.test.ts` (`SITES`). (The MCP server entry file belongs to Task 10 this wave — thread runtime config through `registerWorktreeTools`' existing parameter instead.)

**Key Decisions / Notes:** Direct (no sidecar route), like `worktree_create`. Inputs: `plan_slug`, `project`, `path?`, `base?`, `owner` (default `sentinal`; `external` requires `path` + `base`). Output lists created/adopted/existing, slot, seeding and setup warnings.

**Definition of Done:**
- [ ] Tool + CLI tests; registration asserted via `registerWorktreeTools` in `src/worktree/mcp-tools.test.ts`

**Verify:** `bun test src/worktree/ src/cli/commands/ src/mcp/ src/runtime/worktree-deps.test.ts`

---

### Task 10: `orca_*` MCP tools

**Objective:** Skills drive Orca through a few robust tools instead of raw CLI prose.
**Dependencies:** Tasks 4, 6
**Wave:** 4

**Files:**
- Create: `src/orca/mcp-tools.ts` (+ test): `orca_status` (detection, auth, resolved mode + reason), `orca_dispatch` (ensure Run; create tasks with deps; `prepare-child` worktrees via `orca worktree create` without an agent; start ready ones with explicit agent + `path:` placement; returns task/dispatch/worktree ids), `orca_wait` (one bounded wait; settled payloads + stall verdicts + next action), `orca_stop` (positive evidence only), `orca_release`
- Modify: `src/mcp/server.ts` (register `registerOrcaTools`), `src/mcp/server.test.ts`

**Key Decisions / Notes:** Direct-only domain (Orca state is external; nothing warm in the sidecar). `orca_dispatch` checks Pre-Mortem 3 (bound Run's coordinator handle = `ORCA_TERMINAL_HANDLE`). Destructive wording on `orca_stop`.

**Definition of Done:**
- [ ] Fake-runner tool tests; tools registered; descriptions state direct-only and destructive where applicable

**Verify:** `bun test src/orca/ src/mcp/`

---

### Task 11: `spec-master-execute` Orca mode, both targets

**Objective:** Master plans run phases as Orca workers when enabled.
**Dependencies:** Tasks 9, 10
**Wave:** 5

**Files:**
- Modify: `targets/claude-code/commands/spec-master-execute.md`, `targets/opencode/skills/spec-master-execute/SKILL.md`, parity fixtures under `src/cli/__fixtures__/target-parity/`

**Key Decisions / Notes:** D8. Step 0: `orca_status` → mode. Orca path per wave: prepare each phase worktree (`orca_dispatch` with `worktree: prepare-child` runs `orca worktree create` without an agent, then `worktree_ensure(external)`), then start workers with `worktree: path:<dir>`, agent passed explicitly by the target (Claude Code → `claude`, OpenCode → `opencode`); deps = previous wave's tasks; loop `orca_wait`; on `worker_done` read the child plan file (VERIFIED only), `worktree_sync` (merges into the coordinator branch), `orca_release`, `orca worktree rm`; on stall → `orca_stop` + ask Retry/Skip/Stop. The worker spec text names the child plan path, "/spec <path>", and how to report. Subagent path unchanged. Only baseline-regenerating task in its wave.

**Definition of Done:**
- [ ] Truth 6; parity baselines regenerated once, `spec-verify.diff` 0 bytes

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

---

### Task 12: `spec-implement` opt-in Orca mode, both targets

**Objective:** Single-plan wave tasks can run as Orca workers in the shared directory.
**Dependencies:** Task 11
**Wave:** 6

**Files:**
- Modify: `targets/claude-code/commands/spec-implement.md`, `targets/opencode/skills/spec-implement/SKILL.md`, parity fixtures

**Key Decisions / Notes:** D9. Only when the resolved mode is `orca` AND the plan opts in (`Orchestration: orca`) — `auto` alone keeps subagents for single plans. Same task spec as today's sub-agent prompt, `worktree: current`, deps none within a wave; orchestrator-only builds and checkbox updates stay.

**Definition of Done:**
- [ ] Both targets identical in intent; baselines regenerated once

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

---

### Task 13: Docs, counts, CLI rows

**Objective:** Rules, catalogs and shipped CLI tables describe Orca mode, adoption and `setup`.
**Dependencies:** Tasks 1–12
**Wave:** 7

**Files:** `.sentinal/rules/sentinal-project.md` (ownership, adopt, merge location), `.sentinal/rules/sentinal-mcp-servers.md` (Worktree +1, new Orca domain, counts), `README.md` (tool catalog), `targets/{claude-code,opencode}/rules/cli-tools.md` (`sentinal worktree ensure`), parity fixtures.

**Definition of Done:** [ ] Counts match registrations; D1–D9 recorded; baselines regenerated once.
