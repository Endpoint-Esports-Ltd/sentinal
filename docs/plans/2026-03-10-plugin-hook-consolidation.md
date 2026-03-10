# Plugin & Hook Consolidation Plan

Created: 2026-03-10
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: docs/plans/2026-03-09-market research-parity.md

## Summary

**Goal:** Fix two bugs (OpenCode `/spec` commands silently failing; `Cannot find module @endpoint/sentinal` error) and consolidate both targets to route through the `sentinal` binary and Bun-installed `@endpoint/sentinal` package, eliminating file-copying and compiled-JS distribution during installation.

**Architecture change:**
- **Claude Code hooks:** `sentinal hook shared|claude <name>` replaces `bun "${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/<name>.js"` — all hooks become CLI subcommands in the compiled binary
- **OpenCode plugin:** `@endpoint/sentinal/opencode-plugin` subpath export replaces copied `.ts` file — OpenCode auto-installs via `bun install` at startup (package published to private npm-compatible registry, but always installed/resolved by Bun)
- **OpenCode custom tool (`sentinal-check`):** Inlined into the plugin's `tool` property — no separate file
- **Command generator:** Regex fix so OpenCode gets `/spec-plan` instead of `Skill()`

**Root causes being fixed:**
1. `scripts/generate-commands.js:49` — regex `\w+` doesn't match hyphens in skill names, so OpenCode command files contain unresolvable `Skill()` syntax
2. Installer copies raw `.ts` source files that import `@endpoint/sentinal`, but Bun can't resolve the bare specifier because no `node_modules/` exists at the plugin load path (and `npm i -g` installs to a different global location than Bun searches)

## Scope

### In Scope
- Fix command generator regex (Issue 1)
- Add `sentinal hook shared <name>` subcommand (9 hooks)
- Add `sentinal hook claude <name>` subcommand (3 hooks)
- Update Claude Code `hooks.json` to use `sentinal hook`
- Export OpenCode plugin from `@endpoint/sentinal` package (Bun-installed)
- Inline `sentinal-check` tool into the OpenCode plugin
- Simplify both installers (no compiled JS, no plugin file copying)
- Bundled `.js` fallback for offline/airgapped OpenCode environments

### Out of Scope
- `sentinal hook opencode` subcommands — OpenCode plugin is in-process (holds state across invocations, accesses `client` API); subprocess hooks would lose these advantages
- Changing the OpenCode plugin's core architecture (it remains an importable TS module)
- Authentication or registry setup for `@endpoint` scoped packages

## Context for Implementer

**Why no `sentinal hook opencode` subcommands:**
The OpenCode plugin runs **in-process** within Bun. It holds state across hook invocations: `eventBuffer` (in-memory), `memoryStore` (shared connection), `sessionId`, `toolCallCount`. It accesses OpenCode's `client` API (e.g., `client.session.messages()` for real token counts). Converting to subprocess calls would lose all of this. Instead, OpenCode loads the plugin as a module and calls shared functions directly (e.g., `processTddGuard()`, `processTddTracking()`, `restoreContext()`).

**Hook categorization logic:**

| Category | Criteria | Count |
|----------|----------|-------|
| `shared` | Core logic is target-agnostic; both targets use the same underlying functions | 9 |
| `claude` | Logic references Claude Code-specific tool names, conventions, or capabilities | 3 |

**Key files:**
- `src/hooks/*.ts` — All 12 hook implementations (each has `main()` with `if (import.meta.main)`)
- `src/utils/hook-output.ts` — Shared stdin/stdout protocol helpers (`readStdin`, `deny`, `hint`, `block`, `output`)
- `targets/claude-code/hooks/hooks.json` — Hook dispatch configuration
- `targets/opencode/plugins/sentinal.ts` — OpenCode plugin (in-process module, 484 lines)
- `targets/opencode/tools/sentinal-check.ts` — Standalone custom tool (217 lines, to be inlined)
- `scripts/generate-commands.js` — Command template generator
- `src/cli/index.ts` — CLI entry point
- `src/cli/commands/install.ts` — Unified installer (596 lines)
- `package.json` — Package exports and scripts

