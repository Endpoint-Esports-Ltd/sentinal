# Phase 3: OpenCode Plugin Hooks

Created: 2026-04-20
Status: VERIFIED
Approved: Yes
Iterations: 2
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 1

## Summary

**Goal:** Adopt OpenCode's new experimental and core plugin capabilities from OC 1.4.0–1.15.10: register a `compaction.autocontinue` handler with TDD/spec awareness, add `compaction.reserved` token-budget awareness to context injection, register a native plugin tool with structured metadata, and update the master-execute skill for `--dangerously-skip-permissions`. Extract handler logic to `src/opencode/*.ts` for testability.

**Architecture:** New `src/opencode/` module provides testable handler functions imported by `sentinal.ts`. A new sidecar `/config/compaction` endpoint reads the user's `opencode.json` to serve `compaction.reserved` values. Type definitions at `targets/opencode/types/opencode-plugin.d.ts` are extended to declare `compaction.autocontinue` as a hook event. The native `sentinal_tdd_status` tool uses `tool()` helper with Zod schemas.

**Tech Stack:** TypeScript (Bun), Zod 4.x for native tool arg schemas, SidecarClient for TDD/spec state queries.

## Scope

### In Scope

- `compaction.autocontinue` hook handler — pause if TDD RED, inject spec resume directive
- Sidecar `/config/compaction` endpoint + SidecarClient method for reading user's `compaction.reserved` config
- Token-budget-aware context injection in the compacting handler — shrink injected context proportionally to `compaction.reserved`
- Native plugin tool `sentinal_tdd_status` using Zod schemas and `tool()` helper with metadata return
- Type definition updates for `compaction.autocontinue` hook event
- Skill markdown update for `--dangerously-skip-permissions` guidance in master-execute
- Deferred decision doc for plugin `authorize` API

### Out of Scope

- Extracting the entire `experimental.session.compacting` handler from sentinal.ts (only new autocontinue logic is extracted)
- Full `api.keymap` migration (investigation confirmed `api.command` is not used — no migration needed)
- Effect-based event system migration (investigation confirmed current handler registration pattern is compatible with OC 1.15.x — the `PluginHooks` return-object pattern is unchanged)
- Instruction precedence restructuring (investigation confirmed no conflicts — `~/.config/opencode/AGENTS.md` contains general dev-tool instructions, not project-overriding rules)
- Plugin `authorize` API implementation (deferred, no cloud-sync feature exists)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

**Patterns to follow:**

- **Handler extraction pattern:** `src/hooks/memory-observer.ts` (extracted from `hook.ts` in Phase 2) — export a pure async function, import from sentinal.ts. See `src/hooks/memory-observer.ts:1` for the signature pattern.
- **Sidecar route pattern:** `src/sidecar/config-routes.ts:1` — a function taking `(ctx)` and returning `Response | null`. Wire into `src/sidecar/server.ts` router by path prefix.
- **SidecarClient method pattern:** `src/sidecar/client.ts:190-198` — `getModelRouting()` shows the GET-endpoint-to-client-method pattern.
- **MCP native tool pattern:** OpenCode `tool()` helper from `@opencode-ai/plugin`. See Context7 docs snippet: `tool({ description, args: { foo: tool.schema.string() }, async execute(args, context) { ... } })`.
- **Plugin hook registration:** `sentinal.ts:396` — return object with named event handlers. New hooks are added as additional keys.

**Conventions:**

- All imports from `src/` in sentinal.ts use triple-dot relative paths with `.js` extension: `../../../src/opencode/foo.js`
- Sidecar endpoints use JSON response helpers from `src/sidecar/response.ts` (`ok()`, `err()`)
- Tests use `bun:test` with `describe/it/expect`. Sidecar tests use `buildForTest(baseUrl)` for client construction.
- Type definitions for OC plugin SDK live in `targets/opencode/types/opencode-plugin.d.ts` (our own file, safe to extend)

**Key files:**

