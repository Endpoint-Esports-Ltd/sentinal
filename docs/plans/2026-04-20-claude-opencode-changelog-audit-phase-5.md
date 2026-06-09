# Phase 5: Workspace Adaptor + Permission Middleware

Created: 2026-04-20
Status: COMPLETE
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 3

## Summary

**Goal:** Ship two strategic integrations that require Wave 1-2 infrastructure: (A) a native OpenCode workspace adaptor that registers "Sentinal Spec Worktree" in OpenCode's workspace creation UI, pre-filling from the active spec plan and targeting the existing worktree path; (B) `continueOnBlock` on `file-checker` so Claude self-corrects on style/length warnings rather than receiving hard denies, while keeping `tdd-guard` as a hard block.

**Architecture:** Section A adds `experimental_workspace.register()` to the plugin entry point in `targets/opencode/plugins/sentinal.ts`. An extracted helper module `src/opencode/workspace-adaptor.ts` implements the four adaptor methods: `configure()` reads the active spec from sidecar (falling back to `compact-state.json`), `target()` resolves the worktree path, `create()` calls `worktree_create` on the sidecar, `remove()` calls `worktree_abandon`. Section B adds `continueOnBlock: true` to the `file-checker` entry in `hooks.json` and adds a corresponding `output.hookSpecificOutput.continueOnBlock` path to `src/utils/hook-output.ts` + `src/hooks/file-checker.ts`.

**Tech Stack:** Bun/TypeScript, `@opencode-ai/plugin` v1.4.4+ `WorkspaceAdaptor` API, Claude Code hooks.json `continueOnBlock` field (CC 2.1.139), existing `SidecarClient`.

## Scope

### In Scope

- **Section A (OpenCode workspace adaptor):**
  - `src/opencode/workspace-adaptor.ts` implementing `WorkspaceAdaptor` against the `@opencode-ai/plugin` SDK
  - Plugin `PluginContext` type extended with `experimental_workspace` field
  - Plugin entry point calls `experimental_workspace.register("sentinal-spec-worktree", adaptor)` at init
  - `configure()`: reads active spec from `SidecarClient.getCurrentSpec()` (fallback: parse `compact-state.json`); pre-fills `WorkspaceInfo.name` from plan slug, stores plan path in `extra`
  - `target()`: resolves worktree path via `SidecarClient.resolveWorktreeBySlug()`; if no worktree yet, returns `{ type: "local", directory: projectPath }` as pre-creation placeholder
  - `create()`: calls `SidecarClient.cleanupWorktrees()` / `POST /worktree/create` via client; also runs `sentinal register-plan` for the spec
  - `remove()`: calls `SidecarClient.abandonWorktree()`
  - `worktree.baseRef` setting awareness (CC 2.1.133): pass `baseBranch` from CC settings to `worktree_create` if available (gracefully skip if not present)

- **Section B (permission middleware):**
  - `src/utils/hook-output.ts`: add `continueOnBlock(reason): ContinueOnBlockOutput` export returning `{ continueOnBlock: true, stopReason: reason }`
  - `src/hooks/file-checker.ts`: replace terminal `hint(...)` call with `continueOnBlock(...)` for file-length and quality violations (keeps hint for informational observations)
  - `targets/claude-code/hooks/hooks.json`: add `"continueOnBlock": true` to the PostToolUse `file-checker` hook entry (CC 2.1.139)
  - Dual-target parity: OpenCode `tool.execute.after` path already returns strings that become context — no change needed there

### Out of Scope

