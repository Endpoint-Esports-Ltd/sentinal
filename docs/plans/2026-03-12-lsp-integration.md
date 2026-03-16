# LSP Integration — Rules, Skills, and Spec-Aware Analysis Tools

Created: 2026-03-12
Status: VERIFIED
Approved: No
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Teach Sentinal agents to effectively use the LSP tools already provided by their runtimes (Claude Code's `LSP` tool, OpenCode's `lsp` tool), and add two spec-aware MCP tools that leverage Sentinal's persistent state (SQLite settings cache, active spec context) to provide analysis that bash commands alone cannot replicate.

**Architecture:** No new LSP server process. Both Claude Code and OpenCode already start and manage their own language servers (vtsls/typescript-language-server/Angular LS). Sentinal adds: (1) new rules teaching agents when and how to use LSP tools, (2) updated spec-implement/spec-verify skills that integrate LSP into TDD and verification workflows, (3) two spec-aware MCP tools in `src/analysis/mcp-tools.ts` — `check_diagnostics` (tsc with delta tracking and spec-file filtering) and `impact_analysis` (change impact with plan-context cross-referencing and risk scoring). These tools use `{ client, store }` deps to access the active spec and cache results in the `settings` table.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk`, Zod

**Why MCP tools and not bash?** Both tools leverage Sentinal's persistent state in ways bash cannot replicate:

- `check_diagnostics` caches previous tsc results in SQLite and reports **deltas** ("2 new errors since last check, 1 fixed"). An agent running `npx tsc --noEmit` has no memory of prior runs.
- `impact_analysis` cross-references `git diff` against the **active spec's task files** to flag unexpected changes, and checks **file length limits** — information only available through the sidecar/store.
- Both filter output to **plan-relevant files only** when an active spec exists, saving 140-740 tokens per invocation on medium-to-large projects (50-200 lines of tsc output reduced to 5-15 plan-relevant lines).

## Scope

### In Scope

- New `targets/*/rules/lsp-tools.md` rules file for both OpenCode and Claude Code
- Updated `spec-implement` skill/command to use LSP during TDD (call chain analysis, pre-edit diagnostics)
- Updated `spec-verify` skill/command to use LSP during verification (diagnostics, impact analysis)
- New `src/analysis/mcp-tools.ts` with 2 spec-aware MCP tools: `check_diagnostics`, `impact_analysis`
- Updated `targets/*/rules/cli-tools.md` with analysis tool entries
- Tests for analysis MCP tools

### Out of Scope

- Running our own LSP server process (runtimes already handle this)
- Modifying the sidecar to manage LSP lifecycle
- LSP support for non-TypeScript languages (future work)
- Replacing the runtime's native LSP tools
- Call chain tracing tool (agents should use runtime LSP `findReferences`/`incomingCalls`/`outgoingCalls` for this — grep-based call chain has poor accuracy and the complexity of a tsconfig-aware import resolver is not justified)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Runtime LSP tools:** Claude Code exposes a single `LSP` tool (uppercase). OpenCode exposes a single `lsp` tool (lowercase) with an `operation` parameter: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`. Both runtimes also push diagnostics passively after file edits.
- **Sentinal's MCP tool pattern:** See `src/tdd/mcp-tools.ts` — `registerTddTools(server, deps: TddToolsDeps)` registers tools via `server.tool(name, description, zodSchema, handler)`. Return format: `{ content: [{ type: "text", text: string }] }`. All register functions take `(server: McpServer, deps: XToolsDeps)` — this is a hard convention.
- **The analysis MCP tools use `{ client, store }` deps.** They need store access for: (a) reading the active spec via `SpecStore.getCurrentSpec()` to know which files are plan-relevant, (b) caching diagnostics results via `store.getSetting()`/`store.setSetting()` for delta tracking. When `client` is available, they delegate to sidecar equivalents.
- **Settings table for caching:** `MemoryStore` has a generic `settings` table (key-value, `store.getSetting(key): string | null`, `store.setSetting(key, value): void`). Used for caching diagnostics baselines with keys like `diagnostics:<project-hash>`.
- **Existing tsc integration:** `src/checkers/typescript.ts` already runs `Bun.spawnSync(["npx", "tsc", "--noEmit"])`. The analysis tool uses the same pattern but async (`Bun.spawn`) with timeout.
- **Rules file pattern:** See `targets/claude-code/rules/cli-tools.md` and `targets/opencode/rules/cli-tools.md` — identical content. Rules are markdown files installed into `~/.config/opencode/rules/` or `.claude/rules/`.
- **Skill file pattern:** See `targets/opencode/skills/spec-implement/SKILL.md` and `targets/claude-code/commands/spec-implement.md` — nearly identical content. Both describe TDD workflow steps.
- **File length limits:** 400 lines warning, 600 lines block. Test files exempt.
- **routes.ts is at 398 lines** — no new sidecar routes needed for this plan (analysis tools use store directly, not sidecar HTTP).

