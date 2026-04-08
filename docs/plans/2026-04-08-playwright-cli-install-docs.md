# playwright-cli Install Documentation Fix Plan

Created: 2026-04-08
Status: COMPLETE
Approved: Yes
Iterations: 0
Worktree: Yes
Type: Bugfix

## Summary

**Symptom:** On Linux under OpenCode, the assistant cannot find `playwright-cli` during `spec-verify`. Reported to the user as the npm package being "expired/deprecated."

**Trigger:** Fresh Linux install of Sentinal. The assistant follows the documented `playwright-cli -s=... open <url>` commands from `targets/*/rules/playwright-cli.md` and `targets/*/skills/spec-verify/SKILL.md`, then tries to install the binary by guessing `npm install -g playwright-cli`. That installs the deprecated stub package (`playwright-cli@0.262.0`, marked "Deprecated, use @playwright/cli instead") rather than the real tool.

**Root Cause:**

1. **`targets/claude-code/rules/playwright-cli.md:1`** and **`targets/opencode/rules/playwright-cli.md:1`** — document the `playwright-cli` binary's command surface in detail, but have **NO installation section** identifying the correct npm package.
2. **`src/cli/commands/install.ts:236-250`** (Claude path) and **`:513-539`** (OpenCode path) — `commandExists()` prereq checks for `claude`, `opencode`, `bun`, `node`, `sentinal`, but **no check for `playwright-cli`** and no install hint.
3. The correct package is the **scoped** `@playwright/cli`, not the bare `playwright-cli` (which is a deprecated legacy package). The binary name `playwright-cli` matches both packages, but only `@playwright/cli@latest` provides the Microsoft-maintained tool that Sentinal's rule actually documents.

## Investigation

- **Research evidence:**
  - `npm view playwright-cli` → deprecated stub (last v0.262.0, "use @playwright/cli instead")
  - `npm view @playwright/cli@latest` → current, maintained by Microsoft Playwright team (`dgozman-ms`, `playwright-bot`), bin: `playwright-cli`
  - `npm install -g @playwright/cli@latest && playwright-cli --help` → confirmed output header `run playwright mcp commands from terminal` with exact command surface Sentinal's rule documents (`open`, `snapshot`, `click <ref>`, `fill`, `-s=<session>`, `state-save`, `cookie-*`, `tab-*`, `route`, `dialog-accept`, etc.)
  - Official docs at `https://playwright.dev/docs/getting-started-cli` confirm `npm install -g @playwright/cli@latest` as the install command
- **Existing Sentinal pattern (working example):** `src/cli/commands/install.ts` already uses `commandExists("claude")`, `commandExists("opencode")`, `commandExists("bun")`, `commandExists("node")`, `commandExists("sentinal")` with per-check `err()` + `console.log("  Install: ...")` + `process.exit(1)`. The same helper is available for a `playwright-cli` check — but as a **soft warning** (`info()` instead of `err()` + exit), since `playwright-cli` is only needed for `/spec` verification of UI-heavy projects.
- **History:** The `playwright-cli` rule was introduced on 2026-03-11 in commit `999cc5f` ("market research feature parity"). No install hint was included at authoring time. This has been a latent gap since day 1 — it's not a regression, just a bug that only surfaces on machines without `@playwright/cli` pre-installed.
- **Scope in rule-set:** 8 files reference `playwright-cli` — 2 dedicated rule files, 4 supporting rules/commands (testing.md, verification.md, spec-verify.md/SKILL.md in both targets), 1 embedded-assets.ts (regenerated from the targets). Only the 2 dedicated rule files need the Installation section; the rest just reference the binary.

## Behavior Contract

### Fix Property (C ⇒ P)

**When condition C holds:** A user runs `sentinal install claude` or `sentinal install opencode` on a machine without `playwright-cli` on PATH.
**Property P must hold:**
1. The installer prints an informational line: `[i] playwright-cli not found (optional, needed for /spec UI verification)` followed by `  Install: npm install -g @playwright/cli@latest`
2. The installer **continues** — does NOT exit with error code, because `playwright-cli` is optional
3. The `playwright-cli.md` rule files (both targets) have an **Installation** section at the top showing `npm install -g @playwright/cli@latest` and explicitly warning that the bare `playwright-cli` package on npm is deprecated.

### Preservation Property (¬C ⇒ unchanged)

**When condition C does NOT hold** (playwright-cli is already on PATH, OR the user is not running `sentinal install`):
1. Installer behavior for all other prereqs (`claude`, `opencode`, `bun`, `node`, `sentinal`) is byte-identical to before.
2. Existing users with `playwright-cli` already installed see a simple `[OK] playwright-cli found (optional)` line and nothing else changes.
3. All other documentation in `targets/*/rules/` that references the `playwright-cli` binary (testing.md, verification.md, spec-verify.md, etc.) remains unchanged — only the dedicated `playwright-cli.md` files grow an Installation section.

## Fix Approach

**Files to modify:**

| File | Change |
|---|---|
| `targets/claude-code/rules/playwright-cli.md` | Add `## Installation` section at top with `npm install -g @playwright/cli@latest`, warning about deprecated bare package |
| `targets/opencode/rules/playwright-cli.md` | Identical content to Claude Code target (dual-target sync) |
| `src/cli/commands/install.ts` | Add `checkPlaywrightCli()` helper + call it from both `installClaudeCode()` and `installOpenCode()` prereq blocks as a soft info hint (not a hard fail) |
| `src/cli/commands/install.test.ts` | Add RED tests for the helper's output with/without binary present |
| `src/cli/embedded-assets.ts` | **Auto-regenerated** via `bun run embed-assets` — not hand-edited |