- `permissionDecision: "defer"` (headless resume — complex, lower impact than continueOnBlock)
- `updatedInput` rewrite for tool-redirect (user chose to keep hard deny)
- Elicitation/ElicitationResult hooks
- `worktree.bgIsolation` setting awareness (low impact)
- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` changes (Sentinal's stop guard blocks at most once per turn — no risk)
- OpenCode permission/auth API (`authorize` hook — OC-3, previously descoped as YAGNI)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **WorkspaceAdaptor API** (`~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`):

  ```ts
  type WorkspaceAdaptor = {
    name: string;
    description: string;
    configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>;
    create(config: WorkspaceInfo, from?: WorkspaceInfo): Promise<void>;
    remove(config: WorkspaceInfo): Promise<void>;
    target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>;
  };
  // WorkspaceInfo: { id, type, name, branch, directory, extra, projectID }
  // WorkspaceTarget: { type:"local", directory } | { type:"remote", url }
  // PluginInput.experimental_workspace.register(type, adaptor) — call at plugin init
  ```

  The plugin currently uses its own local `PluginContext` interface (line 75) rather than the SDK's `PluginInput` — extend `PluginContext` to add `experimental_workspace: { register(type: string, adaptor: WorkspaceAdaptor): void }` (the SDK type is in scope via the installed `@opencode-ai/plugin` package).

- **Sidecar worktree routes** (`src/sidecar/worktree-routes.ts`):
  - `GET /worktree/resolve?slug=<slug>&project=<path>` → `Worktree | null`
  - `POST /worktree/abandon { worktree_id }` → `void`
  - `POST /worktree/cleanup { project }` → `{ cleaned: number }`
  - Worktree **create** is NOT a sidecar route — it's a CLI/manager operation. Use `WorktreeManager.create()` directly or spawn `sentinal worktree create` via the `$` shell helper. The `create()` method is in `src/worktree/manager.ts:43`.

- **compact-state.json fallback** (`targets/opencode/plugins/sentinal.ts:980`): the compaction handler writes `{ activePlan, memoryContext, timestamp, cwd }` to `<projectRoot>/.sentinal/compact-state.json`. The adaptor's `configure()` can read this file as a fallback when the sidecar is unavailable.

- **continueOnBlock** (`targets/claude-code/hooks.json`): add `"continueOnBlock": true` to the **outer** matcher object for `file-checker` (at the same level as `matcher` and `if`, NOT inside the `hooks: [...]` array item). CC 2.1.139 reads the field at the matcher level. When this flag is set and the hook exits 2 (block), CC feeds the block reason back to Claude as context rather than terminating the turn.

- **hook-output.ts pattern** (`src/utils/hook-output.ts:95-131`): add a `blockExit()` helper analogous to the existing `denyExit()`:

  ```ts
  // blockExit: used by soft-block hooks with continueOnBlock:true in hooks.json.
  // Exit code 2 is required — CC only acts on { decision:"block" } when exit code is 2.
  // The continueOnBlock:true in hooks.json is what makes CC feed it back as context
  // instead of terminating. Exiting 0 silently downgrades the block to a no-op.
  export function blockExit(reason: string): never {
    process.stderr.write(reason);
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    process.exit(2);
  }
  ```

- **file-checker.ts current pattern** (`src/hooks/file-checker.ts:70-82`): the entry-point `main()` calls `processFileCheck()` and if the result is non-null, outputs `hint("PostToolUse", result)` via `output()`. Replace with `blockExit(result)`. `processFileCheck()` stays unchanged (returns a string or null). Tests should call `processFileCheck()` directly, not `main()`, to avoid the `process.exit(2)` in tests — consistent with the sentinal-testing.md pattern.

- **Plugin length** (`targets/opencode/plugins/sentinal.ts`): 1,116 lines, explicitly exempt from block thresholds. Extract the adaptor implementation to `src/opencode/workspace-adaptor.ts` (testable) and keep only the 3-line registration in `sentinal.ts`.

- **Worktree create via CLI in plugin**: since plugins run in Node.js (not Bun), `WorktreeManager` (which uses `Bun.spawnSync`) is not directly invocable. Use the `$` shell helper (`$\`sentinal worktree create ${slug} --project ${dir}\``) or call the sidecar if a create route is added. Prefer the `$`approach — it's the pattern already used in`autoStartProcess`.

- **Gotchas:**
  - `configure()` is called during workspace configuration UI — it must be fast (no blocking git ops). If sidecar unavailable, read `compact-state.json` synchronously.
  - `create()` is called when the user confirms workspace creation — git ops are fine here.
  - `target()` is called to resolve the working directory for each workspace session — must return quickly. If worktree path doesn't exist yet (pre-create), return the project root as a fallback.
  - The `extra` field on `WorkspaceInfo` is `unknown | null` — store the plan path as `extra: { planPath: string }` and cast on read.

## Assumptions

- `experimental_workspace.register()` is available in the `@opencode-ai/plugin` v1.4.4+ SDK (confirmed in `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`) — Task 1 depends on this.
- `continueOnBlock: true` in hooks.json is supported on CC 2.1.139+ (confirmed in changelog re-audit) — Task 3 depends on this. On older CC versions it is silently ignored — backwards-compatible.
- WorktreeManager.create() is not safe to call from a Node.js context (uses Bun.spawnSync) — Task 1 uses `$` shell or a future sidecar route — Task 1 depends on this.
- The plugin's `PluginContext.experimental_workspace` is present on every init call (per SDK type) — no runtime guard needed — Task 1 depends on this.

