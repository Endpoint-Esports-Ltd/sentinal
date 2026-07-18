# Config-Driven Model Routing + Scope Guard Implementation Plan

Created: 2026-06-10
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Let users route each spec-workflow phase (planning, implementation, plan-review, spec-review, verification, tough-bugs) to a model of their choice from Sentinal config — injected at runtime on OpenCode via the plugin `config` hook, applied at install/config-set time on Claude Code (already exists) — plus a `scope-guard` hook that hard-blocks edits to files outside the active task's plan, keeping weaker models on-task.

**Architecture:** Single source of truth stays the existing `model_routing` SQLite setting (CLI `sentinal config`, dashboard, `SENTINAL_MODEL_*` env overrides). New: (1) `tough_bugs` phase + two shipped subagents (`implementer`, `tough-debugger`) whose models come from routing; (2) OpenCode plugin gains a `config` hook that fetches resolved routing (sidecar → env fallback) and mutates `config.agent[*].model` / `config.command.spec.model` at startup; (3) plan parser extracts per-task `**Files:**` lists into `SpecTask.files`, and a new sync `scope-guard` PreToolUse hook (Claude Code) / `tool.execute.before` branch (OpenCode) denies Write/Edit to undeclared files while a spec task is in progress.

**Tech Stack:** TypeScript/Bun, Zod, bun:sqlite (store), OpenCode plugin API (`config` hook), Claude Code hooks.json.

## Scope

### In Scope

- `tough_bugs` routing phase: schema, defaults, env var, CLI/dashboard, FILE_ROUTING_MAP
- New shipped subagents both targets: `implementer` (implementation model), `tough-debugger` (tough_bugs model)
- OpenCode runtime injection: plugin `config` hook → agent/command model mutation
- Parser: per-task `**Files:**` extraction → `SpecTask.files` (schema + store round-trip)
- `scope-guard` shared hook: deny off-plan edits (both targets), env kill-switch, plan-edit resync
- spec-implement content updates both targets: dispatch waves to `implementer`, escalate to `tough-debugger` after 3 failed fix attempts, advisory model hint for main-session phases
- Dashboard Settings: `tough_bugs` field
- Docs: README model routing section, `.sentinal/rules` updates if needed

### Out of Scope

- Live mid-session model switching (platform limitation — neither OpenCode nor Claude Code allows it from plugins/hooks)
- Claude Code routing mechanics (already shipped: `applyModelRouting` at install + `config set`)
- Per-platform model ID translation (user supplies valid IDs; see validity rule in Context)
- Scope-guard for Bash-driven file writes (`echo >`, `sed -i`) — PreToolUse sees only Write/Edit/MultiEdit; documented residual

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **What already exists (do NOT rebuild):**
  - `src/config/types.ts` — `ModelRoutingSchema` (5 phases), `DEFAULT_MODEL_ROUTING`, `MODEL_ROUTING_KEY`
  - `src/config/model-routing.ts` — `getModelRouting`/`setModelRouting`/`resetModelRouting`, `resolveModelRouting` (env overrides via `ENV_VAR_MAP`), `applyModelRouting` (Claude Code frontmatter patcher), `findInstalledPluginDirs`
  - `src/cli/commands/config.ts:131-134` — `config set model_routing.*` re-patches installed Claude Code plugin dirs
  - `src/cli/commands/install.ts:396-403` — install applies routing
  - `src/sidecar/config-routes.ts:43` — sidecar `/config` GET returns `resolveModelRouting(store)` (schema-driven; new field flows automatically)
  - `src/dashboard/views/settings.ts:44-45` — `modelField(...)` rows per phase