## Assumptions

- Both Claude Code and OpenCode have LSP tools available in most agent sessions — supported by `ENABLE_LSP_TOOL: "true"` in Claude Code settings and `lsp` config in OpenCode's opencode.json
- `npx tsc --noEmit` is available in TypeScript projects — supported by `typescript` being a devDependency in most TS projects
- Agents benefit from being told when to use LSP — supported by observation that agents rarely use LSP proactively without prompting
- The `settings` table is suitable for caching diagnostics baselines (small JSON payloads, no TTL needed — overwritten each run)
- LSP availability is not guaranteed in all contexts (CI, headless). Skill instructions must always include a fallback path.

## Testing Strategy

- **Unit tests for analysis MCP tools:** `src/analysis/mcp-tools.test.ts` — mock `Bun.spawn` for tsc/git calls, mock MemoryStore for settings cache, test output formatting, test delta calculation, test spec-aware filtering, test 30s timeout behavior
- **No integration tests needed** — tools run tsc/git which are standard CLI tools
- **Manual verification:** Test rules and skill updates by running a spec workflow and checking that LSP usage is prompted

## Risks and Mitigations

| Risk                                                                   | Likelihood | Impact | Mitigation                                                                                                         |
| ---------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `tsc --noEmit` is slow on large projects (>10s)                        | Medium     | Low    | 30s timeout with kill + partial results. Filter to changed files when possible.                                    |
| Agents ignore LSP rules                                                | Medium     | Low    | Make LSP usage explicit in TDD steps (Step 2.3) with specific operation names, not just "use LSP"                  |
| Runtime LSP tool names change                                          | Low        | Medium | Rules reference tool names with both variants (Claude Code and OpenCode)                                           |
| Settings cache grows unbounded                                         | Low        | Low    | Each project gets one key (`diagnostics:<hash>`), overwritten each run. No accumulation.                           |
| Agent uses `check_diagnostics` instead of native tsc for simple checks | Medium     | Low    | Tool description emphasizes it's for delta tracking and spec-filtered output, not a replacement for `tsc --noEmit` |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Agents still don't use LSP** (Tasks 1-2) → Trigger: After implementing, run a spec workflow and observe zero LSP tool calls in the transcript. Fix: Make LSP calls mandatory in specific TDD steps (RED verification, pre-commit check).
2. **Delta tracking doesn't help in practice** (Task 3) → Trigger: Agents call `check_diagnostics` but ignore the delta information. Fix: Make delta the primary output ("2 NEW errors") with full list secondary.
3. **Impact analysis is ignored** (Task 3) → Trigger: Agents don't call `impact_analysis` during verification. Fix: Make it a required step in spec-verify (Step 3.2) rather than optional.

## Goal Verification

### Truths

1. After this change, running `/spec-implement` on a TypeScript project results in at least one LSP tool call during the TDD RED phase
2. The `check_diagnostics` MCP tool returns a formatted summary of TypeScript errors filtered to plan-relevant files, with a delta from the previous run
3. The `impact_analysis` MCP tool returns changed files cross-referenced against the active spec's task files, with risk scoring and file length warnings
4. The rules files mention all 9 LSP operations and explain when to use each
5. The spec-verify workflow uses `impact_analysis` as part of automated checks
6. Skill instructions include explicit fallback paths for when LSP is unavailable

### Artifacts

- `src/analysis/mcp-tools.ts` — Spec-aware analysis MCP tools (2 tools)
- `src/analysis/mcp-tools.test.ts` — Tests
- `targets/*/rules/lsp-tools.md` — LSP usage rules (both platforms)
- `targets/*/rules/cli-tools.md` — Updated with analysis tool entries
- `targets/*/skills/spec-implement/SKILL.md` and `targets/claude-code/commands/spec-implement.md` — Updated TDD workflow
- `targets/*/skills/spec-verify/SKILL.md` and `targets/claude-code/commands/spec-verify.md` — Updated verification

### Key Links

