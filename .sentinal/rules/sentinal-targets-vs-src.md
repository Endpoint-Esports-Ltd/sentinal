# targets/ vs src/ vs .sentinal/ — What Goes Where

**This is the #1 source of confusion in this repo.** Read this before editing anything under `targets/`.

## The Three Locations

| Directory        | Purpose                                             | Who reads it                                |
| ---------------- | --------------------------------------------------- | ------------------------------------------- |
| `src/`           | Shared TypeScript source — the product logic        | Both targets import from here               |
| `targets/`       | **Shipped artifacts** — what users install          | Users' Claude Code / OpenCode installations |
| `.sentinal/`     | Repo-local dev state + rules for developing sentinal | Claude Code / OpenCode when editing sentinal |

## `targets/*/rules/` are NOT your rules

⛔ **Files in `targets/claude-code/rules/` and `targets/opencode/rules/` are shipped to users.** They are the `standards-typescript.md`, `standards-angular.md`, etc. that Sentinal installs into user projects. **Do NOT edit them to reflect sentinal's own codebase.**

✅ **Rules for developing sentinal itself go in `.sentinal/rules/`.** These files use the `sentinal-` prefix and are loaded into the assistant when editing sentinal.

## `targets/*/AGENTS.md` is a template, not docs

`targets/opencode/AGENTS.md` contains `<!-- TODO -->` placeholders and is copied into **user projects** by the installer. It is NOT sentinal's own AGENTS.md. **Do not fill in the TODOs with sentinal-specific info.**

## Where to put new work

| I'm adding / changing ...                    | Go here                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A new hook, checker, MCP tool, CLI command    | `src/<domain>/` (shared) + wire into both targets                                                                     |
| A standard Sentinal ships to users            | `targets/claude-code/rules/` AND `targets/opencode/rules/` (keep in sync)                                             |
| A slash command Sentinal ships                | `templates/commands/` then regenerate via `scripts/generate-commands.js` — do NOT hand-edit `targets/*/commands/*.md` |
| A rule for developing sentinal itself         | `.sentinal/rules/sentinal-<topic>.md`                                                                                 |
| A skill for developing sentinal               | `.sentinal/skills/sentinal-<name>/SKILL.md`                                                                           |
| An installer asset or Claude plugin manifest  | `targets/claude-code/.claude-plugin/` or `targets/claude-code/settings.json`                                          |
| Sidecar state, runtime persistence            | `.sentinal/` (gitignored where appropriate)                                                                           |

## Commands come from templates

`targets/claude-code/commands/*.md` and `targets/opencode/commands/*.md` are **generated** from `templates/commands/*.md` by `scripts/generate-commands.js`. Edit the template, then regenerate — hand-editing the generated files will be overwritten.

## Quick sanity check before editing

```bash
# If path starts with targets/ — am I editing a shipped artifact or dev docs?
# If yes and it's *.md in rules/ or AGENTS.md — STOP, that's for users.

# If path starts with .sentinal/rules/ — for developing sentinal itself ✓
# If path starts with src/ — shared product logic ✓
```
