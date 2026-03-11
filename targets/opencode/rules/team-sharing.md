## Team Sharing

Share AI assets (rules, skills, commands, agents) across your team by committing them to your project's `.claude/` directory in source control.

### Project-Level Assets

Place assets in your project's `.claude/` directory to share with all team members:

```
.claude/
  rules/          # Project-specific rules (load every session)
  commands/       # Custom slash commands
  skills/         # Reusable skills from /learn
  agents/         # Custom sub-agents
```

These are committed to git and shared automatically via normal code review and pull request workflows.

### Asset Types

| Type | Path | Best for |
|------|------|----------|
| **Rules** | `.claude/rules/<name>.md` | Conventions Claude should always follow |
| **Commands** | `.claude/commands/<name>.md` | Specific workflows or multi-step tasks |
| **Skills** | `.claude/skills/<name>/SKILL.md` | Reusable knowledge from past sessions |
| **Agents** | `.claude/agents/<name>.md` | Custom sub-agents |

### Monorepo Support

Organize rules in nested subdirectories by product and team:

```
.claude/rules/
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

### Workflow

1. Create asset in `.claude/` directory
2. Commit and push via normal PR process
3. Team members pull and get the asset automatically
4. Run `/sync` after pulling new assets to update Claude's understanding
