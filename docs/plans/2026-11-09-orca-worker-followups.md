# Orca Worker Follow-ups (scratch dirs, unreported stops, merged Location) Fix Plan

Created: 2026-11-09
Status: IN_PROGRESS
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

Three follow-ups found while running `docs/plans/2026-11-05-cross-project-scope.md` through Orca.

1. **Symptom:** pre-warmed OpenCode workers stop at "Access external directory /tmp" (Phase 2 and
   Phase 3 both stalled until the user clicked Allow). **Root cause:**
   `src/orca/worker-access.ts` `opencodeLaunch` only allows the coordinator and main checkouts
   (read-only); temp dirs are never allowed, and OpenCode reports the literal path (`/tmp/*`),
   not its realpath (`/private/tmp`).
2. **Symptom:** a worker ended its turn waiting for a background test run's exit notice that had
   already been missed; Orca escalated "Worker stopped without reporting", and the coordinator
   had no Sentinal tool to nudge it (I used a raw `orca orchestration send`). Likewise "Worker is
   waiting on a prompt" escalations got no guidance in `orca_wait`'s Next line. **Root cause:**
   `orca_reply` (`src/orca/mcp-tools-coord.ts`) only answers a question by `message_id`;
   `orca_wait` (`src/orca/mcp-tools-wait.ts`) has Next hints for questions and stalls but not for
   escalations; the worker brief in `spec-master-execute` / `spec-implement` says nothing about
   long-running commands.
3. **Symptom (Phase 3 deferred issue):** after a foreign phase merges into a base branch that is
   checked out in a **linked worktree**, the seed's relative `Location: docs/plans/<file>` is
   resolved against `Repo:` (the main checkout), where the file is absent →
   `foreign-location-missing`. **Root cause:** `src/spec/master-audit-foreign.ts`
   `resolveForeignChild` only tries `resolve(repo, location)`.

## Behavior Contract

**Fix:** (1) Pre-warmed OpenCode workers may read **and write** `/tmp` and `os.tmpdir()` (literal
and realpath forms) without a prompt; `SENTINAL_ORCA_WORKER_SCRATCH_DIRS` adds dirs, `none`
removes them; `orca_start` reports `worker_access.scratch`. (2) `orca_reply` accepts
`dispatch_id` (instead of `message_id`) to send guidance to a worker (`orchestration send --to
dispatch:<id>`); `orca_wait` adds Next hints for `needs-input` (tell the user which worker tab)
and `finished` (inspect, then nudge with `orca_reply({run_id, dispatch_id, body})`); the briefs
tell workers to run long commands in the foreground and never end a turn waiting on an exit
notice. (3) When a relative `Location:` is missing under `Repo:`, the audit looks in the repo's
linked worktrees (the one with `Base:` checked out first, else any containing the file).

**Preservation:** checkout dirs stay read-only (edit denies unchanged); `ALLOW_DIRS=none` still
disables the inline config entirely; `orca_reply` with `message_id` is unchanged; `orca_wait`
output for non-escalation messages is unchanged; an existing `Location:` file is used as before
with no git spawn.

## Fix Approach

**Files:** `src/orca/worker-access.ts`, `src/orca/mcp-tools-start.ts`, `src/orca/mcp-tools-coord.ts`,
`src/orca/mcp-tools-wait.ts`, `src/spec/master-audit-foreign.ts` (+ tests);
`targets/{opencode/skills,claude-code/commands}/spec-{master-execute,implement}` (identical
edits; parity baselines unchanged); `.sentinal/rules/sentinal-mcp-servers.md`, README (Orca repo removal note); Phase 3 plan's Deferred Issues.

## Progress

- [x] Task 1: Fix (tests first, all three)
- [x] Task 2: Verify

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Verify:** `bun test src/orca/ src/spec/`

### Task 2: Verify

**Verify:** `bun test && bun run typecheck && bun run typecheck:plugin && bun run lint && bun run format:check`

## Verification Notes

- `bun test` 4826 pass / 0 fail; typecheck, plugin typecheck, lint, format:check clean. Parity
  baselines regenerated: only hunk offsets moved in `spec-implement.diff` and
  `spec-master-execute.diff` (identical prose added to both targets).
- Live: `opencode debug config` (OpenCode 1.19.5) with the generated `OPENCODE_CONFIG_CONTENT`
  resolves `external_directory` `/tmp/**` and `/private/tmp/**` to `allow`.
- Not verified live: an actual pre-warmed worker writing to `/tmp` without a prompt (next Orca run).
