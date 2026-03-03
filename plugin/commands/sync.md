---
description: Sync project rules and skills with codebase
argument-hint: ""
user-invocable: true
model: sonnet
---

# /sync — Codebase Sync

**Explore the codebase and generate/update project-specific rules and skills.**

## Process

1. **Read existing rules** in `.claude/rules/` — understand what's already documented
2. **Explore the codebase** using Vexor and file browsing:
   - Detect frameworks (Angular, NestJS, or both)
   - Identify package manager, test runner, database ORM
   - Find key architectural patterns (folder structure, naming conventions)
   - Discover custom utilities and shared code
3. **Generate/update `.claude/rules/project.md`** with:
   - Project overview (what it does, tech stack)
   - Key directories and their purposes
   - Custom conventions discovered
   - Build/test/deploy commands
4. **Document MCP servers** if any project-specific ones are configured
5. **Discover skills** that might be useful and suggest creating them

## Output

After sync, summarize what was discovered and created/updated.
