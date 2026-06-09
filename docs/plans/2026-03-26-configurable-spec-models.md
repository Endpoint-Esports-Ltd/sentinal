# Configurable Spec Phase Models

Created: 2026-03-26
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Wire the existing model routing config (`sentinal config set model_routing.planning opus`) to actually control the `model:` frontmatter in installed Claude Code skill files, both at install/update time and immediately on config change. For OpenCode, expose model routing through the existing MCP/sidecar infrastructure.
**Architecture:** Create a shared `applyModelRouting(pluginDir, routing)` function that patches `model:` frontmatter in installed command/agent .md files. Call it (1) at end of install/update, and (2) from `sentinal config set` when model_routing changes. Also add env var overrides (`SENTINAL_MODEL_PLANNING`, etc.) that take precedence.
**Tech Stack:** TypeScript, Bun, `node:fs`, frontmatter parsing

## Scope

### In Scope

- Wire model routing config to Claude Code plugin skill files (commands/_.md, agents/_.md)
- Apply model routing at install/update time
- Apply model routing immediately on `sentinal config set model_routing.*`
- Env var overrides: `SENTINAL_MODEL_PLANNING`, `SENTINAL_MODEL_IMPLEMENTATION`, `SENTINAL_MODEL_VERIFICATION`, `SENTINAL_MODEL_PLAN_REVIEWER`, `SENTINAL_MODEL_SPEC_REVIEWER`
- OpenCode: expose model routing via spec_config MCP tool (already has dashboard API)

### Out of Scope

