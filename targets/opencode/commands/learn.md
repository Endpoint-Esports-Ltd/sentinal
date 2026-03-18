---
description: Use after significant debugging, workarounds, or multi-step workflows worth standardizing for future sessions
---

# /learn - Online Learning System

**Extract reusable knowledge from this session into skills.** Evaluates what was learned, checks for existing skills, creates new ones when valuable.

---

## Phase 0: Reference

### Triggers

| Trigger                      | Example                                                 |
| ---------------------------- | ------------------------------------------------------- |
| **Non-obvious debugging**    | Spent 10+ minutes; solution wasn't in docs              |
| **Misleading errors**        | Error message pointed wrong direction; found real cause |
| **Workarounds**              | Found limitation and creative solution                  |
| **Tool integration**         | Undocumented API/tool usage                             |
| **Trial-and-error**          | Tried multiple approaches before finding what worked    |
| **Repeatable workflow**      | Multi-step task that will recur                         |
| **External service queries** | Fetched from Jira, GitHub, Confluence                   |
| **User-facing automation**   | Reports, status checks user will ask for again          |

### Quality Criteria

- **Reusable**: Will help future tasks, not just this instance
- **Non-trivial**: Required discovery or is a valuable workflow pattern
- **Verified**: Solution actually worked

**Do NOT extract:** Single-step tasks, one-off fixes, knowledge in official docs.

### Project Slug

Prefix ALL created skills with the project slug to avoid name collisions across repos.

```bash
SLUG=$(basename "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" 2>/dev/null || basename "$PWD")
# Result: "my-api", "acme-backend", "sentinal"
```

Skill directory:

- `.sentinal/skills/{slug}-{name}/SKILL.md`

Read by both Claude Code and OpenCode via symlinks and config (set up by `sentinal install`).

**Naming rules:** Lowercase with hyphens only. The slug provides context; the name should be 1-3 words max that are descriptive (not generic). Examples: `my-api-auth-flow`, `acme-deploy`. Never use generic names like "helper", "utils", "tools", "handler", "workflow".

### Skill Complexity Spectrum

Before writing, decide WHERE your skill falls. **Move left whenever possible** — simpler skills are more reliable, cheaper to execute, and work across more models.

| Level             | Style                      | Determinism | Best For                                  |
| ----------------- | -------------------------- | ----------- | ----------------------------------------- |
| **Passive**       | Context only               | N/A         | Background knowledge, coding standards    |
| **Instructional** | Rules + guidelines         | Medium      | Code review, style guides                 |
| **CLI Wrapper**   | Calls a binary/script      | **High**    | Automation, integrations, data processing |
| **Workflow**      | Multi-step with validation | Medium      | Deploy pipelines, migrations              |
| **Generative**    | Asks agent to write code   | Low         | Scaffolding, code generation              |

**Key insight:** A skill that says "run `eslint --fix`" works on any model. A skill that says "analyze the code and suggest improvements" requires expensive reasoning. Prefer commands over descriptions, scripts over instructions, explicit values over judgment.

### Skill Template

**Location:** `.sentinal/skills/{slug}-{skill-name}/SKILL.md`

Before writing, answer these five questions:

1. **When should this skill activate?** (→ becomes `description`)
2. **What inputs does it need?** (arguments, files, environment state)
3. **What does success look like?** (specific output, files created, commands run)
4. **What should it NOT do?** (explicit exclusions prevent scope creep)
5. **How do you verify it worked?** (include a validation step)

```markdown
---
name: {slug}-descriptive-kebab-case-name
description: |
  [CRITICAL: Describe WHEN to use, not HOW it works. Include trigger conditions, scenarios, exact error messages.]
author: Claude Code
version: 1.0.0
---

# Skill Name

## When to Use

[Specific trigger conditions — be precise]

## Solution

[Steps — ordered, concrete, verifiable. Prefer exact commands over descriptions.]

## Verification

[How to confirm it worked]

## When NOT to Use

[Explicit exclusions — prevents scope creep and misactivation]

## Example

[Concrete input/output example]

## References
```

**⚠️ The Description Trap:** If description summarizes the workflow, Claude follows the short description as a shortcut instead of reading SKILL.md. Always describe trigger conditions, not process.

✅ `"Fix for ENOENT errors in npm monorepos. Use when: (1) npm run fails with ENOENT, (2) symlinked deps cause failures."`
❌ `"Extract and organize npm monorepo fixes by analyzing symlinks and paths."`