- `targets/opencode/plugins/sentinal.ts` (1061 lines) — the OpenCode plugin entry point. Exempt from line-length limits.
- `targets/opencode/plugins/sentinal-helpers.ts` (218 lines) — extracted plugin helpers
- `targets/opencode/types/opencode-plugin.d.ts` (231 lines) — local type definitions for OC plugin SDK
- `src/sidecar/config-routes.ts` (27 lines) — currently only has `/config/model-routing`
- `src/sidecar/client.ts` (~400 lines) — SidecarClient with all HTTP methods
- `src/tdd/mcp-tools.ts` (197 lines) — existing `tdd_status` MCP tool (reference for native tool)
- `src/sidecar/tdd-routes.ts` (82 lines) — TDD state endpoints
- `targets/opencode/skills/spec-master-execute/SKILL.md` (166 lines) — master execute skill to update

**Gotchas:**

- **sentinal.ts cannot import bun:sqlite transitively.** All imports from `src/` must be from files that DON'T pull in bun:sqlite. The sidecar client is safe; MemoryStore is NOT. Check import chains.
- **Native tools previously failed** because raw objects were passed instead of Zod schemas for `args`. The fix is using `tool()` helper or `z.string()` etc directly. See `sentinal.ts:1055` comment for history.
- **Sidecar may be null.** Every sidecar call must be guarded with `if (sidecar)` — the plugin initializes it once at startup and never reconnects.
- **`compaction.autocontinue` is experimental.** Wrap in try/catch. If OC doesn't dispatch it, the handler is a no-op.
- **`compaction.reserved` is the OC config name** (not `preserve_recent_tokens`). It lives in the user's `opencode.json` under `compaction.reserved`. Default is 10000 tokens.

**Domain context:**

- **Compaction** is OC's way of managing context window limits. When the conversation grows too large, OC compacts it — summarizing history and preserving recent tokens. Sentinal injects spec state and memory context into the compacted output so the agent can resume work.
- **Autocontinue** fires after compaction completes. It decides whether to automatically continue the conversation. Sentinal wants to pause here if TDD is in RED state (the agent should fix failing tests before continuing) or inject a resume directive for active specs.
- **Native tools** are tools defined directly in the plugin (not via MCP). They appear in the agent's tool list with first-class Zod-validated arguments and can return structured metadata.

## Assumptions

- OpenCode 1.15.x still dispatches `compaction.autocontinue` as an experimental hook event — supported by re-audit confirming OC-1 landed in 1.4.4 and no breaking changes since. Tasks 1, 2 depend on this.
- The `tool()` helper from `@opencode-ai/plugin` works with the `tool` slot in `PluginHooks` — supported by Context7 docs showing exact pattern. Task 6 depends on this.
- `compaction.reserved` is readable from the user's `opencode.json` at the project root — supported by OC config docs showing the field. Tasks 3, 4 depend on this.
- `sentinal.ts` is deployed via `bun run build:opencode` which bundles it into `dist/sentinal.mjs` — Task 6's `tool()` import from `@opencode-ai/plugin` must be available at bundle time. Supported by the existing `declare const tool: ToolHelper` in the `.d.ts`.

## Testing Strategy

- **Unit tests:** Each `src/opencode/*.ts` handler gets a companion `.test.ts` with dependency-injected sidecar mocks
- **Sidecar route tests:** `/config/compaction` tested via `buildForTest(baseUrl)` pattern
- **Integration:** `sentinal.ts` changes verified via `bun run build:opencode` succeeding
- **Manual:** After deploy, trigger compaction in an OC session and verify Sentinal's autocontinue behavior