1. `src/analysis/mcp-tools.ts` ↔ `src/mcp/server.ts` (tool registration)
2. `src/analysis/mcp-tools.ts` ↔ `src/spec/store.ts` (active spec context via SpecStore.getCurrentSpec)
3. `src/analysis/mcp-tools.ts` ↔ `src/memory/store.ts` (settings cache via getSetting/setSetting)
4. `targets/*/rules/lsp-tools.md` ↔ `targets/*/skills/spec-implement/` (rules inform skill behavior)
5. `src/analysis/mcp-tools.ts` ↔ TypeScript compiler (`tsc --noEmit`) — external dependency

## Progress Tracking

- [x] Task 1: Create LSP rules files
- [x] Task 2: Update spec-implement skill/command with LSP integration
- [x] Task 3: Create spec-aware analysis MCP tools
- [x] Task 4: Update spec-verify skill/command with LSP and analysis tool integration
- [x] Task 5: Wire MCP tools and update exports
- [x] Task 6: Update cli-tools rules
- [x] Task 7: Build, update, and verify
      **Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: Create LSP rules files

**Objective:** Create `lsp-tools.md` rules for both OpenCode and Claude Code that teach agents when and how to use LSP tools.

**Dependencies:** None

**Files:**

- Create: `targets/opencode/rules/lsp-tools.md`
- Create: `targets/claude-code/rules/lsp-tools.md`

**Key Decisions / Notes:**

- Both files should be nearly identical content, differing only in tool name casing (`lsp` vs `LSP`)
- Structure: When to use LSP (navigation, diagnostics, refactoring), operation reference table, examples for each operation, common patterns (e.g., "before renaming a symbol, use LSP to find all references first")
- Cover all 9 OpenCode operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls
- Note that diagnostics are pushed passively after edits — no explicit tool call needed for basic error checking
- Include the pattern: "Before editing an implementation file, use LSP hover/definition to understand the type signature and callers"
- Mention that LSP availability depends on having the right language server configured
- Note: for call chain analysis, prefer LSP `findReferences`/`incomingCalls`/`outgoingCalls` over grep — they handle aliases, re-exports, and dynamic calls correctly

**Definition of Done:**

- [ ] `targets/opencode/rules/lsp-tools.md` exists with operation reference and usage patterns
- [ ] `targets/claude-code/rules/lsp-tools.md` exists with same content adjusted for Claude Code
- [ ] Both files are under 100 lines (concise reference, not a tutorial)

**Verify:**

- `wc -l targets/*/rules/lsp-tools.md`
- Visual review of content

---

### Task 2: Update spec-implement skill/command with LSP integration

**Objective:** Add LSP tool usage to the TDD workflow in Step 2.3 so agents use LSP for call chain analysis, type checking, and pre-edit understanding.

**Dependencies:** Task 1

**Files:**

- Modify: `targets/opencode/skills/spec-implement/SKILL.md` (~5 lines added)
- Modify: `targets/claude-code/commands/spec-implement.md` (~5 lines added)

**Key Decisions / Notes:**

- In Step 2.3 (TDD Loop), item 3 says "Call chain analysis: Trace callers (upwards), callees (downwards), side effects". Add: "Use LSP `findReferences` / `incomingCalls` / `outgoingCalls` for accurate call chain analysis. If LSP unavailable, use grep as fallback."
- Before the RED phase (between items 4 and 5): add "Use LSP `hover` on the function/method you're about to test to confirm the current type signature. If LSP unavailable, read the source file directly."
- In item 8 ("Check diagnostics — zero errors"): add "Use `check_diagnostics` MCP tool for spec-filtered diagnostics with delta tracking, or `npx tsc --noEmit` directly."
- Keep additions minimal — 1-2 lines per insertion point, not paragraphs
- Every LSP instruction MUST include a fallback path ("If LSP unavailable, ...")

**Definition of Done:**

- [ ] spec-implement SKILL.md references LSP in call chain analysis step with fallback
- [ ] spec-implement SKILL.md references LSP hover before RED phase with fallback
- [ ] spec-implement SKILL.md references `check_diagnostics` in diagnostics step
- [ ] Claude Code command file has identical additions
- [ ] Additions are concise (no more than 2 lines each)

**Verify:**

- `grep -c 'LSP\|lsp' targets/opencode/skills/spec-implement/SKILL.md` (should find new references)
- `grep -c 'LSP\|lsp' targets/claude-code/commands/spec-implement.md`
- `grep 'unavailable\|fallback' targets/opencode/skills/spec-implement/SKILL.md` (every LSP ref has fallback)

---

### Task 3: Create spec-aware analysis MCP tools

**Objective:** Create `src/analysis/mcp-tools.ts` with 2 tools that leverage Sentinal's persistent state for analysis that bash commands cannot replicate.

**Dependencies:** None

**Files:**