## Testing Strategy

- **Unit:** `src/opencode/workspace-adaptor.test.ts` — configure() with active spec + no-spec fallback, target() with and without existing worktree, create() spawns correct sentinal command, remove() calls sidecar correctly. Use spies to avoid real git/sidecar calls.
- **Unit:** `src/utils/hook-output.test.ts` — extend with continueOnBlock output shape test.
- **Unit:** `src/hooks/file-checker.test.ts` — verify output is `{ decision:"block", reason:... }` when violations found (not `hint`).
- **Integration:** `bun test targets/opencode/` — plugin still builds and passes existing tests.
- **Manual:** Create a workspace in OpenCode, verify "Sentinal Spec Worktree" appears; select it while a spec is active, verify name is pre-filled.

## Risks and Mitigations

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                         |
| -------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `experimental_workspace` not present at runtime (old OC version)     | Low        | Medium | Guard: `if (context.experimental_workspace)` before registering                                                    |
| `continueOnBlock` on old CC version causes unexpected behaviour      | Low        | Low    | CC silently ignores unknown hooks.json fields — backwards-compatible                                               |
| Worktree create via `$` shell fails in plugin context                | Medium     | Medium | Fallback: return early from `create()` with a user-facing error log                                                |
| `target()` returns stale directory after worktree is abandoned       | Medium     | Medium | Reconcile via `resolveWithReconcile()` (added in bugfix plan) — already handles this                               |
| `sentinal` binary not in PATH in OpenCode plugin context (macOS GUI) | Medium     | Medium | Runtime check in `create()` — logs error and returns without throwing; user sees a log message in plugin.debug.log |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **`experimental_workspace` is not in `PluginInput` at runtime despite being in the type** (Task 1) → Trigger: `context.experimental_workspace` is `undefined` in the plugin init log. Mitigation: guard with `if (context.experimental_workspace)` and log a warning; the rest of the plugin still works.
2. **`configure()` is too slow / throws** (Task 1) → Trigger: OpenCode workspace creation UI hangs or shows error. Cause: sidecar call blocking or JSON parse failing. Fix: wrap in `try/catch` returning the original config unchanged; ensure sidecar call has a short timeout (1s).
3. **`continueOnBlock` changes file-checker behaviour in a way that causes test failures** (Task 3) → Trigger: existing `file-checker.test.ts` tests fail because they assert on `hint` output. Fix: update test assertions to expect `{ decision: "block" }` shape.

## Execution Waves

**Wave 1** — Section A foundation (single task): `src/opencode/workspace-adaptor.ts` + tests. Everything else in Section A depends on this module.
**Wave 2** — Section A wiring + Section B (parallel): plugin wiring (Task 2) and file-checker continueOnBlock (Task 3) are in disjoint files — can run concurrently.
**Wave 3** — Verify (single task): full suite, build:all, manual workspace smoke test.

## Goal Verification

### Truths

1. `src/opencode/workspace-adaptor.ts` exists and exports a `createSpecWorktreeAdaptor` function — grep `export function createSpecWorktreeAdaptor`
2. `targets/opencode/plugins/sentinal.ts` registers the adaptor — grep `experimental_workspace.*register\|register.*sentinal-spec-worktree`
3. `src/utils/hook-output.ts` does NOT export `hint` as the only blocking-style function — grep `continueOnBlock` in `src/utils/hook-output.ts`
4. `targets/claude-code/hooks/hooks.json` file-checker hook entry contains `"continueOnBlock": true`
5. `bun test src/opencode/workspace-adaptor.test.ts` passes
6. `bun run build:opencode` succeeds after plugin wiring changes

### Artifacts

| Artifact                                          | Provides                             | Exports                                          |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------ |
| `src/opencode/workspace-adaptor.ts`               | Spec worktree workspace adaptor      | `createSpecWorktreeAdaptor(sidecar)`             |
| `targets/opencode/plugins/sentinal.ts` (modified) | Adaptor registration at plugin init  | (plugin entry)                                   |
| `src/utils/hook-output.ts` (modified)             | continueOnBlock output helper        | `continueOnBlock(reason)`                        |
| `src/hooks/file-checker.ts` (modified)            | block-with-continue output           | `processFileCheck` (unchanged), `main()` updated |
| `targets/claude-code/hooks/hooks.json` (modified) | continueOnBlock flag on file-checker | config                                           |

