# spec-verify Misses TSC Errors in Untouched Files (Incremental + LSP Cache)

Created: 2026-04-20
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** After implementing a feature/bugfix via `/spec`, the verification phase passes but a subsequent commit reveals TSC errors that LSP would catch in the IDE. Errors in files that weren't directly touched by the change slip through.

**Trigger:** Whenever the verification skill runs `quality_report` or `check_diagnostics` MCP tools (which it prefers over raw `tsc --noEmit`), two caching layers can hide errors:

1. **LSP path** (tried first): `src/sidecar/lsp-client.ts:196` opens only the first 10 `.ts` files (`findTsFiles(srcDir, 10)`) to trigger diagnostics. Project-wide type checking does NOT happen. Errors in files 11+ are silently omitted.
2. **Incremental tsc path** (fallback): `src/sidecar/quality-routes.ts:184-193` always passes `--incremental --tsBuildInfoFile <path>` with a persistent cache in `~/.sentinal/tsbuildinfo/`. Only invalidated when `package.json` or `tsconfig.json` change — not when source files change. Incremental tsc can miss cross-file errors in certain graph edge cases.

**Root Cause:** The spec-verify skills (`spec-verify` Step 3.2, `spec-bugfix-verify` Step 3.3) in both Claude Code (`targets/claude-code/commands/`) and OpenCode (`targets/opencode/skills/`) prefer `check_diagnostics` / `quality_report` over a full `tsc --noEmit`. These MCP tools, by design, use caching + LSP for speed during implementation. They are NOT appropriate for the final pre-commit gate during verification.

## Investigation

### Code path traced (LSP path preferred when available)

```
spec-bugfix-verify Step 3.3 / spec-verify Step 3.2
  → check_diagnostics MCP tool (src/analysis/mcp-tools.ts:82)
    → client.qualityCheck({ checks: ["tsc"] })
      → sidecar /quality-check route (quality-routes.ts:406)
        → runQualityChecks() (quality-routes.ts:366)
          IF lspClient exists:
            → runTscLsp() (quality-routes.ts:340) ← LIMITED TO 10 FILES
          ELSE (fallback):
            → runTsc() (quality-routes.ts:165) ← USES --incremental --tsBuildInfoFile
```

### Problem 1: LSP opens only 10 files

`src/sidecar/lsp-client.ts:194-214` — `getDiagnostics()` opens the tsconfig.json + at most 10 `.ts` files (`findTsFiles(srcDir, 10)`). The LSP server publishes diagnostics only for files it "knows about". In a project with hundreds of files, errors in files beyond those 10 are silent.

### Problem 2: Incremental tsc with persistent cache

`src/sidecar/quality-routes.ts:165-218` — `runTsc()` runs `tsc --noEmit --incremental --tsBuildInfoFile <hash>.tsbuildinfo`. The cache persists in `~/.sentinal/tsbuildinfo/` and is only invalidated when `package.json` or `tsconfig.json` mtimes change (line 128-161). Source file changes do NOT invalidate the cache — tsc itself decides what to re-check based on its file-signature graph. Known limitation: incremental tsc can miss errors in edge cases (e.g., a type narrowing change that affects a distant file).

### Problem 3: Skills explicitly prefer the MCP tools

- `targets/opencode/skills/spec-verify/SKILL.md:122`: "Use `check_diagnostics` MCP tool for spec-filtered diagnostics with delta tracking ... If MCP unavailable, run `npx tsc --noEmit` directly."
- `targets/opencode/skills/spec-bugfix-verify/SKILL.md:46`: "`check_diagnostics` MCP tool (or `npx tsc --noEmit` as fallback). Zero new errors."
- Both Claude Code command files (`targets/claude-code/commands/spec-verify.md:124`, `spec-bugfix-verify.md:48`) have the same guidance.

The agent follows the preferred path, gets a clean result from the cache, and commits. The cached tsc misses errors that a fresh full run would catch.

### Working example for comparison

Task 2 of the bugfix plan I just completed (`docs/plans/2026-04-20-worktree-create-false-error.md` Task 2) specifies `Verify: bun test && npx tsc --noEmit && npx eslint .` — explicitly a full non-incremental tsc. But the skill instructions override this with the MCP tool preference.

## Behavior Contract

### Fix Property (C => P)