- Create: `src/analysis/mcp-tools.ts` (~250 lines)
- Create: `src/analysis/mcp-tools.test.ts` (~250 lines)

**Key Decisions / Notes:**

**`check_diagnostics`:**

- Parameters: `project` (string, path to project root)
- Deps: `{ client, store }` — needs store for settings cache and active spec lookup
- Runs `Bun.spawn(["npx", "tsc", "--noEmit", "--pretty", "false"])` with 30s timeout
- Parses tsc output into `{ file, line, column, severity, message }[]`
- Reads active spec via `SpecStore.getCurrentSpec(project)` → if active, filters errors to only files listed in spec task descriptions (the `Files:` section). Non-spec errors shown as a count summary ("12 other errors in 8 non-spec files").
- Caches result in settings table: key `diagnostics:<projectHash>`, value JSON `{ timestamp, errorCount, errors: [{ file, line, message }] }`. Uses `store.setSetting()` / `store.getSetting()`.
- On subsequent calls, computes delta: "2 NEW errors (auth.service.ts:45, user.dto.ts:12). 1 FIXED (routes.ts:98). 9 unchanged."
- Returns formatted markdown with: delta summary (primary), spec-relevant errors (detailed), non-spec error count (summary), total count.
- Timeout handling: if tsc takes >30s, kill process and return `"TIMEOUT: tsc did not complete within 30s. Run npx tsc --noEmit directly for full output."` with any partial stderr.

**`impact_analysis`:**

- Parameters: `project` (string, path to project root)
- Deps: `{ client, store }` — needs store for active spec and file length checking
- Runs `Bun.spawn(["git", "diff", "--name-only", "HEAD"], { cwd: project })` to get changed files. If a worktree is active (detected via spec metadata), uses `git diff --name-only <base-branch>...HEAD` for full spec-scope diff.
- Runs `Bun.spawn(["git", "diff", "--stat", "HEAD"], { cwd: project })` for insertion/deletion counts.
- For each changed `.ts` file: reads file, extracts exported symbols (regex: `export (function|class|const|interface|type|enum) (\w+)`), counts lines.
- Cross-references against active spec task files:
  - Files in spec tasks → "expected" (green)
  - Files NOT in spec tasks → "unexpected" (yellow warning: "WARNING: routes.ts modified but not listed in any task's Files section")
- File length check: flags any changed file over 400 lines ("WARNING: routes.ts is 412 lines (over 400-line limit)")
- For changed files, runs `grep -rn "from ['\"].*<changed-file>" --include="*.ts" <project>/src/` to find importers. Reports count: "5 files import from auth.service.ts"
- Risk score: LOW (only expected files, no limit violations), MEDIUM (expected files + dependents, no violations), HIGH (unexpected files or limit violations)
- Returns formatted markdown: risk score, expected vs unexpected file table, file length warnings, importer summary, total stats

**Common patterns (both tools):**

- Signature: `registerAnalysisTools(server: McpServer, deps: AnalysisToolsDeps): void` where `AnalysisToolsDeps = { client?: SidecarClient | null; store?: MemoryStore | null }`
- Error handling: wrap all Bun.spawn calls in try/catch. If tsc/git not found, return helpful error ("tsc not found — ensure typescript is a devDependency")
- Use `Bun.spawn` (async) not `Bun.spawnSync` for timeout support
- projectHash for cache key: use `Bun.hash(project)` or a simple string hash of the project path

**Definition of Done:**

- [ ] `check_diagnostics` runs tsc, filters to spec-relevant files, returns delta from cached baseline
- [ ] `check_diagnostics` caches results in settings table
- [ ] `check_diagnostics` handles 30s timeout gracefully (kills process, returns timeout message)
- [ ] `impact_analysis` shows changed files cross-referenced against active spec tasks
- [ ] `impact_analysis` flags unexpected files not listed in spec tasks
- [ ] `impact_analysis` warns on files over 400-line limit
- [ ] `impact_analysis` reports risk score (LOW/MEDIUM/HIGH)
- [ ] Both tools handle errors gracefully (missing tsc/git, no active spec, empty diff)
- [ ] Tests cover: happy path, no active spec fallback, delta calculation, timeout scenario, unexpected file detection, file length warning
- [ ] Tests pass: `bun test src/analysis/mcp-tools.test.ts`
- [ ] No TypeScript errors

**Verify:**

- `bun test src/analysis/mcp-tools.test.ts`
- `npx tsc --noEmit`

---

### Task 4: Update spec-verify skill/command with LSP and analysis tool integration

**Objective:** Add LSP-based checks and analysis tool usage to the verification workflow, specifically in Step 3.2 (Automated Checks).

