# Project: Sentinal

**Last Updated:** 2026-04-08

## Overview

Sentinal is a quality enforcement plugin for TypeScript, Angular, and NestJS projects that ships as extensions for both **Claude Code** and **OpenCode**. It runs as an intelligent hook pipeline that checks every file edit, enforces TDD, tracks specs, and provides a `/spec` plan-implement-verify workflow. See `README.md` for user-facing docs.

**Package:** `@endpoint/sentinal` (private registry: `https://npm.cloud.endpoint.gg/`)

## Technology Stack

- **Language:** TypeScript (strict mode, `noImplicitAny`, ES2022, `moduleResolution: bundler`)
- **Runtime:** **Bun ≥ 1.0** (NOT plain Node.js — many features depend on Bun APIs)
- **Test Runner:** `bun test` (bun:test, NOT jest — `package.json` "jest" description is stale)
- **Package Manager:** `bun` (see `bun.lock`)
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.27.1
- **Native deps:** `sqlite-vec` (loaded via Homebrew SQLite in tests), `@xenova/transformers` (384-dim embeddings)
- **Validation:** `zod` 4.x
- **CLI framework:** `commander` 14.x
- **Release:** `semantic-release` (automated versioning via `.releaserc.json`)

## Directory Structure

```
src/                       # Shared TypeScript (consumed by BOTH targets)
├── analysis/              # check_diagnostics, impact_analysis, quality_report MCP tools
├── checkers/              # typescript, angular, nestjs, detect — framework validation
├── cli/                   # Unified `sentinal` CLI (commander dispatcher + commands/)
├── config/                # Config loading
├── dashboard/             # TUI dashboard (10 files)
├── hooks/                 # Claude Code lifecycle hooks (stdin/stdout JSON I/O)
├── mcp/server.ts          # Universal MCP server — registers all tool modules
├── memory/                # SQLite + sqlite-vec vector store + embeddings + MCP tools
├── project/               # project_context MCP tool
├── session/ sessions/     # Session tracking, context window estimation
├── sidecar/               # Long-running HTTP sidecar (Unix socket preferred)
├── spec/                  # Spec workflow engine + MCP tools (spec_*)
├── tdd/                   # TDD cycle state + MCP tools
├── utils/                 # hook-output, file-length, tdd, git, shell
└── worktree/              # Git worktree management + MCP tools

targets/                   # Target-specific wrappers (SHIPPED TO USERS — see sentinal-targets-vs-src.md)
├── claude-code/           # Compiled hooks, rules, commands, agents, .mcp.json
└── opencode/              # Native TS plugin, rules, commands, opencode.json

templates/                 # Command templates with {{placeholders}} — generated into targets/
scripts/                   # generate-commands.js, install.sh, release-build.mjs, embed-assets.mjs
docs/plans/                # /spec workflow plan files (YYYY-MM-DD-<slug>.md)
bin/sentinal.sh            # CLI shim
```

## Key Files

- `src/index.ts` — Barrel exports (the `@endpoint/sentinal` public API)
- `src/cli/index.ts` — CLI entry point (compiled to `dist/sentinal`)
- `src/mcp/server.ts` — MCP server factory (`createSentinalServer`)
- `src/sidecar/client.ts` — `SidecarClient.connect()` (Unix socket + HTTP fallback)
- `targets/claude-code/hooks/hooks.json` — Claude Code hook pipeline definition
- `targets/opencode/plugins/sentinal.ts` — OpenCode plugin entry point
- `targets/opencode/opencode.json` — OpenCode config template (MCP, LSP, permissions)
- `bunfig.toml` — Test preload for sqlite-vec (`src/memory/test-preload.ts`)

## Development Commands

| Task                       | Command                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| Install deps               | `bun install`                                                     |
| Run all tests              | `bun test`                                                        |
| Watch tests                | `bun test:watch`                                                  |
| Run single test file       | `bun test src/path/to/file.test.ts`                               |
| Build Claude Code hooks    | `bun run build:claude` (→ `targets/claude-code/hooks/dist/`)      |
| Build OpenCode plugin      | `bun run build:opencode` (→ `targets/opencode/dist/sentinal.mjs`) |
| Build both targets         | `bun run build:all`                                               |
| Build CLI binary           | `bun run build:cli` (→ `dist/sentinal`)                           |
| Install to Claude Code     | `bun run install:claude-code`                                     |
| Install to OpenCode        | `bun run install:opencode`                                        |
| Deploy plugin to ~/.config | `bun run deploy:opencode`                                         |
| Run MCP server (stdio)     | `bun run mcp`                                                     |
| Memory CLI                 | `bun run memory`                                                  |

## Architecture Notes

- **Dual-target architecture** — shared `src/`, with target-specific wrappers in `targets/claude-code/` and `targets/opencode/`. Most changes need to land in both. See `sentinal-dual-target.md`.
- **Sidecar pattern** — `src/sidecar/server.ts` runs a long-lived HTTP server (Unix socket preferred). Hooks, the MCP server, and the OpenCode plugin all connect via `SidecarClient` to avoid per-invocation SQLite cold starts. See `sentinal-sidecar.md`.
- **Hook I/O protocol** — Claude Code hooks read JSON from stdin, write JSON to stdout. Exit code 2 with stderr = block. See `sentinal-hooks-development.md`.
- **MCP server** — single `sentinal` server exposing 26 tools across 6 domains (memory, spec, tdd, worktree, analysis, project). See `sentinal-mcp-servers.md`.
- **`.sentinal/` sidecar state** — runtime state (`compact-state.json`, `project-memory.json`) lives here, NOT in `.claude/` or `.opencode/`.
- **File length limits** — Sentinal enforces its own rules on itself: warn at 400 lines, block at 600 lines. Test files exempt.