- **Patterns to follow:**
  - Hook structure: `src/hooks/tdd-guard.ts` — fast read-only path, slow path only when blocking; NEVER parse plan markdown per edit (use SQLite/sidecar state)
  - Hook dispatcher: `src/cli/commands/hook.ts:435-454` `SHARED_HOOKS` map — lazy `await import(...)`, `readStdin()`, `denyExit(reason)` on block. ⚠️ Hooks have TWO paths: legacy `main()` (dead) and the live CLI dispatcher — wire the dispatcher
  - hooks.json: third `"matcher": "Write|Edit|MultiEdit"` entry in PreToolUse array (`targets/claude-code/hooks/hooks.json:39-72`), `timeout: 5`, sync (sync hooks CAN deny)
  - OpenCode block: `targets/opencode/plugins/sentinal.ts:503-516` — `tool.execute.before` extracts `filePath` from `args.file_path ?? args.filePath ?? args.path`, lowercase tool names `["write","edit","multiedit","patch"]`, `throw new Error(msg)` to block, **return null/skip when sidecar down (fail-open, line 325-327 pattern)**
  - Plugin hook interface is hand-rolled at `targets/opencode/plugins/sentinal.ts:94-123` — add `config?: (input: Config) => Promise<void>` member (verified to exist in upstream `@opencode-ai/plugin` types: `anomalyco/opencode packages/plugin/src/index.ts:225`)
- **Key facts from exploration:**
  - `src/spec/parser.ts` does NOT extract `**Files:**` (only Status/Test Strategy/DoD, lines 252-272); `SpecTaskSchema` (`src/spec/types.ts:56-65`) has no `files` field
  - Sidecar `GET /spec/current` (`src/sidecar/routes.ts:84-86`) returns the full Spec including `tasks[]` — `files` flows through once schema/store updated; `SpecStore.getCurrentTask` exists (`src/spec/store.ts:338`)
  - Spec state syncs to SQLite via `syncFromPlanFile` at pre-compact, `spec_register`, `/spec/sync` route — scope-guard must trigger resync when the plan file itself is edited (else stale file lists)
  - OpenCode plugin already connects to sidecar with `SidecarClient.connectWithRetry(10, 200)` (line 427)
- **Model ID validity rule (design decision):** OpenCode requires `provider/model-id` format. The plugin `config` hook injects a routing value ONLY if it contains `/`; bare aliases (`sonnet`, `opus`) are skipped for OpenCode (they remain valid for Claude Code frontmatter). Log skipped values to plugin debug log.
- **Gotchas:**
  - `src/cli/embedded-assets.ts` is generated — never hand-edit; run `bun run embed-assets` after changing `targets/**/*.md`
  - `targets/opencode/plugins/sentinal.ts` is file-length-exempt but logic used by both targets belongs in `src/`
  - TDD guard active on this repo: failing test first for every `src/**/*.ts` impl change; use `tdd_set_state RED_CONFIRMED`
  - Plugin `config` hook fires at startup, possibly before the plugin's main sidecar connection — use a short independent `SidecarClient.connect()` attempt + env-var fallback; never throw
  - Claude Code plugin agents ignore `hooks`/`mcpServers`/`permissionMode` frontmatter — `implementer`/`tough-debugger` use only `description`/`tools`/`model`

## Runtime Environment

- Sidecar: auto-started; socket `~/.sentinal/sidecar.sock`; `GET /config` for routing, `GET /spec/current` for spec state
- Tests: `bun test` (1495 baseline, all green)

## Assumptions

