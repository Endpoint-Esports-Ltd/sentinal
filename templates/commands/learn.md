---
description: { { description } }
argument-hint: <topic>
---

# /learn — Knowledge Extraction

**Evaluate the current session for extractable knowledge, persist to memory, and optionally create reusable skills.**

If a `<topic>` argument is provided, focus extraction on that specific topic. Otherwise, evaluate the full session.

## Process

1. **Evaluate the session:** Does it contain:
   - A non-obvious debugging solution?
   - A workaround for a limitation?
   - An undocumented API/tool integration?
   - A multi-step workflow that will recur?
   - An architectural decision with rationale?
   - A discovered pattern or convention?

2. **If nothing extractable:** Say so and move on — don't force it.

3. **Persist to memory:** For each valuable insight, call the `memory_save` MCP tool:
   - **title:** Concise summary (under 100 chars)
   - **content:** Detailed explanation with context and rationale
   - **type:** Choose the most appropriate:
     - `decision` — Architecture choices, design pattern selections
     - `discovery` — Non-obvious findings, workarounds, gotchas
     - `error` — Bugs encountered and root causes
     - `fix` — Solutions to problems
     - `pattern` — Recurring solutions, project conventions
   - **project:** Current working directory path
   - **tags:** 2-5 relevant tags for categorization
   - **filePaths:** Related file paths (if applicable)

4. **Optionally create a skill file** (only for multi-step workflows that will recur):
   - Check existing skills in `.claude/skills/` and `.opencode/skills/` to avoid duplication
   - Create the skill in BOTH `.claude/skills/<name>/SKILL.md` AND `.opencode/skills/<name>/SKILL.md` (identical content) so teams using either Claude Code or OpenCode can discover it
   - Or update an existing rule in `.claude/rules/`

## Skill Format

```markdown
---
name: skill-name
description: When and why to use this skill
user-invocable: true
---

# [Skill Title]

[Clear instructions for what this skill does and how to use it]
```

## Don't Extract

- Simple tasks that anyone could do
- Single-step fixes
- Knowledge already in official documentation
- Unverified or speculative solutions

## Example Output

After running `/learn`:

> Saved 2 observations to memory:
>
> - #42: "bun:sqlite result.changes includes trigger changes" (discovery)
> - #43: "Pre-count rows before DELETE for accurate change tracking" (pattern)
>
> No skill file created — these are project-specific findings, not reusable workflows.
