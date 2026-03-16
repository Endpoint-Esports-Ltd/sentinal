# Autonomous Claude Code Permissions Plan

**Status:** VERIFIED
**Type:** Feature
**Approved:** Yes
**Worktree:** No
**Date:** 2026-03-11

## Goal

Configure Claude Code permissions so that safe operations (reading files, fetching web pages, editing project files, running MCP tools) are auto-approved without prompting.

## Scope

- **In scope:**
  - Update plugin `settings.json` with comprehensive permission allowlist
  - Add missing tool categories: WebFetch, Agent, Task, Playwright MCP, etc.
  - Clean up project `.claude/settings.local.json` to remove accumulated one-off approvals that the plugin should cover
  - Update embedded assets so future installs get the correct permissions
- **Out of scope:**
  - Changing the install command logic itself
  - Adding dynamic/conditional permission approval
  - Modifying global `~/.claude/settings.json` permissions

## Architecture

The plugin's `targets/claude-code/settings.json` is the source of truth for permissions distributed with Sentinal. This file gets embedded into `src/cli/embedded-assets.ts` during build and installed to `~/.claude/plugins/sentinal-marketplace/plugins/sentinal/settings.json`.

The fix is straightforward: expand the `permissions.allow` array in the plugin settings to cover all tool categories that should auto-approve. Then clean the project-local settings file of entries that are now redundant.

Claude Code permission patterns support:

- Bare tool names: `"Read"`, `"Edit"`, `"WebFetch"`
- Wildcard patterns: `"Bash(git:*)"`, `"mcp__plugin_sentinal_*"`
- Domain-scoped: `"WebFetch(domain:github.com)"`

## Tasks

Done: 2 | Left: 0

### Task 1: Expand plugin permissions allowlist

- [ ] Add `WebFetch` (bare — allows all web fetches)
- [ ] Add `WebSearch` (bare — allows all web searches)
- [ ] Add `Agent` (bare — allows launching subagents without prompting)
- [ ] Add `Task` and `Task(*)` patterns for all task operations
- [ ] Add `mcp__plugin_playwright_playwright__*` for Playwright browser tools
- [ ] Add `Skill(*)` wildcard to cover all current and future skills
- [ ] Add missing utility tools: `TodoWrite`, `TodoRead`, `WebFetch(domain:*)`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`
- [ ] Add `Bash(cat:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(wc:*)`, `Bash(sort:*)`, `Bash(curl:*)`, `Bash(echo:*)`, `Bash(touch:*)` for common shell operations
- [ ] Add `Bash(gh:*)` for GitHub CLI
- [ ] Add `Bash(docker:*)`, `Bash(python3:*)`, `Bash(node:*)` for common dev tools
- **Files:** modify `targets/claude-code/settings.json`
- **DoD:** Plugin settings file contains comprehensive allowlist covering all standard operations

### Task 2: Clean project-local settings

- [ ] Remove entries from `.claude/settings.local.json` that are now covered by the expanded plugin allowlist
- [ ] Keep only truly project-specific entries that shouldn't be in the global plugin
- **Files:** modify `.claude/settings.local.json`
- **DoD:** Local settings file is minimal, with no redundant entries

## Risks

- **Over-permissioning:** Allowing `Bash` bare (already present) means any bash command runs without approval. This is intentional for developer productivity but users should be aware.
- **WebFetch without domain restriction:** Allows fetching any URL. Acceptable for a developer tool but worth noting.

## Goal Verification

- After reinstalling the plugin, Claude Code should not prompt for: reading files, editing files, fetching web pages, running MCP tools, launching agents, or common bash commands
- The `.claude/settings.local.json` should be minimal (ideally empty `allow` array or only project-specific items)