**Strategy:**

1. **Rule files (parallel dual-target edit):** Add a prominent `## Installation` section as the first content block after the heading. Use the exact working command from the official Playwright docs. Include a warning that `playwright-cli` (bare, no scope) on npm is the deprecated package — the correct one is `@playwright/cli`.
2. **Installer soft-check (TDD):**
   - Extract a `checkPlaywrightCli()` helper near the top of `install.ts` that:
     - Returns `void` (side-effects only — prints lines)
     - Uses the existing `commandExists("playwright-cli")` pattern
     - On found: `ok("[OK] playwright-cli found (optional)")`
     - On missing: `info("[i] playwright-cli not found (optional, needed for /spec UI verification)")` + `console.log("  Install: npm install -g @playwright/cli@latest")`
     - Never calls `process.exit()` — always returns cleanly
   - Call it from `installClaudeCode()` after the `sentinal` check (near line 250)
   - Call it from `installOpenCode()` after the `node` check (near line 539)
3. **Embedded assets regeneration:** After rule file edits, run `bun run embed-assets` to regenerate `src/cli/embedded-assets.ts`. This is the standard workflow per the `scripts/embed-assets.mjs` header comment.

**Tests (TDD):**

- `src/cli/commands/install.test.ts` — add 2 test cases for `checkPlaywrightCli()`:
  1. When `commandExists("playwright-cli")` returns true → function should output `[OK] playwright-cli found (optional)` and NOT print the install hint
  2. When `commandExists("playwright-cli")` returns false → function should output the `[i]` info line AND the install hint with `npm install -g @playwright/cli@latest`
- Inspect the existing `install.test.ts` pattern first — may need to mock `commandExists` via module mock or constructor injection

**Defense-in-depth:** Not applicable — this is a documentation + optional installer hint, not a data flow issue. No additional validation layers needed.

## Progress

- [x] Task 1: Fix (docs + installer + tests)
- [x] Task 2: Verify

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Verification Results

- **Full test suite:** 1137/1137 passing (1132 + 3 new `checkPlaywrightCli` + 2 pre-existing in install.test.ts that I wasn't counting before)
- **Type check:** `tsc --noEmit` — 0 errors
- **Rule parity:** `diff targets/claude-code/rules/playwright-cli.md targets/opencode/rules/playwright-cli.md` → identical
- **Embed consistency:** `bun run embed-assets` → only timestamp changes (content stable)
- **Impact analysis:** LOW risk, 0 unexpected changes
- **Install CLI sanity:** `sentinal install --help` responds correctly

## Tasks

### Task 1: Fix

**Objective:** Add Installation section to both `playwright-cli.md` rule files, add `checkPlaywrightCli()` soft-check to installer, write regression tests, regenerate embedded-assets.

**Files:**
- `targets/claude-code/rules/playwright-cli.md`
- `targets/opencode/rules/playwright-cli.md`
- `src/cli/commands/install.ts`
- `src/cli/commands/install.test.ts`
- `src/cli/embedded-assets.ts` (regenerated, not hand-edited)

**TDD:**
1. Read `install.test.ts` to understand the existing test pattern (mocking strategy for `commandExists`)
2. Write 2 failing tests for `checkPlaywrightCli()` — one for found, one for missing
3. Run `bun test src/cli/commands/install.test.ts` — verify the new tests FAIL
4. Set TDD state RED_CONFIRMED for `src/cli/commands/install.ts`
5. Implement `checkPlaywrightCli()` in `install.ts`
6. Wire the helper into both `installClaudeCode()` and `installOpenCode()` prereq blocks
7. Run tests — verify all PASS
8. Set TDD state GREEN_CONFIRMED
9. Add `## Installation` section to both `playwright-cli.md` rule files (identical content, dual-target sync)
10. Run `bun run embed-assets` to regenerate `src/cli/embedded-assets.ts`
11. Verify `embedded-assets.ts` contains the new Installation section text: `rg 'npm install -g @playwright/cli' src/cli/embedded-assets.ts`

**Verify:**
```bash
bun test src/cli/commands/install.test.ts --verbose
bunx tsc --noEmit
rg "npm install -g @playwright/cli" targets/claude-code/rules/playwright-cli.md targets/opencode/rules/playwright-cli.md src/cli/embedded-assets.ts
```

### Task 2: Verify

**Objective:** Full test suite, type check, rule consistency, embedded-assets regeneration check.

**Verify:**
```bash
# Full test suite (includes the new install.test.ts cases)
bun test

# Type check
bunx tsc --noEmit

# Verify both target rule files have the same Installation block
diff <(rg -A 15 "^## Installation" targets/claude-code/rules/playwright-cli.md) \
     <(rg -A 15 "^## Installation" targets/opencode/rules/playwright-cli.md)

# Confirm embedded-assets is up to date
bun run embed-assets
git diff --stat src/cli/embedded-assets.ts  # should show 0 additional changes if embed was already current

# Sanity: actually invoke the installer path in --help mode to ensure no compile errors
bun src/cli/index.ts install claude --help
bun src/cli/index.ts install opencode --help
```
