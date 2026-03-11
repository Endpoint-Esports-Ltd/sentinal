# Uninstall Preserve Binary & Update Reinstall Plan

Created: 2026-03-11
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary
**Goal:** Make `sentinal uninstall` preserve the binary/npm-package/shell-integration by default (only remove plugin data), add a `--remove-binary` flag for full removal, and wire `sentinal update` to auto-detect installed assistants, uninstall old plugin data, download the new binary, and reinstall to the same assistants.

**Architecture:** The uninstall functions (`uninstallClaudeCode`, `uninstallOpenCode`) gain an `options` parameter with a `preserveBinary` flag. The update command gains a post-download phase that detects installed targets, calls the programmatic uninstall (with `preserveBinary: true`), then calls install for the same targets. Detection reuses the same artifact-checking logic the uninstall dispatcher already uses.

**Tech Stack:** TypeScript, Commander.js, Bun

## Scope
### In Scope
- Add `--remove-binary` flag to `sentinal uninstall` (defaults to off — binary/npm/shell preserved)
- Refactor uninstall functions to accept `preserveBinary` option
- Extract assistant detection into a shared helper
- Wire `sentinal update` to call uninstall→install after binary swap
- Update tests for the update command
- Add uninstall tests for the new flag behavior

### Out of Scope
- `--local` flag support in update (OpenCode local installs)
- Automatic rollback if install fails after uninstall
- Interactive prompts during update (fully automatic)

## Context for Implementer
> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Commander option registration: `update.ts:304-329` — `.option("--flag", "desc")` then typed `opts` param
  - Uninstall dispatcher: `uninstall.ts:93-186` — auto-detect logic with `existsSync` checks
  - Install dispatcher: `install.ts:104-195` — target routing with `installClaudeCode()` / `installOpenCode()`
  
- **Conventions:**
  - Shell output helpers: `info()`, `ok()`, `err()`, `note()` from `utils/shell.js`
  - All commands registered via `registerXxxCommand(program)` pattern
  - Test files co-located: `update.test.ts` next to `update.ts`

- **Key files:**
  - `src/cli/commands/uninstall.ts` (538 lines) — main uninstall logic, has `removeBinary()`, `removeShellIntegration()`, npm package removal
  - `src/cli/commands/update.ts` (350 lines) — binary download logic, `downloadAndInstall()`
  - `src/cli/commands/install.ts` (783 lines) — install logic, `installClaudeCode()`, `installOpenCode()`
  - `src/cli/commands/update.test.ts` (97 lines) — existing update tests
  - `src/utils/shell.ts` — shared utilities (`resolveXdgConfig`, `commandExists`, etc.)

- **Gotchas:**
  - `removeBinary()` and `removeShellIntegration()` are only called for **global** OpenCode uninstall (not Claude Code uninstall, not `--local`) — see `uninstall.ts:470-473`
  - The npm package removal (`bun remove -g @endpoint/sentinal`) at line 345-351 runs for ALL non-local OpenCode uninstalls — it is NOT gated behind `!local`, only behind `commandExists("bun")`
  - Claude Code uninstall doesn't touch the binary at all — it only removes the marketplace/plugin via `claude` CLI commands
  - **CRITICAL:** `uninstallClaudeCode()` calls `process.exit(1)` at line 197 if the Claude CLI is not found. This will kill the update process. Must handle gracefully when called programmatically.
  - `install.ts` is 783 lines — over the 600 line limit but we're not modifying its structure
  - The update command currently doesn't import from install.ts or uninstall.ts at all
  - **IMPORTANT:** `uninstallDispatcher()` has interactive `promptMenu()` at line 160. The update command must call `uninstallClaudeCode()`/`uninstallOpenCode()` directly — NEVER the dispatcher.
  - AGENTS.md is removed during uninstall (lines 354-367) and recreated during install. User customizations would be lost on every update. The `preserveBinary` guard should also skip AGENTS.md removal.

