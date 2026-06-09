# Awesome OpenCode Plugin Audit — Sentinal Integration Opportunities

Created: 2026-04-04
Status: PENDING
Approved: No
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Audit all 54 plugins in the awesome-opencode registry, identify companion plugins that complement Sentinal, and add coexistence detection + recommendation infrastructure so Sentinal yields gracefully to overlapping plugins and recommends complementary ones.

**Architecture:** Companion-first strategy — Sentinal does NOT rebuild features that already exist as mature OpenCode plugins. Instead, it (a) detects overlapping plugins and yields functionality, (b) recommends companion plugins via a new `sentinal companions` CLI command, and (c) documents integration notes in user-facing rules files.

**Tech Stack:** TypeScript, Bun, OpenCode plugin loader API, Node.js `fs` for config detection

---

## Plugin Catalog — 54 Plugins Across 13 Categories

### Category 1: Safety & Security (HIGH VALUE — Companion)

| Plugin              | Repo                              | What It Does                                                                                                                                                    | Sentinal Relationship                                                                   |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **CC Safety Net**   | `kenryu42/claude-code-safety-net` | PreToolUse hook blocking dangerous git (reset --hard, push --force, branch -D, stash clear) and fs (rm -rf, find -delete) commands with semantic shell analysis | **Companion** — fills major Sentinal gap (no bash safety), recommend alongside Sentinal |
| **Envsitter Guard** | `boxpositron/envsitter-guard`     | Blocks reads/edits of `.env*` files; provides metadata-only alternatives (keys, fingerprints, shape detection)                                                  | **Companion** — fills security gap (Sentinal has no secret guards), recommend alongside |

### Category 2: Observability (HIGH VALUE — Companion)

| Plugin                   | Repo                             | What It Does                                                                          | Sentinal Relationship                                                   |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **opencode-plugin-otel** | `DEVtheOPS/opencode-plugin-otel` | Exports 13 metrics + logs + resource attrs via OTLP/gRPC to Datadog/Honeycomb/Grafana | **Companion** — fills observability gap, recommend for team deployments |
| **Opencode Mystatus**    | `vbgate/opencode-mystatus`       | Checks AI subscription quotas across multiple providers                               | Overlap with Sentinal statusline — **coexistence**                      |

### Category 3: Context & Token Optimization

| Plugin                      | Repo                                            | What It Does                                                                                                                                                    | Sentinal Relationship                                                                   |
| --------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Context Analysis**        | `IgorWarzocha/Opencode-Context-Analysis-Plugin` | Visual token breakdown by category (system, user, tools, reasoning) with `/context` command, bar charts, local-only via js-tiktoken + @huggingface/transformers | **Adopt natively** — Sentinal gap, align with existing token-usage.ts infrastructure    |
| **Dynamic Context Pruning** | `Tarquinen/opencode-dynamic-context-pruning`    | Compression (range/message), deduplication, error purging — reduces token usage                                                                                 | **Companion** — complements Sentinal's session persistence, recommend for long sessions |
| **Opencode Quota**          | `slkiser/opencode-quota`                        | Toast notifications + `/quota` commands, tracks 10+ providers (Anthropic, GitHub Copilot, etc.)                                                                 | Overlap with Sentinal statusline — **coexistence**                                      |
| **opencode-snip**           | `VincentHardouin/opencode-snip`                 | Prefix commands with `snip` to reduce token consumption 60-90%                                                                                                  | **Companion** — niche but useful                                                        |

### Category 4: Memory & Agents