- UI for model selection in the dashboard (API verified: `GET /api/settings` returns `modelRouting`, `POST /api/settings` accepts `{ modelRouting: {...} }` — see `src/dashboard/routes/api.ts:133-159`)
- OpenCode dynamic runtime model switching (blocked — `chat.model` plugin hook PR [#18826](https://github.com/anomalyco/opencode/pull/18826) was closed; track for future when it lands)
- OpenCode `opencode.json` agent model patching (static config requires restart — low value until `chat.model` hook exists)
- Validating that the configured model name is a real model

## Context for Implementer

- **Patterns to follow:** `configureStatusline()` in `install.ts:369-400` — reads settings, applies config, writes files
- **Conventions:** Model routing uses `src/config/model-routing.ts` for get/set/reset, `src/config/types.ts` for schema
- **Key files:**
  - `src/config/model-routing.ts` — `getModelRouting()`, `setModelRouting()`, `resetModelRouting()`
  - `src/config/types.ts` — `ModelRouting` type, `DEFAULT_MODEL_ROUTING`, `ModelRoutingSchema`
  - `src/cli/commands/config.ts` — CLI config commands (get/set/reset)
  - `src/cli/commands/install.ts:411-455` — `writeClaudeCodeEmbeddedAssets()` writes command/agent files
  - `targets/claude-code/commands/*.md` — source skill files with `model:` frontmatter
  - `targets/claude-code/agents/*.md` — source agent files with `model:` frontmatter
  - `~/.claude/plugins/sentinal-marketplace/plugins/sentinal/` — installed plugin dir
- **Gotchas:**
  - Plugin files exist in multiple locations: marketplace dir, cache dir, and direct plugin dir — all need patching
  - Embedded asset mode (binary) writes from constants, not file system — patching must happen after write
  - Frontmatter format is YAML-like: `model: opus` on its own line between `---` fences

**Skill → Routing Key mapping:**

| Skill File                                | Routing Key      | Notes                                     |
| ----------------------------------------- | ---------------- | ----------------------------------------- |
| `spec-plan.md`, `spec-bugfix-plan.md`     | `planning`       | Already have `model:` frontmatter         |
| `spec-master-plan.md`                     | `planning`       | **Missing `model:` — Task 1 must add it** |
| `spec-implement.md`                       | `implementation` | Already have `model:` frontmatter         |
| `spec-master-execute.md`                  | `implementation` | **Missing `model:` — Task 1 must add it** |
| `spec-verify.md`, `spec-bugfix-verify.md` | `verification`   | Already have `model:` frontmatter         |
| `agents/plan-reviewer.md`                 | `plan_reviewer`  | Already have `model:` frontmatter         |
| `agents/spec-reviewer.md`                 | `spec_reviewer`  | Already have `model:` frontmatter         |
| `agents/research.md`                      | `spec_reviewer`  | Uses same routing key as spec_reviewer    |

## Assumptions

- Frontmatter `model:` line can be reliably replaced with a regex like `/^model:\s*\S+/m` — supported by reading skill files with existing model lines — Tasks 1-3 depend on this
- `spec-master-plan.md` and `spec-master-execute.md` currently lack `model:` frontmatter — Task 1 must add it to source files AND handle insertion in `applyModelRouting` — confirmed by reading the files
- The installed plugin directory structure is stable at `~/.claude/plugins/sentinal-marketplace/plugins/sentinal/` — supported by `install-constants.ts:11-16` — Task 2 depends on this
- Env var override names follow the pattern `SENTINAL_MODEL_<PHASE>` — design decision — Task 1 depends on this

## Testing Strategy

- Unit tests for `applyModelRouting()` with temp directories containing mock .md files
- Unit tests for `resolveModelRouting()` (env var override + config merge)
- Integration: `sentinal config set model_routing.planning haiku` then verify frontmatter changed

## Risks and Mitigations

| Risk                                               | Likelihood | Impact | Mitigation                                                 |
| -------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------- |
| Plugin dir doesn't exist when config set is called | Medium     | Low    | Check existence, warn if not installed                     |
| Frontmatter parsing breaks on unusual formatting   | Low        | Medium | Use simple regex, fall back to original content on failure |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Frontmatter regex doesn't match** (Task 1) → Trigger: `applyModelRouting` silently leaves files unchanged because the regex pattern doesn't match the actual frontmatter format in some files
2. **Config set doesn't find installed files** (Task 2) → Trigger: plugin directory path differs between dev and binary install modes, so files aren't found after config change

## Execution Waves

**Wave 1** — Core function (sequential): Task 1 creates the shared function, Task 2 wires it to install, Task 3 wires it to config set. Each depends on the prior.

## Goal Verification

### Truths

1. `applyModelRouting` with `{ planning: "haiku" }` changes `model: opus` to `model: haiku` in spec-plan.md
2. `sentinal config set model_routing.planning haiku` rewrites installed plugin files
3. `sentinal install claude` applies model routing config after writing plugin files
4. `SENTINAL_MODEL_PLANNING=haiku` env var overrides the stored config value
5. Files not in the routing map (e.g., `spec.md`, `quick.md`) are left unchanged

### Artifacts

| Artifact                         | Provides                  | Exports                                        |
| -------------------------------- | ------------------------- | ---------------------------------------------- |
| src/config/model-routing.ts      | Routing + apply + resolve | `applyModelRouting()`, `resolveModelRouting()` |
| src/config/model-routing.test.ts | Tests                     | N/A                                            |
| src/cli/commands/config.ts       | Config set hook           | Modified `set` action                          |
| src/cli/commands/install.ts      | Install-time apply        | Modified install flow                          |

### Key Links

| From                 | To                  | Via                                      | Pattern           |
| -------------------- | ------------------- | ---------------------------------------- | ----------------- |
| config.ts set action | applyModelRouting   | call after setModelRouting               | applyModelRouting |
| install.ts           | applyModelRouting   | call after writeClaudeCodeEmbeddedAssets | applyModelRouting |
| applyModelRouting    | plugin commands dir | file write                               | model:\s          |

## Progress Tracking

- [x] Task 1: Create `applyModelRouting()` + `resolveModelRouting()` with env var overrides (Wave 1)
- [x] Task 2: Wire to install/update — apply after writing plugin files (Wave 1)
- [x] Task 3: Wire to config set — apply immediately on model_routing changes (Wave 1)
- [x] Task 4: Verify — full test suite + quality checks (Wave 1)
      **Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Implementation Tasks

### Task 1: Create `applyModelRouting()` + `resolveModelRouting()`

**Objective:** Add functions to patch model frontmatter in installed plugin files and resolve config with env var overrides.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/config/model-routing.ts`
- Modify: `src/config/model-routing.test.ts`
- Modify: `targets/claude-code/commands/spec-master-plan.md` — add `model: opus` to frontmatter
- Modify: `targets/claude-code/commands/spec-master-execute.md` — add `model: sonnet` to frontmatter

**Key Decisions / Notes:**

- `resolveModelRouting(store: MemoryStore): ModelRouting` — reads config, then overlays env vars (`SENTINAL_MODEL_PLANNING`, `SENTINAL_MODEL_IMPLEMENTATION`, `SENTINAL_MODEL_VERIFICATION`, `SENTINAL_MODEL_PLAN_REVIEWER`, `SENTINAL_MODEL_SPEC_REVIEWER`). Env vars take precedence over stored config.
- `applyModelRouting(pluginDirs: string[], routing: ModelRouting): { patched: string[]; skipped: string[] }` — for each dir, find commands/_.md and agents/_.md, match filename to routing key using the mapping table, replace `model: <old>` line with `model: <new>` using regex `/^model:\s*\S+$/m`. Returns list of patched and skipped files.
- The filename-to-routing-key mapping is a const object: `{ "spec-plan.md": "planning", "spec-bugfix-plan.md": "planning", ... }`
- Only patch files that exist AND have a `model:` line — skip others silently
- For files missing `model:` that are in the routing map (spec-master-plan.md, spec-master-execute.md): `applyModelRouting` should **add** `model: <value>` after the first `---` line in the frontmatter, not just replace
- `findInstalledPluginDirs(): string[]` — scans `~/.claude/plugins/` recursively for dirs containing `commands/spec-plan.md`, returns all matching parent dirs. Exported for use by both install.ts and config.ts.

**Definition of Done:**

- [ ] `applyModelRouting` patches existing `model:` frontmatter in .md files
- [ ] `applyModelRouting` adds `model:` to files in the routing map that lack it
- [ ] `resolveModelRouting` merges env vars over stored config
- [ ] Files not in the mapping are left unchanged
- [ ] `findInstalledPluginDirs` returns existing plugin dirs dynamically
- [ ] All tests pass (including test for the full config-set → file-patch path)

**Verify:**

- `bun test src/config/model-routing.test.ts`

### Task 2: Wire to install/update

**Objective:** After writing plugin files during install, apply model routing config.
**Dependencies:** Task 1
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/install.ts`

**Key Decisions / Notes:**

- After `writeClaudeCodeEmbeddedAssets(pluginDir)` (line 307) and after `copyDirRecursive(claudeTarget, pluginDir, ...)` (line 311), call `applyModelRouting([pluginDir], routing)` where `routing = resolveModelRouting(store)`
- Open a MemoryStore at the call site to read config: `const store = new MemoryStore(); const routing = resolveModelRouting(store); store.close();` — straightforward, no restructuring needed
- `findInstalledPluginDirs()` dynamically discovers all sentinal plugin dirs by scanning `~/.claude/plugins/` for dirs containing `commands/spec-plan.md` — avoids hardcoding version numbers
- Log a message if non-default routing was applied: `info("Applied model routing: planning=haiku, ...")`

**Definition of Done:**

- [ ] Install applies model routing config to plugin files
- [ ] Non-default routing is logged during install

**Verify:**

- Manual: `sentinal config set model_routing.planning haiku && sentinal install claude` → check frontmatter

### Task 3: Wire to config set

**Objective:** When `sentinal config set model_routing.*` is called, immediately patch installed plugin files.
**Dependencies:** Task 1
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/config.ts`

**Key Decisions / Notes:**

- In the `set` action, after `setModelRouting(store, partial)` (line 124), call `applyModelRouting(dirs, getModelRouting(store))` where `dirs` includes all known installed plugin locations
- Use helper `findInstalledPluginDirs(): string[]` that checks all known paths and returns existing ones
- Also add `applyModelRouting` call after `resetModelRouting` in the reset action (to restore defaults)
- Log: `ok("Model routing applied to installed plugins")`

**Definition of Done:**

- [ ] `sentinal config set model_routing.planning haiku` immediately patches installed files
- [ ] `sentinal config reset --yes` restores default model frontmatter

**Verify:**

- Manual: `sentinal config set model_routing.planning haiku` → `grep model: ~/.claude/plugins/sentinal-marketplace/plugins/sentinal/commands/spec-plan.md`

### Task 4: Verify — full test suite + quality checks

**Objective:** Run full test suite + TypeScript checks
**Dependencies:** Tasks 1-3
**Wave:** 1

**Definition of Done:**

- [ ] All tests pass
- [ ] No TypeScript errors

**Verify:**

- `bun test && npx tsc --noEmit`
