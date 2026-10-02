# Orca Polish: Question Attention, Removal Retry, Worktree Limit, Docs Implementation Plan

Created: 2026-10-02
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Four follow-ups from the #13 work, approved by the user on 2026-10-02:

1. `orca_wait` no longer repeats a worker's open question as an `orca-attention` `input` entry.
2. The docs say to recover a stuck worker by closing its tab in the Orca UI, not with
   `orca terminal close`. The active-worktree cap (5) becomes configurable.
3. `orca_remove_worktree` retries once when Orca refuses with a stale "Failed to delete worktree".
4. The `sentinal-orca-cli` skill header is updated to Orca 1.4.218.

## Scope

### In Scope

- **Open questions (item 1):**
  - `OrcaToolState.openQuestions: Map<dispatchId, Set<messageId>>`.
  - `orca_wait` adds every `question` message, using the dispatch id from its payload.
  - `orca_reply` removes the message id it answered; it now receives the tool state.
  - `orca_wait` hides an `orca-attention` entry whose categories are exactly `["input"]` while
    that dispatch has an open question.
  - Any other `input` entry still shows. A probe could not rule out Orca using `input` for a
    worker blocked at a local prompt.
- **Removal retry (item 3):**
  - On an error whose message contains `Failed to delete worktree`, `orca_remove_worktree`
    waits 1.5 s and calls `worktree rm` once more, still without `--force`.
  - The output says it retried.
  - The delay is injectable (`deps.retryDelayMs`) so tests run instantly.
- **Worktree limit (item 2):**
  - `runtimeWorktreeConfig()` reads `SENTINAL_WORKTREE_MAX_ACTIVE` (a positive integer;
    anything invalid keeps the base value).
  - It is used by the MCP server and the CLI worktree commands.
  - The default stays 5. More slots mean more per-slot ports and database names for projects
    with a `runtime.json` contract.
- **Docs:**
  - The Orca Mode prose in both targets gets the UI-tab-close note and the env var.
  - Dev rules: the same notes plus the open-question rule.
  - The skill header and a facts row for the stale removal refusal.

### Out of Scope

- Changing the default cap.
- Hiding `input` entries in general.

## Context for Implementer

- `src/orca/mcp-tools-wait.ts` (276 lines): `attentionRow`, the attention filter, `other`
  messages.
- `src/orca/mcp-tools-coord.ts` (202 lines): `orca_reply`; `registerOrcaCoordTools(server, deps)`
  is called from `src/orca/mcp-tools.ts`.
- `src/orca/mcp-tools-shared.ts`: `OrcaToolState`, `createOrcaToolState`, `OrcaToolsDeps`.
- `src/orca/mcp-tools-settle.ts:259` `registerRemoveWorktree`.
- `src/runtime/worktree-deps.ts:56` `runtimeWorktreeConfig(base)`;
  `src/worktree/types.ts:96` `maxActive` default 5.
- The question payload carries `dispatchId` (seen live: `payload.dispatchId`).
- TDD: set `RED_CONFIRMED` before each implementation write. Regenerate the parity baselines
  once, then run `embed-assets`.

## Execution Waves

**Wave 1:** Task 1 (question attention), Task 2 (removal retry) and Task 3 (worktree limit).
They touch different files, except `mcp-tools-shared.ts`, which only Task 1 edits; Task 2 puts
`retryDelayMs` on the deps type, which is in the same file, so Tasks 1 and 2 run in sequence.
**Wave 2:** Task 4 (prose, docs and parity).

## Goal Verification

### Truths

1. An `orca_wait` test: a `question` for dispatch D plus an `orca-attention` `["input"]` row for D
   → no attention entry for D. After `orca_reply`, a later `input` row for D is shown. An
   `input` row for another dispatch with no question is shown.
2. An `orca_remove_worktree` test: the first `worktree rm` fails with "Failed to delete worktree"
   and the second succeeds → `ok`, with exactly two calls and no `--force`. Two failures → the
   error is returned, with two calls.
3. A `runtimeWorktreeConfig` test: `SENTINAL_WORKTREE_MAX_ACTIVE=8` gives `maxActive` 8;
   `abc`, `0` and unset give 5.
4. The phrase "not with `orca terminal close`" appears in both `spec-master-execute` files, and
   `SENTINAL_WORKTREE_MAX_ACTIVE` appears in the docs.

## Progress Tracking

- [x] Task 1: Open-question attention filter (Wave 1)
- [x] Task 2: Removal retry (Wave 1)
- [x] Task 3: Configurable worktree limit (Wave 1)
- [x] Task 4: Prose, docs, skill header, parity (Wave 2)

**Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Verification

- **Gates:** typecheck, typecheck:plugin, lint, format:check and the embed guard all pass;
  `bun test` gives 4572 pass, 0 fail. Parity hunk counts are unchanged.
- **Live (Orca 1.4.218):** `worktree rm` refused while an untracked file existed. After the file
  was deleted, `orca_remove_worktree` removed the worktree on its first try. The stale second
  refusal seen on 2026-10-02 did not recur on demand, so the retry is covered by unit tests only.
- The `input` attention filter is unit-tested on the shape observed live during the 1.43.0 smoke
  test (a `question` plus `orca-attention ["input"]` for the same dispatch).

## Implementation Tasks

### Task 1: Open-question attention filter

**Files:** `src/orca/mcp-tools-shared.ts`, `mcp-tools-wait.ts`, `mcp-tools-coord.ts`,
`mcp-tools.ts`, and tests (`mcp-tools-wait.test.ts`, `mcp-tools-coord.test.ts`).

**Definition of Done:**

- [ ] Truth 1 holds; `bun test src/orca/` passes.

### Task 2: Removal retry

**Files:** `src/orca/mcp-tools-settle.ts`, `mcp-tools-shared.ts` (`retryDelayMs` on the deps),
and `mcp-tools-settle.test.ts`.

**Definition of Done:**

- [ ] Truth 2 holds.

### Task 3: Configurable worktree limit

**Files:** `src/runtime/worktree-deps.ts` and its test.

**Definition of Done:**

- [ ] Truth 3 holds.

### Task 4: Prose, docs, skill header

**Files:** both `spec-master-execute` and both `spec-implement` target files,
`.sentinal/rules/sentinal-mcp-servers.md`, `.sentinal/skills/sentinal-orca-cli/SKILL.md`,
`README.md` (if it lists env vars), then the parity baselines and `embed-assets`.

**Definition of Done:**

- [ ] Truth 4 holds; hunk counts are unchanged; `bun test src/cli/` passes.