**Conventions:**
- Hooks read `HookInput` JSON from stdin, write optional JSON to stdout
- Exit code 0 = pass/hint, exit code 2 = deny/block
- Hooks are stateless per invocation (unlike the OpenCode plugin which is stateful)
- `sentinal` binary expected on PATH (installed via `bun add -g @endpoint/sentinal`; must use Bun, not npm — Bun and npm install to different global locations and do not share module resolution)

## Progress Tracking

### Phase 1: Bug Fixes (Issues 1 & 2)
- [x] Task 1: Fix command generator regex
- [x] Task 2: Add `sentinal hook` CLI subcommand
- [x] Task 3: Update Claude Code hooks.json

### Phase 2: Architecture Migration
- [x] Task 4: Export OpenCode plugin from package + inline sentinal-check tool
- [x] Task 5: Update OpenCode config and simplify installer
- [x] Task 6: Build bundled fallback for offline environments
- [x] Task 7: Simplify Claude Code installer

**Total Tasks:** 7 | **Completed:** 7 | **Partial:** 0 | **Remaining:** 0

## Implementation Tasks

### Phase 1: Bug Fixes

### Task 1: Fix command generator regex

**Objective:** Fix the `\w+` regex in `generate-commands.js` so OpenCode command files get `/spec-plan $ARGUMENTS` instead of `Skill(skill='spec-plan', args='$ARGUMENTS')`.

**Files:**
- Modify: `scripts/generate-commands.js` — line 49: change `(\w+)` to `([\w-]+)`
- Modify: `templates/commands/spec.md` — line 46: make the "Only use X tools" instruction target-aware
- Regenerate: all 8 command files for both targets

**Definition of Done:**
- [x] Regex matches hyphenated skill names (`spec-plan`, `spec-implement`, `spec-verify`, `spec-bugfix-plan`, `spec-bugfix-verify`)
- [x] OpenCode `spec.md` contains `/spec-plan $ARGUMENTS` (zero `Skill()` references)
- [x] OpenCode `spec-plan.md` contains `/spec-implement <plan-path>` (not `Skill(...)`)
- [x] Claude Code `spec.md` still contains `Skill(skill='spec-plan', ...)` (unchanged)
- [x] All 8 command templates regenerated for both targets

### Task 2: Add `sentinal hook` CLI subcommand

**Objective:** Create a CLI subcommand that dispatches to all 12 hook handlers via `sentinal hook shared|claude <name>`.

**Files:**
- Create: `src/cli/commands/hook.ts` — Commander subcommand with two groups (`shared`, `claude`)
- Modify: `src/cli/index.ts` — Register the hook command
- Modify: each `src/hooks/*.ts` — Extract `run(input: HookInput)` function from each hook's `main()` (where not already exported)

**Hook subcommand mapping:**

**`sentinal hook shared`** (9 hooks):
| Subcommand | Source |
|------------|--------|
| `tdd-guard` | `src/hooks/tdd-guard.ts` |
| `tdd-tracker` | `src/hooks/tdd-tracker.ts` |
| `session-start` | `src/hooks/session-start.ts` |
| `session-end` | `src/hooks/session-end.ts` |
| `memory-observer` | `src/hooks/memory-observer.ts` |
| `memory-restore` | `src/hooks/memory-restore.ts` |
| `spec-stop-guard` | `src/hooks/spec-stop-guard.ts` |
| `pre-compact` | `src/hooks/pre-compact.ts` |
| `post-compact-restore` | `src/hooks/post-compact-restore.ts` |

**`sentinal hook claude`** (3 hooks):
| Subcommand | Source | Why Claude-specific |
|------------|--------|-------------------|
| `tool-redirect` | `src/hooks/tool-redirect.ts` | CC-specific tool names (`WebSearch`, `WebFetch`, `EnterPlanMode`, `ExitPlanMode`) |
| `file-checker` | `src/hooks/file-checker.ts` | OC re-implements inline with different checks |
| `context-monitor` | `src/hooks/context-monitor.ts` | CC uses transcript file size; OC uses API token counts |