**Dependencies:** Task 3

**Files:**

- Modify: `targets/opencode/skills/spec-verify/SKILL.md` (~4 lines added)
- Modify: `targets/claude-code/commands/spec-verify.md` (~4 lines added)

**Key Decisions / Notes:**

- In Step 3.2 (Automated Checks), after item 2 ("TypeScript compiler — `npx tsc --noEmit`"), add: "Use `check_diagnostics` MCP tool for spec-filtered diagnostics with delta tracking. If it reports new errors, fix them before proceeding."
- In Step 3.2, after item 7 ("File length"), add: "Use `impact_analysis` MCP tool to identify unexpected file changes not listed in the plan and verify file length limits. Address any HIGH risk findings before proceeding."
- In Step 3.10 (Final Regression Check): add "Run `check_diagnostics` to confirm zero delta (no new errors introduced during Phase B fixes)."
- Every LSP-referencing instruction MUST include a fallback path
- Keep additions minimal and actionable

**Definition of Done:**

- [ ] spec-verify references `check_diagnostics` after TypeScript compiler check
- [ ] spec-verify references `impact_analysis` after file length check
- [ ] spec-verify references `check_diagnostics` in final regression check
- [ ] Claude Code verify command has identical additions
- [ ] All additions include fallback for when MCP tools unavailable
- [ ] Additions are concise

**Verify:**

- `grep -c 'check_diagnostics\|impact_analysis' targets/opencode/skills/spec-verify/SKILL.md`
- `grep -c 'check_diagnostics\|impact_analysis' targets/claude-code/commands/spec-verify.md`

---

### Task 5: Wire MCP tools and update exports

**Objective:** Register analysis tools in the MCP server and add exports to `src/index.ts`.

**Dependencies:** Task 3

**Files:**

- Modify: `src/mcp/server.ts` (~3 lines: import + register call)
- Modify: `src/index.ts` (~3 lines: exports)

**Key Decisions / Notes:**

- `registerAnalysisTools(server, { client, store })` — follows the `(server, deps)` convention used by all other register functions
- Add after `registerTddTools` in server.ts
- Export `registerAnalysisTools` and `AnalysisToolsDeps` from `src/index.ts` under a new `# Analysis Tools` section
- Stay at version 0.4.0 — additive, non-breaking change

**Definition of Done:**

- [ ] `registerAnalysisTools` imported and called in `createSentinalServer` with `{ client, store }` deps
- [ ] `registerAnalysisTools` and `AnalysisToolsDeps` exported from `src/index.ts`
- [ ] `bun test src/mcp/` passes
- [ ] No TypeScript errors

**Verify:**

- `bun test src/mcp/`
- `npx tsc --noEmit`

---

### Task 6: Update cli-tools rules

**Objective:** Add analysis MCP tools to the MCP tools table in cli-tools.md.

**Dependencies:** Task 3

**Files:**

- Modify: `targets/opencode/rules/cli-tools.md` (~2 lines)
- Modify: `targets/claude-code/rules/cli-tools.md` (~2 lines)

**Key Decisions / Notes:**

- Add 2 new rows to the MCP tools table:
  - `check_diagnostics` | `npx tsc --noEmit` | Spec-filtered TypeScript diagnostics with delta tracking
  - `impact_analysis` | `git diff` + manual review | Spec-aware change impact analysis with risk scoring

**Definition of Done:**

- [ ] Both cli-tools.md files have the 2 new analysis tool entries
- [ ] Entries are consistent with existing table format

**Verify:**

- `grep 'check_diagnostics\|impact_analysis' targets/*/rules/cli-tools.md`

---

### Task 7: Build, update, and verify

**Objective:** Rebuild embedded assets, compile binary, sign, update installations, run full test suite.

**Dependencies:** All previous tasks

**Files:**

- Auto-generated: `src/cli/embedded-assets.ts`
- Binary: `dist/sentinal`

**Key Decisions / Notes:**

- Build: `bun run build:cli`
- Sign: `codesign -f -s - ~/.sentinal/bin/sentinal`
- Update: `sentinal update`
- Test: `bun test` (expect 2 pre-existing sidecar failures)
- Typecheck: `npx tsc --noEmit`

**Definition of Done:**

- [ ] `bun run build:cli` succeeds
- [ ] Binary signed and installed
- [ ] `sentinal update` propagates changes
- [ ] `bun test` — zero new failures
- [ ] `npx tsc --noEmit` — zero errors

**Verify:**

- `bun test`
- `npx tsc --noEmit`
- `sentinal --version`