| Plugin                  | Repo                                      | What It Does                                                                                                                                                  | Sentinal Relationship                                                     |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Agent Memory**        | `joshuadavidthomas/opencode-agent-memory` | Letta-inspired self-editable memory blocks (Persona, Human, Project), markdown files with YAML frontmatter, `memory_list`/`memory_set`/`memory_replace` tools | Overlap with Sentinal memory — **coexistence**; mention as alternative UX |
| **Opencode Mem**        | `tickernelz/opencode-mem`                 | Persistent memory using local vector DB                                                                                                                       | Overlap with Sentinal vector memory — **coexistence**                     |
| **Agent Identity**      | `gotgenes/opencode-agent-identity`        | Agent self-identity and per-message attribution for multi-agent sessions                                                                                      | **Companion** — complements Sentinal sessions                             |
| **Background Agents**   | `kdcokenny/opencode-background-agents`    | Claude Code-style background agents with async delegation                                                                                                     | **Companion** — complements Sentinal worktree agents                      |
| **oh-my-opencode**      | `code-yeongyu/oh-my-opencode`             | Background agents + pre-built tools + Claude Code compatibility layer                                                                                         | **Companion** — CC compat layer is interesting for cross-platform         |
| **oh-my-opencode-slim** | `alvinunreal/oh-my-opencode-slim`         | Lightweight agent orchestration with reduced token usage                                                                                                      | **Companion** — lighter alternative                                       |
| **Opencode Sessions**   | `malhashemi/opencode-sessions`            | Session management with multi-agent collaboration                                                                                                             | Overlap with Sentinal sessions — **coexistence**                          |
| **Opencode Skills**     | `malhashemi/opencode-skills`              | Plugin for managing opencode skills                                                                                                                           | Overlap with Sentinal skills — **coexistence**                            |
| **Agent Skills (JDT)**  | `joshuadavidthomas/opencode-agent-skills` | Dynamic skills loader from project + plugin dirs                                                                                                              | Overlap — **coexistence**                                                 |
| **Openskills**          | `numman-ali/openskills`                   | Alternative skills management                                                                                                                                 | Overlap — **coexistence**                                                 |
| **Opencode Agent Tmux** | `AnganSamadder/opencode-agent-tmux`       | Real-time tmux panes for agents                                                                                                                               | **Companion** — niche but useful for power users                          |

### Category 5: Workflow & Spec

| Plugin                  | Repo                                  | What It Does                                                                                                                                     | Sentinal Relationship                                                                |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Micode**              | `vtemian/micode`                      | Brainstorm-Plan-Implement workflow with AST-aware tools (ast_grep_search, ast_grep_replace), git worktree isolation, implementer-reviewer cycles | Overlap with Sentinal /spec — **coexistence**; mention ast_grep tools as interesting |
| **OpenSpec**            | `Octane0411/opencode-plugin-openspec` | Dedicated OpenSpec Architect agent for planning, read-only on impl code during planning                                                          | Overlap with Sentinal spec-plan — **coexistence**                                    |
| **Opencode Roadmap**    | `IgorWarzocha/Opencode-Roadmap`       | Strategic roadmap planning + multi-agent coordination                                                                                            | **Companion** — fills roadmap gap                                                    |
| **Handoff**             | `joshuadavidthomas/opencode-handoff`  | `/handoff <goal>` command creates focused continuation prompt with file refs, key decisions, session link                                        | **Companion** — complements Sentinal pause/continue-here.md                          |
| **open-plan-annotator** | `ndom91/open-plan-annotator`          | Intercept plan mode, open annotation UI in browser                                                                                               | **Companion** — complements Sentinal dashboard                                       |
| **Plannotator**         | `backnotprop/plannotator`             | Plan review UI with visual annotation and offline sharing                                                                                        | **Companion** — complements Sentinal dashboard                                       |

### Category 6: Worktrees & Workspaces

| Plugin                 | Repo                            | What It Does                                            | Sentinal Relationship                             |
| ---------------------- | ------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| **Opencode Worktree**  | `kdcokenny/opencode-worktree`   | Zero-friction git worktrees with auto-spawned terminals | Overlap with Sentinal worktrees — **coexistence** |
| **Opencode Workspace** | `kdcokenny/opencode-workspace`  | Bundled multi-agent orchestration, 16 components        | Overlap — **coexistence**                         |
| **Devcontainers**      | `athal7/opencode-devcontainers` | Multi-branch devcontainers with auto-assigned ports     | **Companion**                                     |

### Category 7: Automation

