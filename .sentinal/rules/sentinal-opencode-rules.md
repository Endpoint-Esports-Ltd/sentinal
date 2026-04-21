# OpenCode Rules — Target-Specific Divergence Notes

**Last verified:** 2026-04-21 (OpenCode docs review)

## `paths:` Frontmatter — Claude Code Only

Claude Code rules support `paths:` YAML frontmatter to scope a rule to specific file patterns:

```yaml
---
paths:
  - "**/*.component.ts"
  - "**/*.directive.ts"
---
```

When present, the rule only loads when the active file matches one of the patterns.
Claude Code rules at `targets/claude-code/rules/standards-{angular,nestjs,typescript,backend,frontend}.md`
all use this feature.

**OpenCode does NOT support `paths:` frontmatter.** OpenCode's rule system is based on:
1. `AGENTS.md` files (project-local + global at `~/.config/opencode/AGENTS.md`)
2. The `instructions:` glob list in `opencode.json` — all matched files are loaded globally

There is no per-file-type or per-path scoping in OpenCode's rule loader. All `instructions:` entries
are included in every LLM context regardless of which file the user is working on.

**Implication for Sentinal:** The OpenCode rules at `targets/opencode/rules/standards-*.md` load on
every session unconditionally. This means Angular-specific rules show up in pure Node.js projects, etc.
This is an OpenCode platform limitation, not a Sentinal bug.

**Workaround options (not currently implemented):**
- Gate rule content with prose like "Only follow these rules when working on Angular components"
- Use the `opencode.json` `instructions:` field with narrower globs (but globs still load globally)
- Wait for OpenCode to add native `paths:` support

**Cross-reference:**
- Claude Code rules with `paths:` → `targets/claude-code/rules/standards-*.md`
- OpenCode equivalents (no `paths:`) → `targets/opencode/rules/standards-*.md`
- Audit tracking → `docs/plans/2026-04-20-claude-opencode-changelog-audit.md` (CC-item OC-goal-verification Truth #9, now superseded by 7c path)
