---
description: Extract reusable knowledge from the current session
argument-hint: ""
user-invocable: true
model: sonnet
---

# /learn — Knowledge Extraction

**Evaluate the current session for extractable knowledge and create reusable skills or rules.**

## Process

1. **Evaluate the session:** Does it contain:
   - A non-obvious debugging solution?
   - A workaround for a limitation?
   - An undocumented API/tool integration?
   - A multi-step workflow that will recur?

2. **If valuable knowledge exists:**
   - Check existing skills in `.claude/skills/` to avoid duplication
   - Create a new skill at `.claude/skills/<name>/SKILL.md`
   - Or update an existing rule in `.claude/rules/`

3. **If nothing extractable:** Say so and move on — don't force it

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