| Plugin              | Repo                               | What It Does                                             | Sentinal Relationship                |
| ------------------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| **Pilot**           | `athal7/opencode-pilot`            | Automation daemon polling GitHub issues + Linear tickets | **Companion** — fills automation gap |
| **Beads Plugin**    | `joshuadavidthomas/opencode-beads` | Integration for Steve Yegge's beads issue tracker        | **Companion**                        |
| **Froggy**          | `smartfrog/opencode-froggy`        | Hooks + specialized agents + tools like gitingest        | **Companion** — gitingest is novel   |
| **Background**      | `zenobi-us/opencode-background`    | Background process management                            | **Companion**                        |
| **Direnv**          | `simonwjackson/opencode-direnv`    | Auto-loads direnv env vars at session start              | **Companion**                        |
| **Opencode Ignore** | `lgladysz/opencode-ignore`         | Ignore dirs/files by pattern                             | **Companion**                        |

### Category 8: Notifications

| Plugin               | Repo                         | What It Does                                | Sentinal Relationship                          |
| -------------------- | ---------------------------- | ------------------------------------------- | ---------------------------------------------- |
| **Opencode Notify**  | `kdcokenny/opencode-notify`  | Native OS notifications for task completion | Overlap with Sentinal notify — **coexistence** |
| **OpenCode ntfy.sh** | `lannuttia/opencode-ntfy.sh` | Push notifications via ntfy.sh service      | **Companion** — remote notification option     |

### Category 9: Tooling & Performance

| Plugin                  | Repo                                            | What It Does                                             | Sentinal Relationship                                           |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| **Morph Fast Apply**    | `JRedeker/opencode-morph-fast-apply`            | 10,500+ tokens/sec code editing via Morph Fast Apply API | **Companion** — speed boost, no overlap                         |
| **Model Announcer**     | `ramarivera/opencode-model-announcer`           | Inject current model name so LLM is self-aware           | **Companion** — Sentinal has model routing but not announcement |
| **Optimal Model Temps** | `Lyapsus/opencode-optimal-model-temps`          | Nudge models to preferred sampling temperature           | **Companion**                                                   |
| **Google AI Search**    | `IgorWarzocha/Opencode-Google-AI-Search-Plugin` | Query Google AI Mode (SGE)                               | **Companion**                                                   |

### Category 10: UI

| Plugin                | Repo                           | What It Does                                       | Sentinal Relationship |
| --------------------- | ------------------------------ | -------------------------------------------------- | --------------------- |
| **Opencode Canvas**   | `mailshieldai/opencode-canvas` | Interactive terminal canvases in tmux splits       | **Companion** — niche |
| **Opencode Snippets** | `JosXa/opencode-snippets`      | Instant inline text expansion for reusable prompts | **Companion**         |

### Category 11: Config & Sync

| Plugin              | Repo                                 | What It Does                                        | Sentinal Relationship                   |
| ------------------- | ------------------------------------ | --------------------------------------------------- | --------------------------------------- |
| **Opencode Synced** | `iHildy/opencode-synced`             | Sync global opencode configurations across machines | **Companion** — fills config sync gap   |
| **Plugin Template** | `zenobi-us/opencode-plugin-template` | CICD setup with generator + release automation      | **Out of scope** — development template |

### Category 12: Auth (Not Applicable)

All 7 auth plugins (Antigravity, Gemini, Kilo, Omniroute, OpenAI Codex, OpenHax Codex) are out of scope — Sentinal does not manage auth or model routing endpoints.

---

## Strategic Assessment

### Coexistence Targets (Detect and Yield)

Sentinal has existing functionality in these domains. When a coexistence-target plugin is detected, Sentinal should yield gracefully (similar to the statusline coexistence pattern):

1. **Sessions** — `malhashemi/opencode-sessions` overlaps with Sentinal sessions
2. **Skills** — `malhashemi/opencode-skills`, JDT, openskills overlap with Sentinal skills
3. **Worktree** — `kdcokenny/opencode-worktree` / workspace overlap with Sentinal worktree
4. **Spec workflow** — Micode, OpenSpec overlap with Sentinal `/spec`
5. **Memory** — Agent Memory, Opencode Mem overlap with Sentinal memory
6. **Notifications** — Opencode Notify overlaps with Sentinal notify
7. **Quota/statusline** — Opencode Quota, Mystatus overlap with Sentinal statusline

