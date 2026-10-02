# Master-Plan Verification Evidence and Merge-Step Prose Implementation Plan

Created: 2026-10-02
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Fix the two findings from the live master-plan run (memory #1941), as approved by the
user on 2026-10-02:

1. After a successful `worktree_sync`, the Orca Mode prose no longer tells the coordinator to call
   `worktree_abandon`; the sync already released the worktree. That call is kept for skipped or
   stopped phases only.
2. A child plan marked VERIFIED without its `.spec-review.json` (the worker skipped `/spec`'s
   code review) is caught:
   - the worker brief (Orca Mode and subagent mode, both targets) says verification must not be
     skipped and to commit the review file;
   - in Orca Mode the coordinator checks for the file before merging and treats a missing one as
     a failed phase;
   - `spec_master_audit` reports a non-blocking `no-review-evidence` **warning** for each
     VERIFIED child with no `<slug>.spec-review.json` next to it.

   The check and the warning are skipped when `SENTINAL_SPEC_REVIEWER_ENABLED=false`, because the
   review legitimately doesn't run then. A warning, not a must_fix, because older children were
   verified before review files existed.

## Progress Tracking

- [x] Task 1: `spec_master_audit` `warnings` (`no-review-evidence`) (Wave 1)
- [x] Task 2: Prose in both targets + parity + embed (Wave 1)
- [x] Task 3: Dev docs (Wave 2)

**Total Tasks:** 3 | **Completed:** 3 | **Remaining:** 0

## Implementation Tasks

### Task 1: Audit warnings

**Files:** `src/spec/master-audit.ts`, `src/spec/master-audit-mcp-tools.ts`, and their tests.

- `MasterAuditResult.warnings: { kind: "no-review-evidence"; slug; message }[]`. `ok` is
  unaffected.
- The tool renders a `### warnings (N)` section.

**Definition of Done:**

- [ ] A VERIFIED child without the review file gives a warning while `ok` stays true; with the
      file, no warning; with `SENTINAL_SPEC_REVIEWER_ENABLED=false`, no warning; a non-VERIFIED
      child never gets one.

### Task 2: Prose

**Files:** both `spec-master-execute` targets (Orca step 5, the Orca brief, the subagent prompt).

**Definition of Done:**

- [ ] Parity hunk counts are unchanged and `bun test src/cli/` passes.

### Task 3: Dev docs

**Files:** `.sentinal/rules/sentinal-mcp-servers.md` (the `spec_master_audit` note).
