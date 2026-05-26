# Dual-Target Changes — Claude Code + OpenCode

Sentinal ships as extensions for **both** Claude Code and OpenCode. Most functional changes need to land in both targets. This rule tells you when and how.

## The Core Principle

**Shared logic belongs in `src/`. Target-specific wiring belongs in `targets/<target>/`.**

If you're adding a checker, hook helper, MCP tool, memory feature, or CLI command — write it once in `src/` and register it twice (once per target).

## Platform Differences Cheat Sheet

| Feature           | Claude Code                                               | OpenCode                                                                          |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Extension type    | Compiled hook scripts (Bun → JS)                          | Native TypeScript plugin (Bun runs `.ts` directly)                                |
| Event names       | `SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact` | `tool.execute.before/after`, `session.created`, `session.idle`                    |
| Tool block        | Exit code 2 + stderr                                      | `throw new Error("message")`                                                      |
| Formatters        | Must invoke Prettier/ESLint explicitly in hooks           | Built-in — OpenCode runs them automatically                                       |
| Context injection | Write to `.sentinal/compact-state.json`                   | Direct `output.context.push()` on `session.compacting`                            |
| Tool name seen    | Exact Claude Code name (`Write`, `Edit`, `Bash`)          | OpenCode lowercase names (`write`, `edit`, `bash`); MCP tools use their full name |
| Subagent MCP      | Per-subagent `mcpServers` frontmatter supported           | NOT supported — MCP scoping is global                                             |

## "Does this change need to touch both targets?" Decision Tree

1. **Editing pure logic in `src/` (checker, util, memory, spec, tdd)?** → Shared code, no target files needed. Both targets pick it up on next build.
2. **Adding a new MCP tool?** → Register it in the matching `src/<domain>/mcp-tools.ts`. The `createSentinalServer` factory (`src/mcp/server.ts:36`) registers all domains for both targets automatically.
3. **Adding/changing a hook behavior?** → Update the Claude Code hook in `src/hooks/` AND the equivalent OpenCode handler in `targets/opencode/plugins/sentinal.ts`. See `sentinal-hooks-development.md` for the mapping.
4. **Adding a slash command?** → Edit `templates/commands/<name>.md`, then run `scripts/generate-commands.js` to regenerate both `targets/claude-code/commands/` and `targets/opencode/commands/`.
5. **Changing permissions / settings?** → Update `targets/claude-code/settings.json` AND `targets/opencode/opencode.json` — these are separate files with different schemas.
6. **Adding a new shipped rule (`standards-*.md`)?** → Put the same file in both `targets/claude-code/rules/` and `targets/opencode/rules/`. They MUST stay in sync.

## Build & Verify Both Targets

```bash
bun run build:all    # builds both — run this before considering a dual-target change "done"
bun test             # shared logic tests cover both targets
```

For Claude Code hooks specifically:

```bash
bun run build:claude         # compiles src/hooks/*.ts → targets/claude-code/hooks/dist/*.js
bun run install:claude-code  # installs to ~/.claude/ via marketplace
```

For OpenCode plugin:

```bash
bun run build:opencode       # bundles targets/opencode/plugins/sentinal.ts → dist/sentinal.mjs
bun run deploy:opencode      # builds + copies to ~/.config/opencode/plugins/
```

## Common Drift to Watch For

- **New MCP server in `.mcp.json` but not in `opencode.json`** — both files list MCP servers separately.
- **New hook in `hooks.json` but no OpenCode equivalent in `plugins/sentinal.ts`** — OpenCode won't get the feature.
- **Standards rule updated in one `targets/*/rules/` but not the other** — users on one platform miss the update.
- **Command template edited AND target file hand-edited** — next regeneration will overwrite the hand edit.