**When** the verification skill completes Step 3.3 (bugfix) / Step 3.2 (feature):
**Property:** A full, non-incremental `tsc --noEmit` has run project-wide and passed with zero errors before the plan can transition to VERIFIED.

### Preservation Property (!C => unchanged)

**When** the verification skill runs other checks (tests, lint, build, E2E):
**Existing behavior preserved.** Only the tsc step changes; all other verification steps are unchanged.

## Fix Approach

**Strategy:** Do NOT modify `quality_report` / `check_diagnostics` — they serve the during-implementation fast-feedback use case correctly. Instead, update the verification skills to run a full `tsc --noEmit` (no cache, no LSP, no incremental) as an explicit pre-commit gate in addition to (not replacing) the fast MCP tools.

**Files (all dual-target):**

| File                                                  | Change                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `targets/claude-code/commands/spec-verify.md`         | Step 3.2: split tsc check into (a) `check_diagnostics` for delta + (b) mandatory `npx tsc --noEmit` full run                                     |
| `targets/opencode/skills/spec-verify/SKILL.md`        | Same change as above                                                                                                                             |
| `targets/claude-code/commands/spec-bugfix-verify.md`  | Step 3.3: replace "check_diagnostics (or `npx tsc --noEmit` as fallback)" with mandatory full tsc + optional check_diagnostics for delta context |
| `targets/opencode/skills/spec-bugfix-verify/SKILL.md` | Same change as above                                                                                                                             |

**Why not change the MCP tool?** `quality_report` / `check_diagnostics` are designed to be fast for the inner loop. Forcing them to non-incremental breaks that use case. The right abstraction is: fast during development, thorough at commit.

**Why not add a new MCP tool `full_tsc_check`?** YAGNI — `npx tsc --noEmit` / `bunx tsc --noEmit` is already the standard command, documented everywhere, and returns non-zero exit code on error. Adding a tool for this is unnecessary indirection.

**Defense-in-depth:** None needed — this is a workflow/instructions bug, not a data validation issue. The fix is to mandate the full tsc run in the skill instructions.

## Progress

- [x] Task 1: Fix (update verification skills in both targets)
- [x] Task 2: Verify (tests + ensure skills are consistent)
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Update the 4 verification skill files to mandate a full `npx tsc --noEmit` run as a pre-commit gate.

**Files:**

- `targets/claude-code/commands/spec-verify.md` — Step 3.2 item #2 (tsc check)
- `targets/opencode/skills/spec-verify/SKILL.md` — Step 3.2 item #2 (tsc check)
- `targets/claude-code/commands/spec-bugfix-verify.md` — Step 3.3 item #1 (tsc check)
- `targets/opencode/skills/spec-bugfix-verify/SKILL.md` — Step 3.3 item #1 (tsc check)

**Change pattern (apply to all four files):**

Replace:

```markdown
**TypeScript compiler** — `check_diagnostics` MCP tool (or `npx tsc --noEmit` as fallback). Zero [new ]errors.
```

With:

````markdown
**TypeScript compiler** — Run a **full project tsc** to catch errors in files not touched by this change. This is critical because `quality_report`/`check_diagnostics` use an incremental cache and LSP (limited to ~10 open files) which can miss cross-file type errors.

Required command:

```bash
npx tsc --noEmit
# or for bun projects:
bunx tsc --noEmit
```
````

Zero errors required. Optionally, run `check_diagnostics` MCP tool AFTER to see NEW/FIXED delta for the active spec's files.

```

**TDD approach (instructions files, no test framework):**
- Write a meta-test: a script that greps each of the 4 files for the mandated phrase "full project tsc" (or equivalent). The test passes only when all 4 files contain the updated instruction.
- Place test at `src/cli/commands/spec-verify-skills.test.ts`
- Verify it FAILS before the edits (files still say "fallback to npx tsc")
- Apply edits to all 4 files
- Verify it PASSES after

**Verify:** `bun test src/cli/commands/spec-verify-skills.test.ts`

### Task 2: Verify

**Objective:** Full suite + consistency check between targets.

**Verify:**
- `bun test` — nothing broken
- `npx tsc --noEmit` — clean (self-demonstrating the fix, since this is what we're mandating)
- Diff check: the 4 verification files should all reference the full tsc command consistently
```
