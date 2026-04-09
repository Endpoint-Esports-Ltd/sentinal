## Team Sharing

Share AI assets (rules, skills, commands, agents) across your team by committing them to your project's `.sentinal/` directory in source control.

### Project-Level Assets

Place assets in your project's `.sentinal/` directory to share with all team members:

```
.sentinal/
  rules/          # Project-specific rules (load every session)
  skills/         # Reusable skills from /learn
```

`.claude/` and `.opencode/` point to `.sentinal/` via symlinks created by `sentinal install`. Commit `.sentinal/` to git and share automatically via normal code review and pull request workflows.

### Asset Types

| Type         | Path                               | Best for                                |
| ------------ | ---------------------------------- | --------------------------------------- |
| **Rules**    | `.sentinal/rules/<name>.md`        | Conventions Claude should always follow |
| **Commands** | `.claude/commands/<name>.md`       | Specific workflows or multi-step tasks  |
| **Skills**   | `.sentinal/skills/<name>/SKILL.md` | Reusable knowledge from past sessions   |
| **Agents**   | `.claude/agents/<name>.md`         | Custom sub-agents                       |

### Monorepo Support

Organize rules in nested subdirectories by product and team:

```
.sentinal/rules/
  my-product/
    team-x/
      specific-rule.md   # Use paths frontmatter to scope
```

Team-level rules must use `paths` frontmatter to scope to the right files:

```markdown
---
paths: ["my-product/**"]
---
```

### Shared Project Memory

Use `memory_share` MCP tool to promote valuable observations (decisions, discoveries, patterns) to `.sentinal/project-memory.json`. This file is committed to git and automatically restored for all team members at session start — sharing institutional knowledge without writing skills.

### Workflow

1. Create asset in `.sentinal/rules/` or `.sentinal/skills/`
2. Commit and push via normal PR process
3. Team members pull and get the asset automatically
4. Run `/sync` after pulling new assets to update Claude's understanding
5. Use `memory_share` to promote important observations to shared project memory
