# targets/ vs src/ vs .sentinal/ — What Goes Where

**This is the #1 source of confusion in this repo.** Read this before editing anything under `targets/`.

## The Three Locations

| Directory    | Purpose                                              | Who reads it                                 |
| ------------ | ---------------------------------------------------- | -------------------------------------------- |
| `src/`       | Shared TypeScript source — the product logic         | Both targets import from here                |
| `targets/`   | **Shipped artifacts** — what users install           | Users' Claude Code / OpenCode installations  |
| `.sentinal/` | Repo-local dev state + rules for developing sentinal | Claude Code / OpenCode when editing sentinal |

## `targets/*/rules/` are NOT your rules

⛔ **Files in `targets/claude-code/rules/` and `targets/opencode/rules/` are shipped to users.** They are the `standards-typescript.md`, `standards-angular.md`, etc. that Sentinal installs into user projects. **Do NOT edit them to reflect sentinal's own codebase.**

✅ **Rules for developing sentinal itself go in `.sentinal/rules/`.** These files use the `sentinal-` prefix and are loaded into the assistant when editing sentinal.

## `targets/*/AGENTS.md` is a template, not docs

`targets/opencode/AGENTS.md` contains `<!-- TODO -->` placeholders and is copied into **user projects** by the installer. It is NOT sentinal's own AGENTS.md. **Do not fill in the TODOs with sentinal-specific info.**

## Where to put new work

| I'm adding / changing ...                    | Go here                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new hook, checker, MCP tool, CLI command   | `src/<domain>/` (shared) + wire into both targets                                                                                                                                                                                      |
| A standard Sentinal ships to users           | `targets/claude-code/rules/` AND `targets/opencode/rules/` (keep in sync)                                                                                                                                                              |
| A slash command Sentinal ships               | Edit `targets/claude-code/commands/<name>.md` directly. For OpenCode: user-facing commands go in `targets/opencode/commands/`; spec sub-phases go in `targets/opencode/skills/<name>/SKILL.md` (see OpenCode architecture note below). |
| A rule for developing sentinal itself        | `.sentinal/rules/sentinal-<topic>.md`                                                                                                                                                                                                  |
| A skill for developing sentinal              | `.sentinal/skills/sentinal-<name>/SKILL.md`                                                                                                                                                                                            |
| An installer asset or Claude plugin manifest | `targets/claude-code/.claude-plugin/` or `targets/claude-code/settings.json`                                                                                                                                                           |
| Sidecar state, runtime persistence           | `.sentinal/` (gitignored where appropriate)                                                                                                                                                                                            |

## Commands are edited directly — there is no generator

`targets/claude-code/commands/*.md` and `targets/opencode/commands/*.md` are the **canonical source**. Edit them directly. `scripts/generate-commands.js` and `templates/commands/` have been deleted — they were dead code whose stale content actively caused bugs.

**OpenCode command vs skill distinction:** In OpenCode, `/spec`, `/sync`, and `/learn` are user-invocable commands (`targets/opencode/commands/`). The spec sub-phases (`spec-plan`, `spec-implement`, etc.) are skills (`targets/opencode/skills/`) invoked programmatically by the `/spec` dispatcher — not slash commands the user types. This is intentional architecture (see `docs/plans/2026-03-10-opencode-agents-skills.md`). Do not add command files for spec sub-phases to `targets/opencode/commands/`.

## Quick sanity check before editing

```bash
# If path starts with targets/ — am I editing a shipped artifact or dev docs?
# If yes and it's *.md in rules/ or AGENTS.md — STOP, that's for users.

# If path starts with .sentinal/rules/ — for developing sentinal itself ✓
# If path starts with src/ — shared product logic ✓
```