- OpenCode merges plugin-mutated `config.agent[name]` over markdown-defined agents of the same name — supported by config load order (config before agent dirs) but **verify at implementation** (Pre-Mortem #1) — Task 5 depends on this
- `/spec/current` task ordering matches plan order and in_progress detection works via task `status` — supported by `SpecStore.getCurrentTask` — Task 4 depends on this
- Claude Code hooks fire for subagent tool calls too (scope-guard covers `implementer` waves) — supported by Claude Code hook docs — Task 4
- Plans without `**Files:**` sections produce empty `files` → scope-guard self-disables (graceful) — Tasks 2, 4

## Testing Strategy

- Unit: schema defaults/env overrides; parser Files extraction round-trip; scope-guard decision matrix (no spec / no task / no files / listed / unlisted / plan-file edit / env off); plugin config-hook injection with fake sidecar + env
- Integration: sidecar `/spec/current` carries `files`; hook dispatcher path (`echo '{...}' | sentinal hook shared scope-guard`)
- Live smoke (`.opencode/skills/sentinal-live-smoke`): deny actually blocks via CLI dispatcher; plugin loads after deploy

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| OpenCode config-hook agent merge doesn't override md agents | Medium | High (OC routing dead) | Verify early in Task 5; fallback: plugin rewrites agent md frontmatter on deploy (same pattern as Claude Code) |
| Scope-guard false positives block legit work | Medium | High (user frustration) | Env kill-switch `SENTINAL_SCOPE_GUARD_ENABLED=false`; enforce only when current task declares files; always allow plan file, test files of listed files, `.sentinal/` |
| Stale task file lists after plan edits | High | Medium | mtime-checked synchronous resync inside the deny path (rule 7) — add-to-plan→retry succeeds in one cycle |
| Weak models loop on deny | Medium | Medium | Deny message is instructive ("add to **Files:** in Task N of <plan> or ask user"); 2-deny repeat detection escalates message to suggest stopping |
| Parallel waves: multiple in_progress tasks | Medium | Medium | Enforce against UNION of files across all in_progress tasks |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **OpenCode ignores plugin config mutations for md-defined agents** (Task 5) → Trigger: injected model not shown for plan-reviewer in `/agents` after restart → switch to frontmatter-rewrite-on-deploy fallback documented in Risks
2. **Scope-guard kills normal (non-spec) coding** (Task 4) → Trigger: deny fires with no active spec in manual testing → gate is wrong; enforcement requires active spec AND in_progress task AND non-empty union of files
3. **`**Files:**` extraction breaks existing plan parsing** (Task 2) → Trigger: parser tests regress or spec sync drops tasks → extraction must be additive-only; `files` optional with `[]` default

## Execution Waves

**Wave 1** — Foundations (parallel, no file overlap): Task 1 (routing schema, `src/config/`), Task 2 (parser files extraction, `src/spec/`), Task 3 (agent md files, `targets/*/agents/`)
**Wave 2** — Hook + UI (parallel): Task 4 (scope-guard: `src/hooks/`, `src/cli/commands/hook.ts`, `targets/claude-code/hooks/hooks.json`), Task 6 (dashboard + README)
**Wave 3** — Plugin + content (parallel): Task 5 (OpenCode plugin only), Task 7 (skills/commands md + embed regen)
**Wave 4** — Task 8 (verification)

## Goal Verification

### Truths

1. `rg "tough_bugs" src/config/types.ts src/dashboard/views/settings.ts | wc -l` ≥ 2
2. `sentinal config get model_routing --json` output contains `"tough_bugs"`
3. `rg "\"config\"|config\?:" targets/opencode/plugins/sentinal.ts` shows the config hook implemented
4. `echo '{"session_id":"t","transcript_path":"/dev/null","cwd":"/tmp","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/tmp/x.ts"}}' | sentinal hook shared scope-guard; echo $?` → exits 0 (no active spec = no block)
5. `rg "scope-guard" targets/claude-code/hooks/hooks.json src/cli/commands/hook.ts | wc -l` ≥ 2
6. `ls targets/claude-code/agents/ targets/opencode/agents/ | grep -c "implementer\|tough-debugger"` → 4
7. `rg "files" src/spec/types.ts | grep -c "files"` ≥ 1 AND parser test for `**Files:**` extraction passes
8. `bun test` exits 0; `bunx tsc --noEmit` clean
9. `rg "implementer|tough-debugger" targets/opencode/skills/spec-implement/SKILL.md targets/claude-code/commands/spec-implement.md | wc -l` ≥ 4

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| src/hooks/scope-guard.ts | off-plan edit denial | `processScopeGuard` |
| targets/claude-code/agents/implementer.md + tough-debugger.md | routed subagents (CC) | — |
| targets/opencode/agents/implementer.md + tough-debugger.md | routed subagents (OC) | — |
| src/spec/parser.ts (files extraction) | per-task file lists | `SpecTask.files` |
| plugin `config` hook in targets/opencode/plugins/sentinal.ts | OC runtime routing injection | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| src/cli/commands/hook.ts | src/hooks/scope-guard.js | lazy import dispatch | `scope-guard` |
| targets/opencode/plugins/sentinal.ts | sidecar /config | routing fetch | `/config` |
| src/hooks/scope-guard.ts | sidecar /spec/current | task files lookup | `spec/current` |
| spec-implement (both targets) | implementer agent | Task dispatch | `subagent_type="implementer"` |

## Progress Tracking

- [ ] Task 1: Routing schema — tough_bugs phase (Wave 1)
- [ ] Task 2: Parser — per-task Files extraction (Wave 1)
- [ ] Task 3: implementer + tough-debugger agents, both targets (Wave 1)
- [ ] Task 4: scope-guard hook — core, dispatcher, hooks.json (Wave 2)
- [ ] Task 5: OpenCode plugin — config hook injection + scope-guard branch (Wave 3)
- [ ] Task 6: Dashboard tough_bugs field + README docs (Wave 2)
- [ ] Task 7: spec-implement content updates + embed regen (Wave 3)
- [ ] Task 8: Final verification (Wave 4)
      **Total Tasks:** 8 | **Completed:** 0 | **Remaining:** 8

## Implementation Tasks

### Task 1: Routing schema — tough_bugs phase

**Objective:** Add `tough_bugs` to ModelRoutingSchema (default `"sonnet"`), `SENTINAL_MODEL_TOUGH_BUGS` env override, and FILE_ROUTING_MAP entries `implementer.md → implementation`, `tough-debugger.md → tough_bugs`.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/config/types.ts`, `src/config/model-routing.ts`
- Test: `src/config/model-routing.test.ts`

**Definition of Done:**

- [ ] RED tests first: default value, env override, applyModelRouting patches a tough-debugger.md fixture
- [ ] `bun test src/config/` green; existing 18 routing/settings tests unaffected
- [ ] `sentinal config get model_routing --json` shows `tough_bugs` (schema default backfills stored configs)

**Verify:** `bun test src/config/ && bun src/cli/index.ts config get model_routing --json`

### Task 2: Parser — per-task Files extraction

**Objective:** Extract `**Files:**` bullet lists from task blocks into `SpecTask.files: string[]` (default `[]`); round-trip through SpecStore serialization so `/spec/current` carries it.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/spec/parser.ts` (RawTask + extraction beside Status/DoD handling at lines 252-272), `src/spec/types.ts` (SpecTaskSchema), `src/spec/store.ts` (serialize/deserialize), `src/memory/migrations.ts` (**schema migration: `ALTER TABLE spec_tasks ADD COLUMN files`** — long-lived user DBs need the column, not just serializer changes; bump SCHEMA_VERSION)
- Test: `src/spec/parser.test.ts`, `src/spec/store.test.ts`, migration test in `src/memory/store.test.ts`

**Key Decisions / Notes:**

- Parse bullets like `- Create: path`, `- Modify: a, b`, `- Test: path`, `- Rename+modify: a, b` — strip the verb prefix, split on commas, strip backticks/whitespace; collect bare `- path` bullets too
- Additive-only: zero behavior change for plans without Files sections (Pre-Mortem #3)

**Definition of Done:**

- [ ] RED: parser test with a Files-bearing task fixture expecting exact paths array
- [ ] Round-trip test: syncFromPlanFile → getCurrentSpec returns files
- [ ] All existing parser/store tests green

**Verify:** `bun test src/spec/`

### Task 3: implementer + tough-debugger agents (both targets)

**Objective:** Ship two subagent definitions per target. `implementer`: full edit/bash tools, prompt = focused single-task TDD executor that must not deviate from the given task section. `tough-debugger`: full tools, prompt = deep-debugging specialist for issues that resisted 3 fix attempts; expects failing test + attempt log in prompt.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `targets/claude-code/agents/implementer.md`, `targets/claude-code/agents/tough-debugger.md` (frontmatter: name, description, tools, `model: sonnet` placeholder — patched by applyModelRouting)
- Create: `targets/opencode/agents/implementer.md`, `targets/opencode/agents/tough-debugger.md` (frontmatter: description, `mode: subagent`, NO model line — injected by plugin config hook; `hidden: true` for implementer)

**Key Decisions / Notes:**

- Mirror prompt content across targets (dual-target sync rule); OpenCode bare names, Claude Code namespaced `sentinal:` handled by platform
- Do NOT run embed-assets here (Task 7 owns regen — avoids wave file overlap)

**Definition of Done:**

- [ ] 4 files exist with consistent prompts; Claude Code pair carries `model:` placeholder; OpenCode pair has none

**Verify:** `ls targets/*/agents/ | grep -E "implementer|tough-debugger" | wc -l` → 4

### Task 4: scope-guard hook — core, dispatcher, hooks.json

**Objective:** New shared sync hook denying Write/Edit/MultiEdit to files not in the union of `files` across in_progress tasks of the active spec. Fail-open on any error/missing state.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Create: `src/hooks/scope-guard.ts`, `src/hooks/scope-guard.test.ts`
- Modify: `src/cli/commands/hook.ts` (SHARED_HOOKS + lazy runner), `targets/claude-code/hooks/hooks.json` (third Write|Edit|MultiEdit PreToolUse entry, timeout 5)

**Key Decisions / Notes:**

- Decision matrix (export `processScopeGuard(input, deps)` for tests):
  1. `SENTINAL_SCOPE_GUARD_ENABLED === "false"` → allow
  2. No active spec / spec not IN_PROGRESS → allow
  3. Determine enforcement set: union of `files` across in_progress tasks; **if no task is in_progress, fall back to the current task (first pending — same semantics as `SpecStore.getCurrentTask`)**. Empty set → allow (reviewer must-fix #1: without the fallback the guard never fires, since the orchestrator historically used session TaskUpdate, which never touches the spec store)
  4. Edited file IS the plan file → allow (model adds missing files to the plan this way)
  5. File in enforcement set (path-suffix match, normalize relative/absolute) → allow
  6. Always-allow list: companion test of a listed file (`x.test.ts` for listed `x.ts`), `.sentinal/` paths, `docs/plans/*.plan-review.json` / `*.spec-review.json` (subagent reviewer outputs — hooks fire for subagents too), `src/cli/embedded-assets.ts` (generated)
  7. Else → **mtime-checked resync before denying** (reviewer must-fix #2): if plan-file mtime > spec's last-synced timestamp, synchronously call `/spec/sync` and re-evaluate rules 3-6 ONCE. Still unmatched → deny with: "Off-plan edit blocked: <file> is not in the active task's **Files:** list of <plan>. Add it to Task N's Files section (then retry) or ask the user. Kill-switch: SENTINAL_SCOPE_GUARD_ENABLED=false". This closes the add-to-plan→retry loop in one deny instead of two.
- State source: sidecar `/spec/current` via `SidecarClient.connect()` (null → allow); follow tdd-guard's fast/slow pattern; NO markdown parsing in hot path (resync happens sidecar-side)
- Wire ONLY the live dispatcher path (no dead `main()`)

**Definition of Done:**

- [ ] RED tests covering all 7 matrix rows with injected fake spec state
- [ ] Dispatcher truth 4 passes; live smoke: deny fires via `sentinal hook shared scope-guard` with seeded spec state
- [ ] tsc clean, full suite green

**Verify:** `bun test src/hooks/scope-guard.test.ts` + Truth 4 command

### Task 5: OpenCode plugin — config hook + scope-guard branch

**Objective:** (a) Implement `config` hook: fetch routing (short sidecar connect → `GET /config`; fallback `SENTINAL_MODEL_*` env; else skip), inject `config.agent[{plan-reviewer,spec-reviewer,implementer,tough-debugger}].model` and `config.command.spec.model = planning` — only for values containing `/`. (b) Add scope-guard call in `tool.execute.before` after tdd-guard, same fail-open style, throwing on deny.
**Dependencies:** Tasks 1, 2, 4
**Wave:** 3

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts` (+ its test `targets/opencode/plugins/sentinal.test.ts`)
- Possibly create: `src/opencode/model-routing-inject.ts` (pure injection logic, testable — preferred per DRY rule) + test

**Key Decisions / Notes:**

- **FIRST verify the merge assumption (Pre-Mortem #1):** mutate config in a scratch plugin, restart OpenCode, check `/agents` shows injected model for plan-reviewer. If md-defined agents win over config mutations, pivot: deploy-time frontmatter rewrite via existing `applyModelRouting` pattern pointed at `~/.config/opencode/agents/` — the pivot MUST also (a) extend `config.ts:131-134` re-apply trigger to cover OpenCode dirs (today it only patches Claude Code plugin dirs), and (b) surface the downgrade to the user in the final report (they explicitly asked for runtime injection; install-time rewrite means config changes need `sentinal config set` to re-apply, not just a session restart)
- Add `config?:` to the hand-rolled Hooks interface (line 94-123)
- Never throw from config hook; log injected/skipped to plugin debug log

**Definition of Done:**

- [ ] Injection logic unit-tested (valid `/` IDs injected, aliases skipped, env fallback, sidecar-down skip)
- [ ] Merge assumption verified live OR pivot executed + documented
- [ ] `bun run build:opencode` + deploy + plugin-load smoke passes

**Verify:** `bun test src/opencode/ targets/opencode/plugins/sentinal.test.ts && bun run build:opencode`

### Task 6: Dashboard tough_bugs field + README docs

**Objective:** Add `tough_bugs` modelField to dashboard Settings (persists through existing settings POST); document the full routing feature in README (phases table, OpenCode `/`-format rule, env overrides, escalation flow, scope-guard + kill-switch). README must state plainly: `verification` routing has no OpenCode runtime effect (skills share the session), and `command.spec.model` routes the whole dispatcher session (i.e., the planning model).
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/dashboard/views/settings.ts` (+ test if view tests exist), `README.md`

**Definition of Done:**

- [ ] Settings form shows and saves tough_bugs; README sections added

**Verify:** `bun test src/dashboard/ && rg "tough_bugs" src/dashboard/views/settings.ts README.md`

### Task 7: spec-implement content updates + embed regen

**Objective:** Update spec-implement (OC skill + CC command): wave dispatch uses `Task(subagent_type="implementer")` (fallback `general` if unavailable); **orchestrator marks each task `[~]` in the plan + triggers spec sync BEFORE starting/dispatching it** (feeds scope-guard's in_progress semantics — reviewer must-fix #1) and `[x]` + sync after; new escalation rule — after 3 failed fix attempts on the same issue, dispatch `tough-debugger` with failing test + attempt log, instead of only deferring; advisory hint at phase start for main-session model ("switch via /models per your routing"). Regenerate embedded assets (covers Task 3's new agent files too).
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `targets/opencode/skills/spec-implement/SKILL.md`, `targets/claude-code/commands/spec-implement.md`
- Regenerate: `src/cli/embedded-assets.ts` via `bun run embed-assets`

**Definition of Done:**

- [ ] Truth 9 passes; embed regen idempotent; dual-target content consistent

**Verify:** Truth 9 command && `bun run embed-assets && git diff --stat src/cli/embedded-assets.ts`

### Task 8: Final verification

**Objective:** All 9 truths; full suite + tsc; `bun run build:all`; live smoke per `.opencode/skills/sentinal-live-smoke` (scope-guard deny via dispatcher, plugin load, routing injection visible); per-task DoD audit.
**Dependencies:** Tasks 1-7
**Wave:** 4

**Definition of Done:**

- [ ] `bun test > /tmp/t.log 2>&1; echo $?` → 0; `bunx tsc --noEmit` clean; `bun run build:all` succeeds
- [ ] All 9 truths pass; residual notes recorded (Bash-write bypass, OpenCode alias skip rule)

**Verify:** Truth commands 1-9