### Progressive Disclosure

Don't dump everything into SKILL.md. Layer content so the AI loads only what it needs.

| Layer              | What                            | Context Cost                              |
| ------------------ | ------------------------------- | ----------------------------------------- |
| **Metadata**       | `description` in frontmatter    | Always loaded (~100 tokens)               |
| **Body**           | SKILL.md instructions           | Loaded on activation                      |
| **Scripts/Assets** | `scripts/`, `examples/` subdirs | Executed or path-referenced, never loaded |

**Rule of thumb:** "Is this line worth the context tokens it costs?" Don't explain what AI already knows. Only add your project's specific conventions, internal APIs, and domain rules.

**Guidelines:** Concise (Claude is smart). Under 500 lines for body. Examples over explanations. Put detailed reference docs in `references/` subdirectory.

---

## Phase 1: Evaluate

Ask yourself:

1. "What did I learn that wasn't obvious before starting?"
2. "Would future-me benefit from having this documented?"
3. "Was the solution non-obvious from docs alone?"
4. "Is this a multi-step workflow I'd repeat?"
5. "Did I query an external service the user will ask about again?"

**If NO to all → Skip, nothing to learn.** External service queries are almost always worth extracting.

---

## Phase 2: Check Existing

```bash
ls .sentinal/skills/ 2>/dev/null
grep -ri "keyword" .sentinal/skills/ 2>/dev/null
```

| Found            | Action                         |
| ---------------- | ------------------------------ |
| Nothing related  | Create new                     |
| Same trigger/fix | Update existing (bump version) |
| Partial overlap  | Update with new variant        |

---

## Phase 3: Create Skill & Persist to Memory

Write to `.sentinal/skills/{slug}-{skill-name}/SKILL.md` using the template from Phase 0.

**Also persist to Sentinal memory** using `memory_save` MCP tool with `type: "pattern"`, relevant `tags`, and the `project` path. This ensures the knowledge is available via `memory_search` in future sessions even before the skill is activated. Use `memory_search` first to check for existing observations that overlap.

**Determinism checklist** — maximize reliability:

- Prefer exact commands over descriptions (`run prettier --write .` not "format the code")
- Prefer scripts over multi-step instructions (reference `scripts/deploy.sh` not 5 prose steps)
- Use explicit values over judgment (`block files > 100KB` not "block large files")
- For high-risk operations (DB migrations, deploys): exact commands, validation steps, rollback plan
- For low-risk operations (code review, docs): general guidelines, let AI use judgment

**One skill = one purpose.** If the skill handles review AND testing AND deployment, split it.

---

## Phase 4: Quality Gates

- [ ] Description contains specific trigger conditions (not process summary)
- [ ] Includes "When NOT to Use" section with explicit exclusions
- [ ] Solution verified to work
- [ ] Specific enough to be actionable
- [ ] General enough to be reusable
- [ ] No sensitive information (API keys, passwords, internal URLs → use env vars instead)
- [ ] No hardcoded paths (use relative paths or environment variables)
- [ ] Deterministic where possible (commands > descriptions)
- [ ] Context-efficient (no explaining what AI already knows)
- [ ] Includes verification step (how to confirm it worked)

---

## Anti-Patterns

| Anti-Pattern                                                           | Fix                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| **Kitchen sink** — skill does too many things                          | One skill = one purpose. Split it.                    |
| **Vague instructions** — "properly format the code"                    | Name the specific tool and command                    |
| **Explaining AI knowledge** — "NestJS is a Node.js framework..."       | Only add what AI doesn't know: YOUR conventions       |
| **Too many options** — "use option A, B, or C..."                      | Give one default, mention alternatives only if needed |
| **No verification** — "deploy to staging" (how do you know it worked?) | Always include a verification command                 |
| **Hardcoded paths** — `/Users/john/projects/my-app/...`                | Relative paths or environment variables               |

---

## Example

**Scenario:** Discovered that Angular `OnPush` change detection misses updates from RxJS subjects unless `markForCheck()` is called explicitly.

**Result:** `.sentinal/skills/my-project-angular-cd/SKILL.md`

```yaml
name: my-project-angular-cd
description: |
  Fix for missing UI updates with OnPush change detection. Use when: (1) component
  data changes but UI doesn't update, (2) component uses ChangeDetectionStrategy.OnPush
  with RxJS subjects, (3) async pipe not sufficient.
```

ARGUMENTS: $ARGUMENTS