**Definition of Done:**
- [x] `sentinal hook shared <name>` dispatches to all 9 shared hooks
- [x] `sentinal hook claude <name>` dispatches to all 3 Claude-specific hooks
- [x] stdin/stdout JSON protocol unchanged
- [x] Exit codes preserved (0 for pass/hint, 2 for deny/block)
- [x] Each hook's core logic extracted into a callable `run(input: HookInput)` function
- [x] `sentinal hook --help` lists all available hooks grouped by category

### Task 3: Update Claude Code hooks.json

**Objective:** Change all hook commands from `bun "${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/<name>.js"` to `sentinal hook shared|claude <name>`.

**Files:**
- Modify: `targets/claude-code/hooks/hooks.json`

**Mapping:**
| Old command | New command |
|-------------|-------------|
| `bun ".../post-compact-restore.js"` | `sentinal hook shared post-compact-restore` |
| `bun ".../memory-restore.js"` | `sentinal hook shared memory-restore` |
| `bun ".../session-start.js"` | `sentinal hook shared session-start` |
| `bun ".../tdd-guard.js"` | `sentinal hook shared tdd-guard` |
| `bun ".../tool-redirect.js"` | `sentinal hook claude tool-redirect` |
| `bun ".../tdd-tracker.js"` | `sentinal hook shared tdd-tracker` |
| `bun ".../file-checker.js"` | `sentinal hook claude file-checker` |
| `bun ".../memory-observer.js"` | `sentinal hook shared memory-observer` |
| `bun ".../context-monitor.js"` | `sentinal hook claude context-monitor` |
| `bun ".../pre-compact.js"` | `sentinal hook shared pre-compact` |
| `bun ".../spec-stop-guard.js"` | `sentinal hook shared spec-stop-guard` |
| `bun ".../session-end.js"` | `sentinal hook shared session-end` |

**Definition of Done:**
- [x] All 12 hooks reference `sentinal hook shared|claude <name>`
- [x] No references to `bun`, `${CLAUDE_PLUGIN_ROOT}`, or `hooks/dist/` remain
- [x] Timeout values preserved
- [x] Matchers unchanged

### Phase 2: Architecture Migration

### Task 4: Export OpenCode plugin from package + inline sentinal-check tool

**Objective:** Make `@endpoint/sentinal/opencode-plugin` loadable by OpenCode via Bun module resolution. Inline the `sentinal-check` custom tool into the plugin.

