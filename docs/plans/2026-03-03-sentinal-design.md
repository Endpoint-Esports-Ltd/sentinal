# Sentinal — Claude Code Quality Plugin for TypeScript/Angular/NestJS

**Date:** 2026-03-03
**Status:** VERIFIED

## Overview

Sentinal is a Claude Code plugin that enforces production-grade quality for TypeScript, Angular, and NestJS projects. It mirrors the architecture of [market research](https://github.com/maxritter/market research) but is:

- **TypeScript-native** — all hooks, checkers, and utilities written in TypeScript
- **Framework-specific** — Angular 17+ and NestJS coding standards, compiler checks, DI validation
- **Tailwind-first** — frontend standards built around Tailwind CSS utility-first approach
- **Portable** — Claude Code plugin first, with an abstraction layer for future AI tool support

## Architecture

### Approach: TypeScript-Native Hooks

All hooks, checkers, and utilities are TypeScript, compiled to JS and executed via `bun` or `node`. Rules, commands, and agents remain markdown (same as market research). Single runtime — no Python dependency.

### Project Structure

```
sentinal/
  install.sh                      # Installer script
  package.json                    # Project metadata + scripts
  tsconfig.json                   # TypeScript config for compiling hooks

  plugin/                         # Claude Code plugin (installs to ~/.claude/sentinal/)
    plugin.json                   # Plugin metadata
    hooks.json                    # Hook pipeline definition (6 lifecycle events)
    settings.json                 # Claude Code settings overrides
    .mcp.json                     # MCP server configurations
    .lsp.json                     # LSP server configurations

    hooks/                        # TypeScript hook scripts (compiled to JS)
      tool-redirect.ts            # PreToolUse: blocks WebSearch/WebFetch/EnterPlanMode
      file-checker.ts             # PostToolUse: formatting, linting, types, file length, TDD
      context-monitor.ts          # PostToolUse: monitors context usage %
      spec-stop-guard.ts          # Stop: prevents session exit during active /spec
      pre-compact.ts              # PreCompact: captures state before compaction
      post-compact-restore.ts     # SessionStart(compact): restores state after compaction
      session-end.ts              # SessionEnd: cleanup

      checkers/                   # Language-specific quality checkers
        typescript.ts             # Prettier + ESLint + tsc --noEmit
        angular.ts                # ng build --dry-run, Angular compiler checks
        nestjs.ts                 # NestJS-specific validation (module imports, DI)
        detect.ts                 # Auto-detect package manager, test runner, framework

      utils/                      # Shared utilities
        hook-output.ts            # JSON output helpers (deny, context, block)
        file-length.ts            # Line count enforcement (400 warn, 600 block)
        git.ts                    # Git root finding, diff helpers
        tdd.ts                    # TDD enforcement (check for test file companions)

    rules/                        # Coding standards (markdown, loaded by file pattern)
      standards-typescript.md     # TS: strict types, no any, explicit returns
      standards-angular.md        # Angular 17+: standalone, signals, control flow, Tailwind
      standards-nestjs.md         # NestJS: modules, guards, DTOs, validation, Swagger
      standards-frontend.md       # Frontend: Tailwind, a11y, responsive, ui-ux skills
      standards-backend.md        # Backend: REST, SQL safety, N+1 prevention

    commands/                     # Slash commands (skills)
      spec.md                    # /spec dispatcher (feature vs bugfix routing)
      spec-plan.md               # Feature planning phase
      spec-bugfix-plan.md        # Bugfix planning phase
      spec-implement.md          # TDD implementation phase
      spec-verify.md             # Feature verification phase
      spec-bugfix-verify.md      # Bugfix verification phase
      sync.md                    # /sync — explore codebase, generate project rules
      learn.md                   # /learn — extract knowledge from sessions

    agents/                       # Sub-agent definitions
      plan-reviewer.md           # Reviews plans for completeness
      spec-reviewer.md           # Reviews code for compliance + quality
```

## Hook Pipeline

6 lifecycle events with TypeScript hooks:

| Event | Hook | Purpose |
|-------|------|---------|
| **SessionStart** | `post-compact-restore.ts` | Re-inject active plan path + task state after compaction |
| **PreToolUse** | `tool-redirect.ts` | Block `WebSearch`/`WebFetch` (force MCP), block `EnterPlanMode`/`ExitPlanMode` (force `/spec`), hint at better tool choices |
| **PostToolUse** | `file-checker.ts` | On Write/Edit: Prettier, ESLint, `tsc --noEmit`, Angular/NestJS checks, file length (400 warn/600 block), TDD enforcement |
| **PostToolUse** | `context-monitor.ts` | Monitor context usage %, warn at thresholds, prompt `/learn` |
| **PreCompact** | `pre-compact.ts` | Capture active plan + task state to memory |
| **Stop** | `spec-stop-guard.ts` | Block session exit if active spec plan is PENDING/COMPLETE |

### file-checker.ts Details

- Auto-detects package manager from lockfile (npm/yarn/pnpm/bun)
- Auto-detects test runner from config (Jest/Vitest/Karma)
- **Prettier**: `npx prettier --check` then `--write` if needed
- **ESLint**: `npx eslint --fix`
- **TypeScript**: `npx tsc --noEmit` for type errors
- **Angular**: `ng build --dry-run` for template/compiler errors (when Angular project detected)
- **NestJS**: module structure validation, circular dependency detection (when NestJS project detected)
- **File length**: warn at 400 lines, block at 600 lines (test files exempt)
- **TDD**: check for companion test files, warn if missing

### tool-redirect.ts Details

- Denies `WebSearch`, `WebFetch` → suggests MCP `web-search` / `web-fetch`
- Denies `EnterPlanMode`, `ExitPlanMode` → forces `/spec` workflow
- Hints: suggests Vexor for vague Grep patterns, direct tools instead of Explore agents

## Coding Standards

### standards-typescript.md

Activates on: `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.mjs`

- Strict types: `noImplicitAny`, no `any` casts, explicit return types on public methods
- Auto-detect package manager from lockfile
- `node:` prefix for built-in imports
- kebab-case filenames
- Prefer `const` over `let`, destructuring, template literals
- Barrel exports pattern for modules

### standards-angular.md

Activates on: `**/*.component.ts`, `**/*.directive.ts`, `**/*.pipe.ts`, `**/*.module.ts`, Angular `**/*.html`

- Standalone components by default (Angular 17+)
- Signals over RxJS for component state
- `@if`/`@for`/`@switch` control flow syntax (Angular 17+)
- OnPush change detection everywhere
- Tailwind CSS for styling (no component CSS files unless encapsulation needed)
- Smart/dumb component pattern
- Lazy loading for route modules
- Reactive forms over template-driven

### standards-nestjs.md

Activates on: `**/*.controller.ts`, `**/*.service.ts`, `**/*.module.ts`, `**/*.guard.ts`, `**/*.interceptor.ts`, `**/*.dto.ts`, `**/*.entity.ts`

- DTOs with `class-validator` decorators for all inputs
- Guards for authentication, interceptors for cross-cutting concerns
- Repository pattern for data access
- Custom exceptions extending `HttpException`
- Module encapsulation — export only what's needed
- Config via `@nestjs/config` with validation
- Swagger/OpenAPI decorators on all endpoints

### standards-frontend.md

Activates on: `**/*.html`, `**/*.css`, `**/*.scss`, `**/*.component.ts`

- Tailwind CSS utility-first approach
- WCAG 2.1 AA accessibility minimum
- Responsive mobile-first design
- References `ui-ux-pro-max` and `frontend-design` skills for design quality
- Semantic HTML, proper ARIA labels
- Performance: lazy images, virtual scrolling for lists, bundle splitting

### standards-backend.md

Activates on: `**/controllers/**`, `**/services/**`, `**/repositories/**`, `**/entities/**`, `**/migrations/**`

- RESTful API design with proper HTTP methods/status codes
- Parameterized queries (SQL injection prevention)
- N+1 query prevention with eager loading hints
- TypeORM/Prisma best practices
- Reversible migrations only
- Rate limiting, CORS, helmet security middleware

## /spec Workflow

```
/spec "task description"
  → Dispatcher (detect feature vs bugfix, ask worktree preference)
  → Feature: spec-plan (explore codebase, write plan, optional plan-reviewer agent)
  → Bugfix:  spec-bugfix-plan (trace to file:line, Behavior Contract)
  → User approves plan
  → spec-implement (TDD loop: RED test → GREEN implementation → REFACTOR)
  → Feature: spec-verify (spec-reviewer agent + automated checks + E2E via Playwright)
  → Bugfix:  spec-bugfix-verify (Behavior Contract audit + tests)
  → VERIFIED (or loop back to implement if issues found)
```

### Angular/NestJS Enhancements

- **spec-plan** understands Angular module boundaries, NestJS DI graph, suggests which modules/services to modify
- **spec-implement** enforces Angular/NestJS patterns: creates DTOs for endpoints, standalone components, proper module imports
- **spec-verify** includes `ng build` (production build), `ng lint`, `tsc --noEmit`, and Playwright E2E verification

### Stop Guard

Prevents Claude from ending the session mid-spec. 60-second cooldown escape hatch. Plan files stored in `docs/plans/YYYY-MM-DD-<slug>.md`.

## Settings & Configuration

### settings.json

- Pre-approved tools: Bash, Read, Write, Edit, Grep, Glob, MCP tools, Skills, Tasks
- Environment variables enabling tasks, tool search, LSP
- Extended thinking enabled
- Custom spinner tips explaining Sentinal features

### .mcp.json — 5 MCP Servers

1. **context7** — Library docs (Angular, NestJS, RxJS, Tailwind)
2. **mem-search** — Persistent memory
3. **web-search** — DuckDuckGo/Bing/Exa
4. **grep-mcp** — GitHub code search
5. **web-fetch** — Full page fetching via Playwright

### .lsp.json — Language Servers

- **vtsls** for TypeScript/JavaScript
- **Angular Language Service** for template checking

## Semantic Code Search

Uses Vexor as-is (language-agnostic, already TypeScript-aware). Installed as a dependency, configured in rules as the primary search tool.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/sentinal/main/install.sh | bash
```

1. Check prerequisites (Node.js 18+, package manager)
2. Install Sentinal plugin to `~/.claude/sentinal/`
3. Copy rules to `~/.claude/rules/`
4. Configure hooks, MCP servers, LSP
5. Install VS Code extensions (Angular Language Service, Prettier, ESLint)

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| TypeScript-native hooks | Single runtime, dogfoods the language it enforces |
| Full /spec workflow | Proven structure from market research, adapted for Angular/NestJS |
| Auto-detect tooling | Projects use different package managers and test runners |
| Vexor for semantic search | Already works with TypeScript, no need to reimplement |
| Angular 17+ defaults | Modern Angular patterns (standalone, signals, control flow) |
| Tailwind-first frontend | User requirement, most common choice in modern Angular |
| Full quality suite on edit | Catches issues immediately, not at commit time |