## Risks and Mitigations

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                 |
| --------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------ |
| `compaction.autocontinue` API renamed/removed in OC 1.15+                   | Low        | Medium | Wrap handler in try/catch; handler is a no-op if never called                              |
| `tool()` helper not available at bundle time (it's a `declare const`)       | Medium     | High   | If import fails, fall back to raw `ToolDefinition` object with Zod schemas directly        |
| `opencode.json` not at expected path or malformed                           | Low        | Low    | Default to 10000 tokens if config unreadable; log warning                                  |
| New `src/opencode/` directory creates import chain that pulls in bun:sqlite | Medium     | High   | Each new file must be checked for transitive sqlite imports before wiring into sentinal.ts |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **The `compaction.autocontinue` handler never fires** (Tasks 1, 2) → Trigger: after deploying, compact a session and check logs — if no `autocontinue` log entry appears, the event name is wrong or the hook slot isn't dispatched by OC 1.15.x. Fallback: wire logic into the existing `experimental.session.compacting` handler instead.
2. **Native tool registration crashes at plugin load** (Task 6) → Trigger: `bun run build:opencode && bun run deploy:opencode` succeeds but OC fails to load the plugin. Check `~/.sentinal/plugin.debug.log` for Zod schema serialization errors. Fallback: remove tool slot, keep MCP-only approach.
3. **Sidecar `/config/compaction` reads stale config** (Tasks 3, 4) → Trigger: change `compaction.reserved` in `opencode.json`, verify sidecar returns new value. If stale, add a `CwdChanged` invalidation (we already have `/project-context/invalidate`).

## Execution Waves

**Wave 1** — Infrastructure (parallel): Type defs, sidecar endpoint, and src/opencode directory are independent foundations.
**Wave 2** — Handlers (parallel): Each handler depends on Wave 1 infrastructure but not on each other.
**Wave 3** — Plugin wiring (sequential): All handlers must exist before wiring into sentinal.ts + skill update + decision doc.

## Goal Verification

### Truths

1. `targets/opencode/types/opencode-plugin.d.ts` contains `"compaction.autocontinue"` as a hook event name
2. `src/opencode/compaction-autocontinue.ts` exports `handleCompactionAutocontinue` function
3. `src/opencode/compaction-context.ts` exports a function that accepts a `reserved` token budget and returns proportionally sized context
4. `src/sidecar/config-routes.ts` handles `GET /config/compaction` returning `{ reserved: number }`
5. `src/sidecar/client.ts` contains `getCompactionConfig` method
6. `sentinal.ts` contains `import.*compaction-autocontinue` and registers it as `"compaction.autocontinue"` key
7. `sentinal.ts` contains a `tool:` slot with `sentinal_tdd_status` using `tool()` or Zod schema args
8. `bun test src/opencode/` passes with 0 failures
9. `bun run build:opencode` succeeds

### Artifacts

| Artifact                                                          | Provides                            | Exports                                  |
| ----------------------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| `src/opencode/compaction-autocontinue.ts`                         | Autocontinue handler                | `handleCompactionAutocontinue()`         |
| `src/opencode/compaction-context.ts`                              | Token-budget-aware context builder  | `buildCompactionContext()`               |
| `src/opencode/native-tdd-status.ts`                               | Native tool handler for TDD status  | `tddStatusTool` (ToolDefinition)         |
| `src/sidecar/config-routes.ts` (modified)                         | Compaction config endpoint          | `GET /config/compaction`                 |
| `src/sidecar/client.ts` (modified)                                | Client method for compaction config | `getCompactionConfig()`                  |
| `targets/opencode/types/opencode-plugin.d.ts` (modified)          | Type defs                           | `PluginHooks["compaction.autocontinue"]` |
| `targets/opencode/plugins/sentinal.ts` (modified)                 | Plugin wiring                       | autocontinue handler + native tool       |
| `targets/opencode/skills/spec-master-execute/SKILL.md` (modified) | Skill guidance                      | `--dangerously-skip-permissions` docs    |
| `docs/decisions/2026-04-20-opencode-authorize-api.md`             | Deferred decision                   | n/a                                      |

### Key Links

| From                         | To                                        | Via           | Pattern                            |
| ---------------------------- | ----------------------------------------- | ------------- | ---------------------------------- |
| `sentinal.ts`                | `src/opencode/compaction-autocontinue.ts` | import        | `import.*compaction-autocontinue`  |
| `sentinal.ts`                | `src/opencode/compaction-context.ts`      | import        | `import.*compaction-context`       |
| `sentinal.ts`                | `src/opencode/native-tdd-status.ts`       | import        | `import.*native-tdd-status`        |
| `compaction-autocontinue.ts` | `SidecarClient`                           | sidecar calls | `getTddState\|getCurrentSpec`      |
| `compaction-context.ts`      | `SidecarClient`                           | sidecar calls | `getCompactionConfig`              |
| `config-routes.ts`           | `opencode.json`                           | file read     | `readFileSync.*opencode\.json`     |
| `native-tdd-status.ts`       | `SidecarClient`                           | sidecar calls | `getTddState\|listActiveTddStates` |

## Progress Tracking

- [x] Task 1: Update opencode-plugin.d.ts type definitions (Wave 1)
- [x] Task 2: Create src/opencode/ directory structure (Wave 1)
- [x] Task 3: Add sidecar /config/compaction endpoint (Wave 1)
- [x] Task 4: Add SidecarClient.getCompactionConfig() method (Wave 1)
- [x] Task 5: Implement compaction-autocontinue handler (Wave 2)
- [x] Task 6: Implement compaction-context token-budget handler (Wave 2)
- [x] Task 7: Implement native sentinal_tdd_status tool (Wave 2)
- [x] Task 8: Wire all handlers into sentinal.ts (Wave 3)
- [x] Task 9: Update spec-master-execute skill for --dangerously-skip-permissions (Wave 3)
- [x] Task 10: Write deferred decision doc for authorize API (Wave 3)
      **Total Tasks:** 10 | **Completed:** 10 | **Remaining:** 0

## Implementation Tasks

### Task 1: Update Type Definitions (3 files)

**Objective:** Add `compaction.autocontinue` as a recognized hook event across all type definition locations, and fix `ToolDefinition.execute` return type.

**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/opencode/types/opencode-plugin.d.ts` (canonical SDK types)
- Modify: `targets/opencode/plugins/sentinal.ts` (local interfaces at lines 71-125)
- Modify: `targets/opencode/plugins/sentinal.d.ts` (companion declaration file, lines 53-90)

**Key Decisions / Notes:**

- **Three type definition locations exist** (discovered by plan-reviewer):
  1. `opencode-plugin.d.ts:156` — canonical SDK types
  2. `sentinal.ts:100-125` — local `PluginHooks` interface used for actual return type
  3. `sentinal.d.ts:61-90` — companion `.d.ts` (hand-maintained, mirrors sentinal.ts)
     All three must be updated in sync.

- **Add `"compaction.autocontinue"?`** to `PluginHooks` in all 3 files:

  ```typescript
  "compaction.autocontinue"?: (
    input: { sessionID: string },
    output: { continue: boolean; context: string[] },
  ) => Promise<void>;
  ```

- **Fix `ToolDefinition.execute` return type** — sentinal.ts:97 and sentinal.d.ts:59 return `Promise<string>`. Change to `Promise<unknown>` to support structured metadata return from native tools. The canonical `opencode-plugin.d.ts` already uses `Promise<unknown>`.

- **Add `"experimental.chat.system.transform"?`** to `opencode-plugin.d.ts:156` — it's already in sentinal.ts:113 and sentinal.d.ts but missing from the canonical types.

- **sentinal.d.ts is hand-maintained** (not generated by `build:opencode`). It mirrors the local interfaces in sentinal.ts and must be kept in sync manually.
- No tests needed — type-only changes, verified by `bun run build:opencode`.

**Definition of Done:**

- [ ] `PluginHooks` includes `"compaction.autocontinue"` in all 3 files
- [ ] `PluginHooks` includes `"experimental.chat.system.transform"` in opencode-plugin.d.ts
- [ ] `ToolDefinition.execute` returns `Promise<unknown>` in sentinal.ts and sentinal.d.ts
- [ ] `bun run build:opencode` succeeds

**Verify:**

- `bun run build:opencode`

---

### Task 2: Create src/opencode/ Directory Structure

**Objective:** Create the `src/opencode/` directory and establish it as the home for extracted OpenCode-specific handler logic.

**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/opencode/index.ts` (barrel export — initially empty, populated as handlers land)

**Key Decisions / Notes:**

- Just create the directory and barrel file. Content comes in Wave 2 tasks.
- The barrel should NOT re-export anything that transitively imports bun:sqlite.
- No tests needed for an empty barrel.

**Definition of Done:**

- [ ] `src/opencode/` directory exists
- [ ] `src/opencode/index.ts` exists as empty barrel

**Verify:**

- `ls src/opencode/index.ts`

---

### Task 3: Add Sidecar /config/compaction Endpoint

**Objective:** Add a `GET /config/compaction` sidecar endpoint that reads the user's `opencode.json` to extract `compaction.reserved` (default: 10000).

**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/sidecar/config-routes.ts`
- Test: `src/sidecar/config-routes.test.ts`

**Key Decisions / Notes:**

- Extend the existing `handleConfigRoutes()` function in `config-routes.ts:1` to handle a second path: `GET /config/compaction`.
- The handler reads `opencode.json` using the `?project=<path>` query param exclusively (matching Task 4's client method: `GET /config/compaction?project=${encodeURIComponent(projectPath)}`). Do NOT rely on `ctx.projectPath` — the existing config-routes handler at line 22 uses `ctx.store`, not a project path field.
- Parse with `JSON.parse(readFileSync(join(projectPath, "opencode.json"), "utf-8"))` and extract `compaction?.reserved ?? 10000`.
- Return shape: `{ reserved: number }`.
- Follow existing pattern: `config-routes.ts` currently imports `resolveModelRouting` and calls `ok()`. Keep the same style.
- Test: write 3 scenarios — config present with custom value, config present without `compaction` key, config file missing.

**Definition of Done:**

- [ ] `GET /config/compaction?project=<path>` returns `{ reserved: number }`
- [ ] Defaults to 10000 when config missing or field absent
- [ ] All 3 test scenarios pass
- [ ] No bun:sqlite transitive imports

**Verify:**

- `bun test src/sidecar/config-routes.test.ts`

---

### Task 4: Add SidecarClient.getCompactionConfig() Method

**Objective:** Add a `getCompactionConfig(projectPath)` method to SidecarClient that calls the new endpoint.

**Dependencies:** Task 3
**Wave:** 1

**Files:**

- Modify: `src/sidecar/client.ts`
- Test: `src/sidecar/client.test.ts` (add one test case)

**Key Decisions / Notes:**

- Follow the `getModelRouting()` pattern at `client.ts:190-198`.
- Method signature: `async getCompactionConfig(projectPath: string): Promise<{ reserved: number }>`
- Calls `GET /config/compaction?project=${encodeURIComponent(projectPath)}`
- Add test alongside existing client tests — mock the endpoint response.
- NOTE: `client.test.ts` has pre-existing SidecarClient port-conflict failures in parallel runs. Don't try to fix those — just add the new test case.

**Definition of Done:**

- [ ] `SidecarClient.getCompactionConfig(projectPath)` exists and returns `{ reserved: number }`
- [ ] Test case passes (may need to run individually if parallel port conflicts occur)

**Verify:**

- `bun test src/sidecar/client.test.ts --test-name-pattern "compaction"`

---

### Task 5: Implement compaction-autocontinue Handler

**Objective:** Create the `handleCompactionAutocontinue()` function that pauses autocontinue when TDD is RED, and injects a spec resume directive when an active spec is in progress.

**Dependencies:** Task 2 (directory exists)
**Wave:** 2

**Files:**

- Create: `src/opencode/compaction-autocontinue.ts`
- Create: `src/opencode/compaction-autocontinue.test.ts`

**Key Decisions / Notes:**

- Function signature:
  ```typescript
  export async function handleCompactionAutocontinue(
    sidecar: SidecarClient | null,
    projectPath: string,
  ): Promise<{ shouldContinue: boolean; context: string[] }>;
  ```
- Logic:
  1. If `sidecar` is null → return `{ shouldContinue: true, context: [] }` (graceful degradation)
  2. Query TDD state: `sidecar.listActiveTddStates()` — if any state is `RED_CONFIRMED`, return `{ shouldContinue: false, context: ["TDD cycle is in RED state — fix failing tests before continuing"] }`
  3. Query spec status: `sidecar.getCurrentSpec(projectPath)` — if spec is active (IN_PROGRESS), add context: `"Resume spec: [plan path] — current task: Task N: [title]"`
  4. Return `{ shouldContinue: true, context: [...specDirectives] }`
- Test 3 scenarios:
  1. **TDD RED** — mock `listActiveTddStates` returning one RED_CONFIRMED entry → `shouldContinue: false`
  2. **Active spec, no RED** — mock getCurrentSpec returning IN_PROGRESS spec → `shouldContinue: true` with resume context
  3. **Idle state** — mock both returning empty → `shouldContinue: true, context: []`
- Use dependency injection for sidecar (accept as parameter, not imported global).
- **Untested assumption:** `sidecar.getCurrentSpec(projectPath)` returns a Spec object with `status`, `planPath`/`filePath`, and current task info. Verify the actual return shape from `src/sidecar/routes.ts` (`GET /spec/current`) before writing tests. If it doesn't include task details, use `sidecar.specStatus()` or `findActivePlan()` from `src/spec/detect.js` instead (which sentinal.ts already uses at line 668).

**Definition of Done:**

- [ ] `handleCompactionAutocontinue()` exported from `src/opencode/compaction-autocontinue.ts`
- [ ] Returns `shouldContinue: false` when TDD RED
- [ ] Returns spec resume directive when spec active
- [ ] All 3 test scenarios pass
- [ ] No bun:sqlite transitive imports

**Verify:**

- `bun test src/opencode/compaction-autocontinue.test.ts`

---

### Task 6: Implement compaction-context Token-Budget Handler

**Objective:** Create a function that builds compaction context (spec state + memory) proportionally sized to the `compaction.reserved` token budget.

**Dependencies:** Tasks 3, 4 (sidecar endpoint exists)
**Wave:** 2

**Files:**

- Create: `src/opencode/compaction-context.ts`
- Create: `src/opencode/compaction-context.test.ts`

**Key Decisions / Notes:**

- Function signature:
  ```typescript
  export function buildCompactionContext(opts: {
    specContext: string | null;
    memoryContext: string | null;
    reservedTokens: number;
  }): string[];
  ```
- Logic:
  1. Estimate token count of each context block (~4 chars per token heuristic)
  2. Total budget: `reservedTokens * 0.3` — Sentinal should use at most 30% of the reserved space (the rest is for recent conversation tokens that OC preserves verbatim)
  3. If both contexts fit → return both
  4. If only spec fits → return spec only (priority)
  5. If neither fits → truncate spec to budget, drop memory
  6. Log observation (return it as metadata, let caller decide) when budget forces truncation
- Test 4 scenarios:
  1. **Large budget (default 10000)** — both contexts fit
  2. **Small budget (1000)** — only spec fits
  3. **Tiny budget (100)** — spec truncated
  4. **Zero budget (0)** — return empty array (user disabled preservation)
- This is a pure function — no sidecar dependency, easy to test.

**Definition of Done:**

- [ ] `buildCompactionContext()` exported from `src/opencode/compaction-context.ts`
- [ ] Returns proportionally sized context based on reserved tokens
- [ ] All 4 test scenarios pass
- [ ] Spec context prioritized over memory context

**Verify:**

- `bun test src/opencode/compaction-context.test.ts`

---

### Task 7: Implement Native sentinal_tdd_status Tool

**Objective:** Register a native OpenCode plugin tool `sentinal_tdd_status` that returns TDD state with structured metadata.

**Dependencies:** Task 2 (directory exists)
**Wave:** 2

**Files:**

- Create: `src/opencode/native-tdd-status.ts`
- Create: `src/opencode/native-tdd-status.test.ts`

**Key Decisions / Notes:**

- The tool is defined as a factory that accepts a sidecar client:
  ```typescript
  export function createTddStatusTool(
    sidecar: SidecarClient | null,
  ): ToolDefinition;
  ```
- Uses `z.string().optional().describe("...")` for args (file_path, spec_id — matching existing MCP tool params).
- Execute function:
  1. If `file_path` provided: `sidecar.getTddState(file_path)` — return state + metadata
  2. If no `file_path`: `sidecar.listActiveTddStates(spec_id)` — return list
  3. Return value includes structured `metadata` object:
     ```typescript
     return {
       content: formattedString,
       metadata: {
         sentinal: {
           tdd_state: state,
           cycle_duration_ms: ...,
           spec_task: ...,
         }
       }
     }
     ```
- Import `z` from `"zod"` (NOT from `tool.schema` — that's only available in the plugin runtime, not in `src/` files)
- Test: mock sidecar, verify return shape matches expected metadata structure for both single-file and list modes.
- **Important:** The `tool()` helper is a runtime global in OC plugins. Since this file is in `src/`, it can't use `tool()`. Instead, export a raw `ToolDefinition` object with Zod schemas in `args`. The `sentinal.ts` wiring will use this directly in the `tool:` slot.

**Definition of Done:**

- [ ] `createTddStatusTool()` exported from `src/opencode/native-tdd-status.ts`
- [ ] Returns `ToolDefinition` with Zod schemas for args
- [ ] Execute returns structured metadata under `metadata.sentinal`
- [ ] Tests pass for single-file and list modes
- [ ] No bun:sqlite transitive imports

**Verify:**

- `bun test src/opencode/native-tdd-status.test.ts`

---

### Task 8: Wire All Handlers into sentinal.ts

**Objective:** Import and register the three new handlers in the OpenCode plugin: autocontinue hook, token-budget-aware compaction, and native TDD status tool.

**Dependencies:** Tasks 1, 5, 6, 7
**Wave:** 3

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`

**Key Decisions / Notes:**

- **Add imports** (at the top, following existing pattern):
  ```typescript
  import { handleCompactionAutocontinue } from "../../../src/opencode/compaction-autocontinue.js";
  import { buildCompactionContext } from "../../../src/opencode/compaction-context.js";
  import { createTddStatusTool } from "../../../src/opencode/native-tdd-status.js";
  ```
- **Register autocontinue handler** — add a new key to the returned PluginHooks object:
  ```typescript
  "compaction.autocontinue": async (input, output) => {
    const result = await handleCompactionAutocontinue(sidecar, projectRootForSidecar);
    if (!result.shouldContinue) output.continue = false;
    if (result.context.length) result.context.forEach(c => output.context.push(c));
  },
  ```
- **Modify existing compacting handler** — after the existing context injection at line 748, add token-budget awareness:
  ```typescript
  // Before pushing to output.context, size the content
  let reserved = 10000; // default
  if (sidecar) {
    try {
      reserved = (await sidecar.getCompactionConfig(projectRootForSidecar))
        .reserved;
    } catch {}
  }
  const budgetedContext = buildCompactionContext({
    specContext: specLines?.join("\n") ?? null,
    memoryContext,
    reservedTokens: reserved,
  });
  budgetedContext.forEach((c) => output.context.push(c));
  ```
  Replace the existing direct `output.context.push(specLines.join("\n"))` and `output.context.push(memoryContext)` with the budgeted version.
- **Register native tool** — add `tool:` slot to the returned object:
  ```typescript
  tool: {
    sentinal_tdd_status: createTddStatusTool(sidecar),
  },
  ```
- **No new tests in sentinal.ts** — the logic is tested in `src/opencode/*.test.ts`. The wiring is verified by `bun run build:opencode`.

**Definition of Done:**

- [ ] sentinal.ts imports all 3 new src/opencode/ modules
- [ ] `compaction.autocontinue` key added to returned PluginHooks
- [ ] Existing compacting handler uses `buildCompactionContext()` for token-budget sizing
- [ ] `tool:` slot registered with `sentinal_tdd_status`
- [ ] Local `PluginHooks` interface at line ~100 confirmed to have `compaction.autocontinue` key (from Task 1)
- [ ] Local `ToolDefinition.execute` return type is `Promise<unknown>` (from Task 1)
- [ ] `bun run build:opencode` succeeds
- [ ] No TypeScript errors

**Verify:**

- `bun run build:opencode`

---

### Task 9: Update spec-master-execute Skill for --dangerously-skip-permissions

**Objective:** Add guidance to the master-execute skill about using `--dangerously-skip-permissions` for unattended sub-phase dispatch.

**Dependencies:** None (markdown-only)
**Wave:** 3

**Files:**

- Modify: `targets/opencode/skills/spec-master-execute/SKILL.md`
- Modify: `targets/claude-code/commands/spec-master-execute.md` (keep in sync)

**Key Decisions / Notes:**

- Add a new section "## Unattended Execution" explaining:
  - When running sub-phases via `opencode run -p "..."`, append `--dangerously-skip-permissions` to avoid permission prompts in headless mode
  - Only use in non-interactive contexts (CI, automated testing)
  - Never use when a human is actively reviewing changes
- This is markdown-only — no TypeScript code, no tests needed.
- Keep both target files in sync (CC and OC versions).

**Definition of Done:**

- [ ] OC skill includes `--dangerously-skip-permissions` guidance section
- [ ] CC command includes matching guidance section
- [ ] No conflicting information between the two

**Verify:**

- Visual review of both files

---

### Task 10: Write Deferred Decision Doc for Authorize API

**Objective:** Document why the plugin `authorize` API (OC-3) is deferred and when to revisit.

**Dependencies:** None
**Wave:** 3

**Files:**

- Create: `docs/decisions/2026-04-20-opencode-authorize-api.md`

**Key Decisions / Notes:**

- Short (1 page) document recording:
  - What: Plugin `authorize` API lets plugins approve/deny operations with structured reasons
  - Why deferred: No cloud-sync memory feature exists today — `authorize` would be useful for gating cloud uploads/downloads of observations
  - When to revisit: If/when cloud sync is added to Sentinal's memory system
  - Alternative: Current MCP-based permission model is sufficient for local-only operations
- Follow existing `docs/decisions/` patterns if any exist, otherwise keep it simple.

**Definition of Done:**

- [ ] Decision doc exists at `docs/decisions/2026-04-20-opencode-authorize-api.md`
- [ ] Documents what, why deferred, when to revisit

**Verify:**

- `cat docs/decisions/2026-04-20-opencode-authorize-api.md`

---

## Investigation Resolutions

_From the "Investigate During Planning" section of the original stub:_

| Item                                                 | Resolution                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.command` deprecated → `api.keymap` (OC 1.14.45) | **Not applicable.** `sentinal.ts` does not use `api.command`. No migration needed.                                                                                                                                                                                                        |
| Instruction precedence change (OC 1.14.30)           | **No conflict found.** `~/.config/opencode/AGENTS.md` contains general dev-tool instructions (Sentinal commands, workflow guidance) that don't override project-specific `.sentinal/rules/`. The precedence change is harmless for our use case.                                          |
| Effect-based core event system (OC 1.15.0)           | **Compatible.** The `PluginHooks` return-object pattern (where the plugin returns named handler functions) is unchanged. The effect-based system is an internal OC refactor of how events are dispatched, not a change to the plugin API surface. Our handler registration pattern works. |
| All 7 OC items confirmed shipped                     | **Confirmed.** All features landed and stable. No API changes detected.                                                                                                                                                                                                                   |
| Zod schema metadata preservation (OC 1.15.1)         | **Leveraged.** Task 7 relies on this — `sentinal_tdd_status` tool uses Zod schemas for args and structured metadata return.                                                                                                                                                               |
