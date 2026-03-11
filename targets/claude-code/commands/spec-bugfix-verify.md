---
description: "Bugfix verification phase - tests, quality checks, fix confirmation"
argument-hint: "<path/to/plan.md>"
user-invocable: false
model: sonnet
---

# /spec-bugfix-verify - Bugfix Verification Phase

**Phase 3 (bugfix).** Lightweight verification: run tests, quality checks, confirm fix works.

**Input:** Bugfix plan with `Status: COMPLETE`
**Output:** Plan → VERIFIED (success) or loop back to implementation (failure)

**Why no sub-agents:** The regression test proves the fix works. The full test suite proves nothing else broke. Sub-agents would re-verify what tests already prove.

---

## Critical Constraints

- **NO review sub-agents** — tests prove correctness for bugfixes
- **NO stopping** — everything automatic. Never ask "Should I fix these?"
- **Fix ALL issues automatically** — no permission needed
- **Plan file is source of truth** — re-read after auto-compaction

---

## Step 3.1: Run Full Test Suite

Run all tests. Fix any failures immediately. Re-run until green.

- `bun test` / `npx jest` / `npx vitest run`

## Step 3.2: Verify the Fix

1. **Read the plan's regression test** (from Task 1)
2. **Run it specifically:** `npx jest <test-path> --verbose` or `bun test <test-path>`
3. Must PASS — if not, fix is incomplete → fix immediately
4. **Scope check:** Read changed files, confirm changes match plan scope. Flag unplanned changes.
5. **Behavior Contract audit:**
   - **Fix Property (C => P):** Is there a test that proves condition C produces property P?
   - **Preservation Property (!C => unchanged):** Is there a test that proves negation of C leaves behavior unchanged?

## Step 3.3: Quality Checks

1. **TypeScript compiler** — `npx tsc --noEmit`. Zero new errors.
2. **Linter** — `npx eslint .`. Errors are blockers, fix immediately.
3. **Angular build (if applicable):** `npx ng build`
4. **NestJS build (if applicable):** `npx nest build`

## Step 3.4: Plan Verify Commands

Run each task's `Verify:` commands. Defer server-dependent commands (containing `curl`, `localhost`, `http://`) to Step 3.5.

## Step 3.5: Runtime Verification (only if deferred commands exist)

If no server-dependent commands were deferred: skip to Final.

Otherwise: start service → run deferred commands → stop service → fix failures.

## Step 3.6: Process Compliance Check

Verify:
- Root cause was traced (not just symptom patched) — see Investigation section in plan
- Fix is at the source, not where the error appeared
- Minimal code change (no scope creep)
- Regression test exercises actual entry point, not internal helpers
- Tests match the Behavior Contract exactly

---

## Final

### Step 3.7: Worktree Sync (if worktree active)

1. Detect: `sentinal worktree detect --json <plan_slug>`
2. If no worktree: skip to Step 3.9.
3. Pre-sync: verify clean working tree on base branch:
   ```bash
   git -C <project_root> status --porcelain
   ```
4. Save plan to project root: `cp <worktree_plan> <project_root>/docs/plans/`
5. Show diff: `sentinal worktree diff --json <plan_slug>`
6. Notify + AskUserQuestion: "Yes, squash merge" | "No, keep worktree" | "Discard all changes"
7. Handle:
   - **Squash:** `sentinal worktree sync --json <plan_slug>` then `sentinal worktree cleanup --force --json <plan_slug>` + `cd` in SAME bash call
   - **Keep:** Report path
   - **Discard:** `sentinal worktree cleanup --force` + `cd` in SAME bash call

   ⛔ NEVER separate cleanup and cd into different Bash calls.

### Step 3.8: Post-Merge Verification (after squash merge only)

Full test suite + TypeScript + linter. If any fails: fix on base branch, re-run.

### Step 3.9: Update Plan Status

**All passes:** Set `Status: VERIFIED`, register:
```bash
sentinal register-plan "<plan_path>" "VERIFIED" 2>/dev/null || true
```
Report:
```
Bugfix verified — regression test passes, full suite green, Behavior Contract satisfied.
```

**Fails:** Add fix tasks, set `Status: PENDING`, increment `Iterations`:
```bash
sentinal register-plan "<plan_path>" "PENDING" 2>/dev/null || true
```
Invoke `Skill(skill='spec-implement', args='<plan-path>')`.

ARGUMENTS: $ARGUMENTS