- **Domain context:**
  - "Binary mode" = running from compiled Bun binary (`process.argv[1].startsWith("/$bunfs/")`)
  - Update always runs from the compiled binary (users don't run `sentinal update` from source)
  - After binary swap, the NEW binary's install logic runs — this is correct because the old version's uninstall already cleaned up

## Assumptions
- The update command always runs from a compiled binary (not dev mode) — supported by: only compiled binaries are distributed via GitHub Releases — Tasks 3, 4 depend on this
- `installClaudeCode()` and `installOpenCode()` can be called programmatically (they already are from their dispatchers) — supported by: `install.ts:116-130` — Task 4 depends on this
- The uninstall functions' console output is acceptable during update (informational) — supported by: user wants to see progress — Task 4 depends on this
- Both install and uninstall can safely be called if the assistant is not installed (idempotent) — supported by: install handles "already installed" (Claude: checks plugin list first, removes old; OpenCode: writes files idempotently) and uninstall handles "not found" gracefully — Task 3, 4 depend on this. Verify during Task 2 that install functions don't error on partially-existing state.

## Testing Strategy
- Unit tests for detection helper (mock filesystem with existsSync)
- Unit tests for uninstall `preserveBinary` flag behavior (verify removeBinary/removeShellIntegration/npm-removal are skipped)
- Integration-style tests for update reinstall flow (mock the actual install/uninstall calls)

## Risks and Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| New binary's install logic is incompatible with old version's artifacts | Low | High | Uninstall cleans everything first; install is idempotent |
| Claude Code CLI not available during headless update | Medium | Low | `uninstallClaudeCode()` refactored to throw instead of `process.exit(1)` — caught by update's try/catch |
| Update fails mid-way (uninstalled but not reinstalled) | Low | Medium | Binary is already updated; user can manually `sentinal install` |

## Pre-Mortem
*Assume this plan failed. Most likely internal reasons:*
1. **The uninstall functions have side effects that break when called from update context** (Task 1, 3) → Trigger: `uninstallClaudeCode()` calls `process.exit(1)` at line 197 when Claude CLI is missing. **Fix:** Task 1 refactors to throw instead of exit. Task 3 wraps each target in try/catch.
2. **Detection returns false negatives after uninstall completes** (Task 3) → Trigger: detection runs AFTER uninstall removes artifacts, finding nothing to reinstall. **Fix:** Task 3 detects BEFORE uninstalling.
3. **Install fails on partial state after incomplete uninstall** (Task 3) → Trigger: Install functions assume clean slate but artifacts partially exist. **Fix:** Task 2 verifies idempotency; Task 3 wraps in try/catch.

## Goal Verification
### Truths
1. `sentinal uninstall` without flags removes all plugin data but preserves the binary, shell integration, and npm package
2. `sentinal uninstall --remove-binary` removes everything including binary, shell, npm package (old behavior)
3. `sentinal update` downloads new binary, detects installed assistants, runs uninstall+install for those assistants
4. After `sentinal update`, the same assistants that were installed before are installed with new version assets
5. `sentinal uninstall` still works standalone for users who want to remove Sentinal

### Artifacts
- Modified: `src/cli/commands/uninstall.ts`, `src/cli/commands/update.ts`
- New test: `src/cli/commands/uninstall.test.ts`
- Modified test: `src/cli/commands/update.test.ts`

### Key Links
1. `update.ts:downloadAndInstall()` → detection helper → `uninstall.ts:uninstallClaudeCode/OpenCode()` → `install.ts:installClaudeCode/OpenCode()`
2. `uninstall.ts:removeBinary/removeShellIntegration` → guarded by `preserveBinary` option
3. Detection helper → `existsSync` checks for marketplace dir + plugin files/agents/skills

## Progress Tracking
- [x] Task 1: Add `--remove-binary` flag and `preserveBinary` option to uninstall
- [x] Task 2: Extract detection helper and export uninstall/install functions
- [x] Task 3: Wire update command to call uninstall→install after binary swap
- [x] Task 4: Add tests
**Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add `--remove-binary` flag and `preserveBinary` option to uninstall

**Objective:** Make `sentinal uninstall` preserve binary/npm/shell by default, with `--remove-binary` to opt into full removal.

**Dependencies:** None

**Files:**
- Modify: `src/cli/commands/uninstall.ts`

**Key Decisions / Notes:**
- Add `.option("--remove-binary", "Also remove the sentinal binary, npm package, and shell integration")` to the command registration at line 78
- Add exported `UninstallOptions` interface: `{ local?: boolean; preserveBinary?: boolean }`
- Change `uninstallOpenCode(local: boolean)` → `uninstallOpenCode(opts: UninstallOptions = {})` with `opts.local` and `opts.preserveBinary`
- Default: `preserveBinary = !opts.removeBinary` (i.e., preserve by default when called from CLI)
- Claude Code uninstall doesn't touch the binary, BUT it calls `process.exit(1)` at line 197 when `claude` CLI is not found. Refactor to throw an Error instead — the action handler at line 84-86 already catches errors and exits.
- Guard npm removal at lines 345-351: wrap in `if (!opts.preserveBinary)` 
- Guard shell + binary removal at lines 470-473: wrap in `if (!opts.preserveBinary)`
- Guard AGENTS.md removal at lines 354-367: wrap in `if (!opts.preserveBinary)` — preserves user customizations during update

**Definition of Done:**
- [ ] `sentinal uninstall` preserves binary, shell integration, npm package
- [ ] `sentinal uninstall --remove-binary` removes everything (old behavior)
- [ ] No TypeScript errors

**Verify:**
- `npx tsc --noEmit`

### Task 2: Extract detection helper and export uninstall/install functions

**Objective:** Create a shared `detectInstalledTargets()` function and ensure uninstall/install functions are importable from the update command.

**Dependencies:** Task 1

**Files:**
- Modify: `src/cli/commands/uninstall.ts`
- Modify: `src/cli/commands/install.ts`

**Key Decisions / Notes:**
- Export `detectInstalledTargets()` from `uninstall.ts` — returns `{ claude: boolean; opencode: boolean }`. Reuse the existing detection logic at lines 128-136.
- Export `uninstallClaudeCode()` and `uninstallOpenCode()` from `uninstall.ts` (currently private functions)
- Export `installClaudeCode()` and `installOpenCode()` from `install.ts` (currently private functions)
- The detection function must accept an optional XDG config path for testability
- Keep the internal functions' signatures stable — just add `export` keyword
- **Verify:** `installClaudeCode()` and `installOpenCode()` handle already-installed state gracefully (Claude removes old plugin before re-adding; OpenCode overwrites files). If they error on partial state, add guards.

**Definition of Done:**
- [ ] `detectInstalledTargets()` exported and reusable
- [ ] Uninstall functions exported
- [ ] Install functions exported
- [ ] No TypeScript errors

**Verify:**
- `npx tsc --noEmit`

### Task 3: Wire update command to call uninstall→install after binary swap

**Objective:** After downloading the new binary, detect installed targets, uninstall old plugin data, and reinstall for the same targets.

**Dependencies:** Task 1, Task 2

**Files:**
- Modify: `src/cli/commands/update.ts`

**Key Decisions / Notes:**
- After `downloadAndInstall()` succeeds (line 285-286), add a `reinstallPlugins()` function:
  1. Call `detectInstalledTargets()` — runs BEFORE uninstall (Pre-Mortem #2)
  2. If neither detected, skip reinstall (user may have only used the binary directly)
  3. For each detected target: call uninstall (with `preserveBinary: true`), then call install
  4. For Claude: `uninstallClaudeCode()` → `installClaudeCode()`
  5. For OpenCode: `uninstallOpenCode({ preserveBinary: true })` → `installOpenCode(false, true)` (global, bundled mode since we're binary)
- **IMPORTANT:** Call `uninstallClaudeCode()` and `uninstallOpenCode()` directly — do NOT call `uninstallDispatcher()` which has interactive `promptMenu()` at line 160 that would block headless update.
- Wrap each target's uninstall+install in its own try/catch — one target failing should not prevent the other from being reinstalled. Binary update has already succeeded.
- Print clear progress: "Reinstalling plugins for: Claude Code, OpenCode"
- Import from uninstall.ts and install.ts

**Definition of Done:**
- [ ] `sentinal update` detects and reinstalls to same assistants
- [ ] Binary update succeeds even if reinstall fails
- [ ] No TypeScript errors

**Verify:**
- `npx tsc --noEmit`

### Task 4: Add tests

**Objective:** Test the new uninstall flag behavior, detection helper, and update reinstall flow.

**Dependencies:** Task 1, Task 2, Task 3

**Files:**
- Create: `src/cli/commands/uninstall.test.ts`
- Modify: `src/cli/commands/update.test.ts`

**Key Decisions / Notes:**
- `uninstall.test.ts`: Test `detectInstalledTargets()` with mocked filesystem paths
- `update.test.ts`: Test reinstall logic (may need to mock the uninstall/install imports)
- Focus on unit-testable pieces: detection helper, flag threading
- Don't test actual file deletion (that requires real filesystem + claude CLI)

**Definition of Done:**
- [ ] Detection helper tests pass
- [ ] Update reinstall tests pass
- [ ] All existing tests still pass
- [ ] No TypeScript errors

**Verify:**
- `bun test src/cli/commands/uninstall.test.ts src/cli/commands/update.test.ts`
- `bun test`
- `npx tsc --noEmit`