### Companion Recommendations (Complementary Install)

These plugins fill gaps in Sentinal and should be recommended for installation:

**Tier 1 (security + observability):**

1. **CC Safety Net** — destructive command protection (no Sentinal equivalent)
2. **Envsitter Guard** — `.env` secrets protection (no Sentinal equivalent)
3. **opencode-plugin-otel** — OpenTelemetry export (no Sentinal equivalent)

**Tier 2 (workflow enhancements):** 4. **Handoff** — focused continuation prompts (complements Sentinal pause) 5. **Plannotator / open-plan-annotator** — browser plan review UI 6. **Pilot** — GitHub/Linear issue polling automation 7. **Froggy** — gitingest integration

**Tier 3 (niche but useful):** 8. **Dynamic Context Pruning** — long-session token savings 9. **Agent Identity** — multi-agent attribution 10. **Background Agents** — async delegation 11. **Model Announcer** — model self-awareness 12. **Morph Fast Apply** — fast code editing

### Native Adoption (1 feature only)

Per user direction, Sentinal will adopt **Context Analysis token breakdown** natively since it aligns with existing `src/sessions/token-usage.ts` infrastructure and fills an identified gap. All other features stay as companion plugins.

---

## Scope

### In Scope

1. **Plugin catalog documentation** — persist the 54-plugin audit as a rules file for Claude Code and OpenCode
2. **Coexistence detection infrastructure** — extend `isStatuslineActive()` pattern to detect all overlapping plugins via `opencode.json` and `settings.json` scanning
3. **`sentinal companions` CLI command** — lists recommended companion plugins with install commands, categorized by tier
4. **Native Context Analysis adoption** — new `sentinal context analyze` command + `/context` skill that uses existing token-usage.ts infrastructure for visual breakdown
5. **Rules file updates** — `targets/claude-code/rules/companion-plugins.md` and `targets/opencode/rules/companion-plugins.md` documenting the companion strategy

### Out of Scope