**Files:**
- Modify: `package.json` — Add subpath export `"./opencode-plugin"`
- Modify: `targets/opencode/plugins/sentinal.ts` — Add `tool` property to `PluginHooks` return value with the `sentinal-check` logic inlined
- Modify: `src/index.ts` — Add re-export of `SentinalPlugin` (fallback if OpenCode doesn't support subpath imports)

**package.json exports:**
```json
"exports": {
  ".": "./src/index.ts",
  "./opencode-plugin": "./targets/opencode/plugins/sentinal.ts"
}
```

**Plugin tool registration (added to returned PluginHooks):**
```ts
tool: {
  "sentinal-check": {
    description: "Run Sentinal quality checks on a file or directory...",
    args: { path: z.string(), verbose: z.boolean().optional() },
    async execute(args, context) { /* ... checkFile / findTsFiles logic ... */ },
  },
},
```

**Definition of Done:**
- [x] `import("@endpoint/sentinal/opencode-plugin")` resolves to the plugin module
- [x] Plugin's `default` export is the `SentinalPlugin` function
- [x] Plugin includes `sentinal-check` as a registered tool in the `tool` property
- [x] `targets/opencode/tools/sentinal-check.ts` logic fully merged into plugin
- [x] `src/index.ts` re-exports `SentinalPlugin` as fallback

### Task 5: Update OpenCode config and simplify installer

**Objective:** Update `opencode.json` to reference the Bun-resolved package plugin. Simplify installer.

**Files:**
- Modify: `targets/opencode/opencode.json` — Change `"plugin"` to Bun package reference
- Modify: `src/cli/commands/install.ts` — Remove plugin + tool file copying; keep command/rule markdown copying; add PATH validation

**opencode.json:**
```json
"plugin": ["@endpoint/sentinal/opencode-plugin"]
```
(OpenCode resolves this via Bun's module resolution — it auto-installs with `bun install` at startup, caching in `~/.cache/opencode/node_modules/`)

**Installer changes (OpenCode):**
- Keep: Validate `@endpoint/sentinal` is installed globally (via `bun add -g`)
- Keep: Copy command `.md` files to `.opencode/commands/`
- Keep: Copy rule `.md` files to `.opencode/rules/`
- Keep: Write/merge `opencode.json`
- Remove: Copy `sentinal.ts` to plugins directory
- Remove: Copy `sentinal-check.ts` to tools directory
- Add: Validate `sentinal` binary is on PATH

**Definition of Done:**
- [x] `opencode.json` references `@endpoint/sentinal/opencode-plugin` (resolved by Bun)
- [x] Installer no longer copies `sentinal.ts` or `sentinal-check.ts`
- [x] Installer still copies command and rule markdown files
- [x] Installer validates `sentinal` binary availability on PATH

### Task 6: Build bundled fallback for offline environments

**Objective:** Produce a self-contained `.js` bundle for when the package registry is unavailable.

**Files:**
- Modify: `package.json` — Ensure `build:opencode` bundles plugin with inlined sentinal-check tool
- Modify: `src/cli/commands/install.ts` — Add `--bundled` flag for offline installs

**Definition of Done:**
- [x] `bun run build:opencode` produces self-contained `.js` bundle including sentinal-check tool
- [x] `sentinal install opencode --bundled` copies bundle and writes file-path plugin reference
- [x] Default install (no flag) uses Bun-resolved package reference

### Task 7: Simplify Claude Code installer

**Objective:** Claude Code installer no longer needs to compile TypeScript or distribute `hooks/dist/`.

**Files:**
- Modify: `src/cli/commands/install.ts` — Remove `build:claude` step; add `sentinal` binary PATH validation

**Installer changes (Claude Code):**
- Keep: Copy `targets/claude-code/` to marketplace directory
- Keep: Register marketplace + install plugin
- Remove: `bun run build:claude` step
- Remove: `hooks/dist/` distribution
- Add: Validate `sentinal` binary is on PATH

**Definition of Done:**
- [x] Installer doesn't run `build:claude`
- [x] Marketplace directory doesn't contain or need `hooks/dist/`
- [x] `sentinal` binary availability validated during install

## Testing Strategy

- **Task 1:** Run generator, diff output, verify `Skill()` removed from OpenCode, preserved in Claude Code
- **Task 2:** Unit test each hook subcommand with mock stdin JSON; verify stdout + exit code
- **Task 3:** Manual test: install plugin, trigger hooks in Claude Code
- **Task 4:** `bun -e "import('@endpoint/sentinal/opencode-plugin').then(m => console.log(typeof m.default))"` — should print `function`
- **Task 5:** `sentinal install opencode` in test environment, verify OpenCode loads plugin
- **Task 6:** `bun run build:opencode && sentinal install opencode --bundled`
- **Task 7:** `sentinal install claude` without `bun run build:claude`, verify hooks work

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OpenCode doesn't support subpath imports (`@endpoint/sentinal/opencode-plugin`) | Medium | Low | Fallback: add default export to `src/index.ts`; use bare `@endpoint/sentinal` |
| `sentinal` binary not on PATH when Claude Code invokes hooks | Low | High | Installer validates PATH; could use absolute path as fallback |
| Binary startup overhead (~50ms) per hook invocation vs ~20ms for `bun <file>` | Low | Low | Hooks gated by matchers; 30ms difference negligible per tool call |
| Private package registry unavailable during OpenCode startup | Low | Medium | `--bundled` fallback; OpenCode caches in `~/.cache/opencode/node_modules/` after first install |