### Key Links

| From                                   | To                                  | Via    | Pattern                   |
| -------------------------------------- | ----------------------------------- | ------ | ------------------------- |
| `targets/opencode/plugins/sentinal.ts` | `src/opencode/workspace-adaptor.ts` | import | `from.*workspace-adaptor` |
| `src/hooks/file-checker.ts`            | `src/utils/hook-output.ts`          | import | `continueOnBlock` usage   |
| `targets/claude-code/hooks/hooks.json` | file-checker hook                   | config | `continueOnBlock.*true`   |

## Progress Tracking

- [x] Task 1: Workspace adaptor implementation (Wave 1)
- [x] Task 2: Plugin registration wiring (Wave 2)
- [x] Task 3: file-checker continueOnBlock (Wave 2)
- [x] Task 4: Verify (Wave 3)
      **Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Implementation Tasks

### Task 1: Workspace adaptor implementation

**Objective:** Implement all four `WorkspaceAdaptor` methods in an extracted, testable module.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/opencode/workspace-adaptor.ts`
- Test: `src/opencode/workspace-adaptor.test.ts`

**Key Decisions / Notes:**

- Export: `createSpecWorktreeAdaptor(sidecar: SidecarClient | null, executor?: (cmd: string, args: string[]) => void): WorkspaceAdaptor`
- **DO NOT import from `@opencode-ai/plugin`** — the package lives at `~/.config/opencode/node_modules/`, not in sentinal's `node_modules/`, so `tsc` will reject it. Instead, **inline the 4 required types** as local interfaces at the top of `workspace-adaptor.ts` (the Context section of this plan has the full type definitions — copy them verbatim).

- **`configure(config)`:**
  1. Try `sidecar?.getCurrentSpec(config.directory ?? "")` with 1s abort signal
  2. Fallback: read `<config.directory>/.sentinal/compact-state.json` synchronously
  3. If spec found: return `{ ...config, name: \`spec/\${planSlug}\`, branch: \`sentinal/spec-\${planSlug}\`, extra: { planPath } }`
  4. If no spec: return config unchanged (user can edit name manually)
  5. Must not throw — catch + return original config

- **`target(config)`:**
  1. Extract `planSlug` from `config.extra?.planPath` or `config.name`
  2. Try `sidecar?.resolveWorktreeBySlug(planSlug, config.directory)` with `resolveWithReconcile`
  3. If found and path exists: return `{ type: "local", directory: wt.worktreePath }`
  4. Fallback: return `{ type: "local", directory: config.directory ?? "." }`

- **`create(config, from?)`:**
  1. Extract `planSlug` from `config.extra?.planPath`
  2. Invoke via an injectable `executor` parameter: `createSpecWorktreeAdaptor(sidecar, executor?)` where `executor` defaults to `(cmd: string, args: string[]) => { execSync(\`\${cmd} \${args.join(" ")}\`) }`using Node's`child_process.execSync`. This makes it mockable in tests without spawning real git.
  3. Call `executor("sentinal", ["worktree", "create", planSlug, "--project", config.directory ?? "."])`.
  4. Include a runtime check: if `execSync("sentinal --version")` fails, log a clear error (`"sentinal not in PATH — workspace creation unavailable"`) and return without throwing.
  5. On success: log `"workspace created: spec/\${planSlug}"`
  - **PATH note:** OpenCode plugins run in the OpenCode process whose PATH may differ from the user's shell (especially on macOS GUI). Mitigated by the runtime check + non-fatal error path. See also Risks table.

- **`remove(config)`:**
  1. Extract worktree ID via `resolveBySlug`
  2. Call `sidecar?.abandonWorktree(wt.id)` — already exists on SidecarClient
  3. Non-fatal if sidecar unavailable

- **Tests:** mock sidecar methods via `spyOn`; use tmp dirs for compact-state.json tests; don't spawn real git processes.

**Definition of Done:**

- [ ] All 4 adaptor methods implemented with tests
- [ ] configure() tested with sidecar hit + compact-state fallback + no-spec path
- [ ] target() tested with existing worktree + no-worktree path
- [ ] create() tested with mocked executor (no real git); PATH-missing error path tested
- [ ] remove() tested with mocked sidecar
- [ ] No `import from '@opencode-ai/plugin'` — all workspace types inlined
- [ ] No diagnostics errors

**Verify:** `bun test src/opencode/workspace-adaptor.test.ts`

---

### Task 2: Plugin registration wiring

**Objective:** Wire the adaptor into `targets/opencode/plugins/sentinal.ts` at plugin init.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`

**Key Decisions / Notes:**

- Extend the local `PluginContext` interface (line 75) to add:

  ```ts
  experimental_workspace?: {
    register(type: string, adaptor: WorkspaceAdaptor): void;
  };
  ```

  (Optional — `?` — so it degrades gracefully on older OC versions.)

- Import `createSpecWorktreeAdaptor` from `"../../../src/opencode/workspace-adaptor.js"`.

- In the plugin factory (around line 320, after sidecar connect), add:

  ```ts
  if (context.experimental_workspace) {
    context.experimental_workspace.register(
      "sentinal-spec-worktree",
      createSpecWorktreeAdaptor(sidecar),
    );
    log("workspace adaptor registered: sentinal-spec-worktree");
  }
  ```

- Import the `WorkspaceAdaptor` type inline (from the local interface in `workspace-adaptor.ts`) — do NOT import from `@opencode-ai/plugin` in the plugin file itself (creates a bundling dependency).

- Run `bun run build:opencode` to verify bundle is clean.

**Definition of Done:**

- [ ] `bun run build:opencode` succeeds
- [ ] `bun test targets/opencode/` passes
- [ ] `experimental_workspace` guard present — plugin works on OC without the API

**Verify:** `bun run build:opencode && bun test targets/opencode/`

---

### Task 3: file-checker continueOnBlock

**Objective:** Change file-checker's terminal output from `hint()` to a block-with-continue so Claude self-corrects rather than receiving an advisory that's easy to ignore.
**Dependencies:** None
**Wave:** 2

**Files:**

- Modify: `src/utils/hook-output.ts`
- Modify: `src/hooks/file-checker.ts`
- Modify: `targets/claude-code/hooks/hooks.json`
- Test: `src/utils/hook-output.test.ts` (extend)
- Test: `src/hooks/file-checker.test.ts` (update assertions)

**Key Decisions / Notes:**

- **`hook-output.ts`:** Add:

  ```ts
  // blockExit: soft-block + exit 2. The continueOnBlock:true in hooks.json (OUTER level) tells
  // CC to re-feed the reason as context rather than end the turn. Exit 0 would silently
  // downgrade to a no-op — exit 2 is required for CC to treat this as a block at all.
  export function blockExit(reason: string): never {
    process.stderr.write(reason);
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    process.exit(2);
  }
  ```

- **`file-checker.ts` `main()`:** Replace `output(hint("PostToolUse", result))` with `blockExit(result)`. `processFileCheck()` is unchanged.

- **`hooks.json`:** Add `"continueOnBlock": true` to the **outer** matcher object (same level as `matcher` and `if`), NOT inside the `hooks: [...]` command descriptor:

  ```json
  {
    "matcher": "Write|Edit|MultiEdit",
    "if": "Write(*.ts)|...",
    "continueOnBlock": true,
    "hooks": [
      {
        "type": "command",
        "command": "sentinal",
        "args": ["hook", "claude", "file-checker"],
        "timeout": 10
      }
    ]
  }
  ```

- **Test strategy:** test `processFileCheck()` return values and `blockExit()` shape in isolation — do NOT call `main()` in unit tests (it calls `process.exit(2)`). This is consistent with the sentinal-testing.md pattern ("test them by feeding a HookInput through the exported function directly").

**Definition of Done:**

- [ ] All tests pass (`blockExit` helper shape tested; `processFileCheck` assertions updated)
- [ ] No diagnostics errors
- [ ] hooks.json valid JSON with `continueOnBlock: true` at the outer matcher level

**Verify:** `bun test src/hooks/file-checker.test.ts src/utils/hook-output.test.ts && python3 -m json.tool targets/claude-code/hooks/hooks.json`

---

### Task 4: Verify

**Objective:** Full suite + both targets build + manual workspace smoke test.
**Dependencies:** Tasks 1-3
**Wave:** 3

**Files:** None (verification only)

**Definition of Done:**

- [ ] `bun test` fully green
- [ ] `bunx tsc --noEmit` — no new errors in `src/`
- [ ] `bun run build:all` succeeds
- [ ] Manual: OpenCode workspace creation shows "Sentinal Spec Worktree" option
- [ ] Manual: With an active spec, configure() pre-fills the workspace name

**Verify:** `bun test && bunx tsc --noEmit && bun run build:all`