- Native adoption of Safety Net, Envsitter, OpenTelemetry (user chose companion approach)
- Auth plugins (7 plugins — not Sentinal's domain)
- Plugin Template (dev tooling, not a user feature)
- Rebuilding any overlapping plugin functionality
- Theme/UI/snippet plugins (niche)

---

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Statusline coexistence pattern** — `src/cli/commands/statusline.ts:isStatuslineActive()` reads `~/.claude/settings.json` to detect if another plugin is active. Extend this pattern for all coexistence targets.
- **OpenCode config format** — OpenCode plugins are configured in `~/.config/opencode/opencode.json` under the `plugin` array. Detect plugin presence by scanning this file.
- **Claude Code plugin format** — Claude Code plugins live in `~/.claude/plugins/` as marketplace directories. Detect by scanning dir names.
- **Rules files** — `targets/<platform>/rules/*.md` are loaded as reference documentation. New rules file should be added to both platforms for parity.
- **CLI commands** — `src/cli/commands/*.ts` with `registerXxxCommand(program)` pattern. Follow `sentinal notify` (src/cli/commands/notify.ts) for command structure.
- **Token usage infrastructure** — `src/sessions/token-usage.ts` has `aggregateTokenUsage()` and message-level token counting. Use this for `sentinal context analyze`.
- **Cross-platform parity** — changes must apply to BOTH `targets/claude-code/` and `targets/opencode/` for rules files.

## Assumptions

- OpenCode's plugin config at `~/.config/opencode/opencode.json` has a stable `plugin` array schema — supported by existing install.ts `MCP_SERVERS_OPENCODE` pattern at `src/cli/commands/install-constants.ts:20` — Task 2 depends on this
- Session messages are retrievable via the sidecar API with per-message `role` field (user/assistant/system/tool) — supported by the OpenCode SDK `SessionMessage` type in `src/sessions/token-usage.ts:30` — Task 4 depends on this. **Note:** Sentinal's existing `aggregateTokenUsage()` returns only aggregate context-fill level, NOT per-category breakdown — Task 4 must implement its own per-role token counter.
- Rules files are loaded automatically by both Claude Code and OpenCode — supported by existing rules/ directory pattern — Task 5 depends on this

## Testing Strategy

- **Unit tests** for plugin detection helpers (mock `~/.config/opencode/opencode.json` fixtures)
- **Unit tests** for `sentinal companions` command output formatting
- **Unit tests** for `sentinal context analyze` using fixture token data
- **Integration test** for the coexistence detection pipeline (fixture directory with mock installed plugins)
- **Manual verification** for the rules files rendering correctly in both platforms

## Risks and Mitigations

| Risk                                                                    | Likelihood | Impact | Mitigation                                                                                 |
| ----------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------ |
| awesome-opencode plugin names/repos may change over time                | High       | Low    | Audit file is a snapshot — add date + git commit ref, recommend users check canonical list |
| Users may have some plugins installed but not all — partial coexistence | Medium     | Medium | Detection logic must be per-feature, not all-or-nothing. Yield each overlap independently. |
| `sentinal companions` command becomes stale                             | Medium     | Low    | Include a last-audited date in the output. Consider future automation to re-scan.          |
| Context Analysis token counting disagrees with actual model counts      | Low        | Low    | Use the same char-ratio approach as existing usage-stats.ts, mark as estimate              |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Plugin detection produces false positives/negatives** (Task 2) → Trigger: a plugin changes its config key and detection misses it, or partial detection blocks non-overlapping features
2. **`sentinal companions` output becomes noise rather than signal** (Task 3) → Trigger: users ignore it because it lists too many plugins without prioritization or filtering
3. **Native Context Analysis doesn't match Context Analysis plugin quality** (Task 4) → Trigger: users prefer to install the plugin anyway because Sentinal's output is less detailed — wasted implementation effort

## Execution Waves

**Wave 1** — Foundation (parallel): Documentation + detection infrastructure can proceed independently

- Task 1: Create awesome-opencode audit rules file (cross-platform)
- Task 2: Extend plugin coexistence detection helpers

**Wave 2** — Commands (parallel): Companion command and context analysis are independent once foundations exist

- Task 3: `sentinal companions` CLI command (depends on Task 1)
- Task 4: `sentinal context analyze` + /context skill (depends on nothing, but sequential for readability)

**Wave 3** — Wiring: Integration

- Task 5: Wire coexistence detection into install flow + statusline (depends on Task 2)

## Goal Verification

### Truths

1. `targets/claude-code/rules/companion-plugins.md` exists and lists at least 40 plugins with categories
2. `targets/opencode/rules/companion-plugins.md` exists with identical content
3. `src/cli/commands/companions.ts` exists and is registered in the CLI (grep `registerCompanionsCommand`)
4. `sentinal companions` CLI command prints a categorized list with installation instructions
5. `sentinal context analyze` CLI command exists and outputs per-category token breakdown
6. `src/cli/commands/statusline.ts` `isStatuslineActive()` is extended or `src/config/plugin-detection.ts` exists with detection helpers
7. Plugin detection reads `~/.config/opencode/opencode.json` and returns a list of installed plugin names

### Artifacts

| Artifact                                         | Provides                                | Exports                                                                   |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| `targets/claude-code/rules/companion-plugins.md` | Audit rules + companion recommendations | Loaded by Claude Code as a rule                                           |
| `targets/opencode/rules/companion-plugins.md`    | Same content for OpenCode               | Loaded by OpenCode as a rule                                              |
| `src/config/plugin-detection.ts`                 | Plugin detection helpers                | `detectOpencodePlugins()`, `detectClaudePlugins()`, `isPluginInstalled()` |
| `src/config/plugin-detection.test.ts`            | Unit tests                              | Test fixtures + assertions                                                |
| `src/cli/commands/companions.ts`                 | `sentinal companions` command           | `registerCompanionsCommand()`                                             |
| `src/cli/commands/companions.test.ts`            | Unit tests                              | Output format assertions                                                  |
| `src/cli/commands/context-analyze.ts`            | `sentinal context analyze` command      | `registerContextAnalyzeCommand()`                                         |
| `src/cli/commands/context-analyze.test.ts`       | Unit tests                              | Fixture-based breakdown tests                                             |
| `targets/claude-code/commands/context.md`        | `/context` slash command                | User-invocable skill                                                      |
| `targets/opencode/commands/context.md`           | Same for OpenCode                       | Loaded as OpenCode command                                                |

### Key Links

| From                                      | To                                    | Via                           | Pattern                         |
| ----------------------------------------- | ------------------------------------- | ----------------------------- | ------------------------------- |
| `src/cli/commands/companions.ts`          | `src/config/plugin-detection.ts`      | imports detection helpers     | `import.*plugin-detection`      |
| `src/cli/commands/context-analyze.ts`     | `src/sessions/token-usage.ts`         | uses `aggregateTokenUsage`    | `aggregateTokenUsage`           |
| `src/cli/index.ts`                        | `src/cli/commands/companions.ts`      | CLI registration              | `registerCompanionsCommand`     |
| `src/cli/index.ts`                        | `src/cli/commands/context-analyze.ts` | CLI registration              | `registerContextAnalyzeCommand` |
| `src/cli/commands/statusline.ts`          | `src/config/plugin-detection.ts`      | extends coexistence detection | `isPluginInstalled.*statusline` |
| `targets/claude-code/commands/context.md` | `sentinal context analyze`            | shell invocation              | `sentinal context analyze`      |

## Progress Tracking

- [ ] Task 1: Create companion-plugins rules file (cross-platform) (Wave 1)
- [ ] Task 2: Plugin coexistence detection helpers (Wave 1)
- [ ] Task 3: `sentinal companions` CLI command (Wave 2)
- [ ] Task 4: `sentinal context analyze` + /context skill (Wave 2)
- [ ] Task 5: Wire coexistence detection into install + statusline (Wave 3)

**Total Tasks:** 5 | **Completed:** 0 | **Remaining:** 5

---

## Implementation Tasks

### Task 1: Create companion-plugins rules file (cross-platform)

**Objective:** Document the full 54-plugin audit as a rules file loaded by both Claude Code and OpenCode. Users will see this as reference documentation when working on tasks that might benefit from a companion plugin.

**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `targets/claude-code/rules/companion-plugins.md`
- Create: `targets/opencode/rules/companion-plugins.md`
- No changes to `scripts/embed-assets.mjs` required — confirmed via code inspection (`readDir(dir, ".md")` at line 28-34 auto-scans the rules directory; new .md files are picked up automatically)

**Key Decisions / Notes:**

- Content should mirror the "Plugin Catalog" section above, formatted as Markdown with category headers
- Include a "Last audited: 2026-04-04" date at the top
- Both files should have identical content (no platform-specific variants) — this is documentation
- Follow the structure of existing rules files like `targets/claude-code/rules/mcp-servers.md`
- Reference the awesome-opencode repo URL at the top

**Definition of Done:**

- [ ] Both rules files created with 50+ plugins documented
- [ ] Files include category structure from audit
- [ ] Companion tiers (1-3) clearly marked
- [ ] Coexistence targets clearly marked
- [ ] Embed-assets script picks up the new files (verify by running `bun run embed-assets`)
- [ ] Files pass prettier formatting

**Verify:**

- `bun run embed-assets` succeeds and includes `companion-plugins.md` in both platform rule lists
- `wc -l targets/claude-code/rules/companion-plugins.md` returns a reasonable line count (>100)

---

### Task 2: Plugin coexistence detection helpers

**Objective:** Create a reusable module for detecting which OpenCode and Claude Code plugins are installed, generalizing the existing `isStatuslineActive()` pattern.

**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/config/plugin-detection.ts`
- Create: `src/config/plugin-detection.test.ts`

**Key Decisions / Notes:**

- Export functions: `detectOpencodePlugins(configPath?)` reads `~/.config/opencode/opencode.json` and returns list of `plugin` array entries; `detectClaudePlugins(pluginsDir?)` scans `~/.claude/plugins/` (FLAT, one level deep — e.g., `~/.claude/plugins/sentinal/`, `~/.claude/plugins/sentinal-marketplace/`) and returns plugin/marketplace directory names. Also parses `~/.claude/plugins/installed_plugins.json` if present for canonical installed list.
- `isPluginInstalled(pluginName: string, platform: "claude" | "opencode"): boolean` — shorthand
- Helpers must accept override paths for testability
- Follow pattern of `isStatuslineActive()` in `src/cli/commands/statusline.ts` — JSON parse with comment stripping, gracefully handle missing files
- Use node:fs (existsSync, readFileSync) — no bun:sqlite or native deps
- Plugin name detection: OpenCode uses `plugin` array entries like `"opencode-worktree"` or object forms; Claude uses marketplace dir structure

**Definition of Done:**

- [ ] `detectOpencodePlugins()` returns array of plugin name strings from fixture config
- [ ] `detectClaudePlugins()` returns array of plugin name strings from fixture directory
- [ ] `isPluginInstalled()` returns true/false correctly
- [ ] Handles missing config files gracefully (returns empty array)
- [ ] Handles malformed JSON gracefully (returns empty array, logs warning)
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/config/plugin-detection.test.ts`

---

### Task 3: `sentinal companions` CLI command

**Objective:** Add a `sentinal companions` command that lists recommended companion plugins categorized by tier, with installation instructions. Filters out plugins already installed (uses Task 2 detection).

**Dependencies:** Task 1, Task 2
**Wave:** 2

**Files:**

- Create: `src/cli/commands/companions.ts`
- Create: `src/cli/commands/companions.test.ts`
- Modify: `src/cli/index.ts` — register the new command

**Key Decisions / Notes:**

- Command signature: `sentinal companions [--tier=1|2|3] [--category=<name>] [--installed] [--missing]`
- Default output: tier 1 (security/observability) companions only, grouped by category, with GitHub URL and 1-line description
- `--tier=all` shows all tiers
- `--installed` only shows already-installed (verification mode)
- `--missing` only shows not-yet-installed (default behavior for discovery)
- Data source: embed the audit data as a const array in the .ts file (don't parse the rules .md)
- Output format: colored terminal with `info()`, `ok()`, `note()` helpers from `src/cli/utils/shell.ts`
- Exit code 0 always unless arg parsing fails

**Definition of Done:**

- [ ] `sentinal companions` prints tier 1 companions by default
- [ ] `sentinal companions --tier=all` prints all tiers
- [ ] `sentinal companions --installed` shows installed companion plugins
- [ ] `sentinal companions --missing` shows missing companion plugins
- [ ] Output includes repo URL and install command for each entry
- [ ] Command registered in `src/cli/index.ts`
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/cli/commands/companions.test.ts`
- Manual: `bun src/cli/index.ts companions` prints expected output

---

### Task 4: `sentinal context analyze` + /context skill

**Objective:** Add a `sentinal context analyze` CLI command and a `/context` slash command for Claude Code and OpenCode. Uses existing token-usage.ts infrastructure to produce a per-category token breakdown (system, user, assistant, tools).

**Dependencies:** None (independent)
**Wave:** 2

**Files:**

- Create: `src/sessions/token-categorize.ts` — new `categorizeTokensByRole(messages)` function returning `{ system, user, assistant, tool, total }`
- Create: `src/sessions/token-categorize.test.ts` — unit tests with fixture messages
- Create: `src/cli/commands/context-analyze.ts`
- Create: `src/cli/commands/context-analyze.test.ts`
- Modify: `src/cli/index.ts` — register the new command
- Create: `targets/claude-code/commands/context.md`
- Create: `targets/opencode/commands/context.md`

**Key Decisions / Notes:**

- Command signature: `sentinal context analyze [--session=<id>] [--verbose]`
- Reads session messages via the sidecar API (`SidecarClient` — check for existing session retrieval method; if absent, add one that calls the OpenCode session API and returns `SessionMessage[]`)
- **Important:** Sentinal's existing `aggregateTokenUsage()` returns only a single context-fill level, NOT a per-category breakdown. Task 4 must implement a new function `categorizeTokensByRole(messages)` in `src/sessions/token-categorize.ts` that iterates messages and sums `tokens.input + tokens.output` per role (`user`, `assistant`, `system`, `tool`)
- Categories: `system_prompt`, `user_messages`, `assistant_responses`, `tool_results` — derived from `SessionMessage.info.role` field
- Token counting approach: use the existing `MessageTokens` struct where available (OpenCode provides exact counts per message). For messages without token counts, fall back to char-ratio estimation (3.75 chars/token) matching Sentinal's existing usage-stats approach
- Per-tool breakdown (`--verbose`): iterate tool-role messages, group by `name` field if available (may require schema changes — if not exposed, document as "not available without OpenCode SDK extension")
- Outputs ASCII bar chart showing percentages per category
- Follow pattern of `src/cli/commands/usage.ts` for output formatting
- The `/context` slash command wraps the CLI in a shell invocation — `sentinal context analyze`
- Default session: Sentinal tracks active sessions via the spec/session store. If `--session` is omitted, use `MemoryStore.getActiveSessions()[0]` (the current active session). Do NOT rely on any `CLAUDE_CODE_SESSION_ID` env var — it does not exist; Claude Code provides session IDs via stdin JSON in hook context.

**Definition of Done:**

- [ ] `sentinal context analyze` outputs categorized token breakdown
- [ ] ASCII bar chart renders correctly in terminal
- [ ] `--verbose` adds per-tool detail
- [ ] Command registered in `src/cli/index.ts`
- [ ] `/context` slash command exists for both platforms
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/cli/commands/context-analyze.test.ts`
- Manual: `bun src/cli/index.ts context analyze` prints breakdown

---

### Task 5: Wire coexistence detection into install + statusline

**Objective:** Use the plugin-detection helpers (Task 2) to detect overlapping plugins during install and at statusline startup. Print a note when an overlap is detected, recommending that the user pick one or the other.

**Dependencies:** Task 2
**Wave:** 3

**Files:**

- Modify: `src/cli/commands/install.ts` — after installing, check for known coexistence targets and print warnings
- Modify: `src/cli/commands/statusline.ts` — add additional coexistence checks beyond the existing `isStatuslineActive()` for relevant overlaps
- Create: `src/config/coexistence-map.ts` — maps Sentinal features to competing plugin names (e.g., `{ "statusline": ["opencode-quota", "opencode-mystatus"], "sessions": ["opencode-sessions"], ... }`)
- Modify: `src/cli/commands/install.test.ts` — add test for coexistence warning output

**Key Decisions / Notes:**

- Coexistence map format: `{ feature: string[] }` where feature is a Sentinal feature name and array is competing plugin names
- Install flow: after successful install, for each Sentinal feature, check if any competing plugin is present. If yes, print `note()` suggesting the user review the overlap
- Claude Code statusline: existing `isStatuslineActive()` reads `~/.claude/settings.json` `statusLine.command` — no changes needed
- **OpenCode statusline detection:** OpenCode has no `statusLine.command` equivalent that signals ownership. Detection is by `plugin` array membership only — if `opencode-quota` or `opencode-mystatus` is listed in `~/.config/opencode/opencode.json`, treat that as ownership. Document this limitation in the coexistence map comments.
- OpenCode session/skill/memory/worktree detection: use plugin array presence in `opencode.json` as the sole signal — the OpenCode plugin system has no per-feature ownership API.
- Do NOT block install or disable features — just warn, let user decide
- Follow the existing statusline coexistence pattern from `bb32a57` commit

**Definition of Done:**

- [ ] `coexistence-map.ts` created with known overlaps
- [ ] Install output prints coexistence warnings when competing plugins detected
- [ ] Statusline skips configuration when OpenCode statusline competitors detected
- [ ] No behavior change when no competing plugins present
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/cli/commands/install.test.ts`
- Manual: install with a fake competing plugin in `~/.config/opencode/opencode.json`, verify warning appears
