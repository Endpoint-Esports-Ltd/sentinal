# Model Routing Configuration Implementation Plan

Created: 2026-03-09
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Goal

Add a SQLite-backed settings system with model routing configuration and advisory hints in spec command templates, fulfilling Task 10 of the parent plan.

## Scope

### In Scope
- SQLite `settings` table via `migrateV3()` with generic key-value storage
- Settings CRUD methods on `MemoryStore` (`getSetting`, `setSetting`, `deleteSetting`, `listSettings`)
- Model routing defaults: Opus for planning, Sonnet for implementation/verification
- 5 routing fields: `planning`, `implementation`, `verification`, `plan_reviewer`, `spec_reviewer`
- `sentinal config list/get/set/reset` CLI subcommand
- Static model routing hints in spec command templates (both Claude Code and OpenCode)
- Barrel exports in `src/index.ts`
- Full test coverage

### Out of Scope
- Dashboard settings view (depends on Tasks 8-9)
- MCP tools for settings (not needed until dashboard exists)
- Dynamic model switching enforcement (Claude Code doesn't support it)
- Changes to `src/memory/config.ts` (bootstrap config, separate concern)

## Context for Implementer

**Architecture decision:** Settings CRUD lives directly on `MemoryStore` — consistent with `insertSession()`, `endSession()`, `getSession()`, and `SpecStore` patterns. No separate `SettingsManager` class.

**Two config systems, different purposes:**
- `~/.sentinal/config.json` (`src/memory/config.ts`) — Bootstrap config loaded before DB exists. Controls whether memory is enabled. File-based, cached in memory.
- `settings` SQLite table (`src/memory/store.ts`) — Runtime settings requiring DB. Model routing, future dashboard prefs. JSON values with application-layer validation.

**Model routing is advisory only.** Claude Code and OpenCode don't support forced model switching via plugins. The hints in command templates are static reminders baked into markdown. The SQLite store tracks user preferences for future dashboard display and potential API use.

**Existing patterns to follow:**
- `src/cli/commands/spec.ts` (100 lines) — Best template for new CLI commands
- `src/memory/store.ts:migrateV2()` — Migration pattern
- `src/spec/types.ts` — Zod schema pattern for new domain types

## Progress Tracking

- [x] Task 1: SQLite `settings` table + store CRUD
- [x] Task 2: Model routing types + defaults
- [x] Task 3: CLI `sentinal config` command
- [x] Task 4: Model routing hints in command templates
- [x] Task 5: Barrel exports + test suite verification

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: SQLite `settings` Table + Store CRUD

**Objective:** Add a generic key-value `settings` table via `migrateV3()` and CRUD methods on `MemoryStore`.

**Files:**
- Modify: `src/memory/types.ts` — Bump `SCHEMA_VERSION` from 2 to 3
- Modify: `src/memory/store.ts` — Add `migrateV3()`, `getSetting()`, `setSetting()`, `deleteSetting()`, `listSettings()`
- Modify: `src/memory/store.test.ts` — Add settings CRUD tests

**Definition of Done:**
- [x] `migrateV3()` creates `settings` table and bumps schema to 3
- [x] Existing v1/v2 databases migrate cleanly
- [x] `getSetting`/`setSetting`/`deleteSetting`/`listSettings` all work
- [x] Tests cover: set + get, overwrite, delete, list, get nonexistent

---

### Task 2: Model Routing Types + Defaults

**Objective:** Define the `ModelRouting` interface, Zod schema, defaults, and convenience accessors.

**Files:**
- Create: `src/config/types.ts` — `ModelRouting` interface, `ModelRoutingSchema`, `DEFAULT_MODEL_ROUTING`
- Create: `src/config/model-routing.ts` — `getModelRouting(store)`, `setModelRouting(store, routing)`, `resetModelRouting(store)`
- Create: `src/config/model-routing.test.ts` — Tests for get/set/reset/defaults/validation

**Definition of Done:**
- [x] `ModelRouting` interface and Zod schema defined
- [x] `DEFAULT_MODEL_ROUTING` matches: opus for planning, sonnet for rest
- [x] `getModelRouting()` returns defaults when no setting exists
- [x] `setModelRouting()` merges partial updates correctly
- [x] Invalid stored JSON handled gracefully (falls back to defaults)

---

### Task 3: CLI `sentinal config` Command

**Objective:** Add `sentinal config list/get/set/reset` CLI subcommand.

**Files:**
- Create: `src/cli/commands/config.ts` — `registerConfigCommand(program)`
- Modify: `src/cli/index.ts` — Import and register command

**Definition of Done:**
- [x] `sentinal config list` shows all settings
- [x] `sentinal config get <key>` and `sentinal config get <key.subkey>` work
- [x] `sentinal config set <key> <value>` and dot-path notation work
- [x] `sentinal config reset --yes` clears all settings
- [x] `--json` flag for machine-readable output

---

### Task 4: Model Routing Hints in Command Templates

**Objective:** Add static advisory model hints to all spec command templates for both targets.

**Files:**
- Modify: `targets/claude-code/commands/spec-plan.md`
- Modify: `targets/claude-code/commands/spec-implement.md`
- Modify: `targets/claude-code/commands/spec-verify.md`
- Modify: `targets/claude-code/commands/spec-bugfix-plan.md`
- Modify: `targets/claude-code/commands/spec-bugfix-verify.md`
- Modify: `targets/opencode/commands/spec-plan.md`
- Modify: `targets/opencode/commands/spec-implement.md`
- Modify: `targets/opencode/commands/spec-verify.md`
- Modify: `targets/opencode/commands/spec-bugfix-plan.md`
- Modify: `targets/opencode/commands/spec-bugfix-verify.md`

**Definition of Done:**
- [x] All 10 command template files contain appropriate model hint
- [x] Hints consistent between Claude Code and OpenCode
- [x] Hints don't break frontmatter parsing

---

### Task 5: Barrel Exports + Full Test Suite Verification

**Objective:** Export new types/functions from `src/index.ts` and verify all tests pass.

**Files:**
- Modify: `src/index.ts` — Add config exports

**Definition of Done:**
- [x] All new modules exported from barrel
- [x] `bun test` passes (all existing + new tests)
- [x] Test count increased (339 tests, up from 321 baseline)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `migrateV3` breaks existing databases | Low | High | Existing backup logic handles this; migration is additive |
| Model routing values become stale | Medium | Low | Values are freeform strings; user updates via CLI |

## Goal Verification

```bash
bun test
sentinal config list
sentinal config get model_routing --json
sentinal config set model_routing.planning opus
grep -c "Model:" targets/*/commands/spec-*.md
```
