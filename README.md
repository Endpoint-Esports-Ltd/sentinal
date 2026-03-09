# Sentinal

Quality enforcement plugin for TypeScript, Angular, and NestJS projects — supports **Claude Code** and **OpenCode**.

Sentinal runs as an intelligent hook pipeline inside Claude Code or OpenCode, automatically checking every file edit against framework-specific rules, running formatters and linters, enforcing TDD practices, and providing structured development workflows.

## Supported AI Assistants

| Assistant | Status | Installation |
|-----------|--------|--------------|
| **Claude Code** | Full support | `./install.sh claude` |
| **OpenCode** | Full support | `./install.sh opencode` |

Both assistants can be used simultaneously — Sentinal detects which environment is running. Running `./install.sh` with no argument auto-detects available assistants.

## Features

- **Automatic Quality Checks** — Prettier, ESLint, and `tsc --noEmit` run on every file edit (Claude Code: via hooks, OpenCode: built-in + plugin)
- **Framework-Specific Rules** — Targeted standards for Angular 17+ (standalone, signals, control flow) and NestJS (DTOs, guards, Swagger)
- **TDD Enforcement** — Warns when implementation files lack companion test files
- **File Length Guardrails** — Warns at 400 lines, blocks at 600 lines (test files exempt)
- **Structured `/spec` Workflow** — Plan-implement-verify cycle
- **Context Monitoring** — Tracks context usage and suggests knowledge extraction at thresholds
- **Tool Redirection** — Hints on better tool choices (MCP alternatives, semantic search)
- **Compact Resilience** — Preserves active plan state across context window compaction
- **Persistent Memory** — Vector-based knowledge storage with automatic capture/restore across sessions
- **MCP Servers** — Pre-configured context7 (library docs), web-search, grep-mcp (GitHub code search), web-fetch, and sentinal-memory
- **LSP Integration** — TypeScript language server (vtsls) for go-to-definition, references, and hover

## Requirements

- **Bun** 1.0+ (required runtime)
- **Node.js** 18+
- **Claude Code** or **OpenCode**

## Installation

### Claude Code

```bash
git clone <repo-url> sentinal
cd sentinal
./install.sh claude
```

The installer:
1. Verifies Node.js 18+ and Bun are installed
2. Installs dependencies via `bun install`
3. Compiles TypeScript hooks via `bun run build`
4. Copies the plugin to `~/.claude/plugins/sentinal/`

After installation, register the plugin:

```bash
claude plugins add ~/.claude/plugins/sentinal
```

Then run `/sync` in a Claude Code session within your project to generate project-specific rules.

### OpenCode

```bash
git clone <repo-url> sentinal
cd sentinal
./install.sh opencode
```

The installer:
1. Verifies OpenCode, Bun, and `jq` are installed
2. Installs `@endpoint/sentinal` as a package dependency via `bun add`
3. Merges plugin config, commands, and rules into OpenCode's config directory using `jq`
4. Configures MCP servers (including `sentinal-memory` via `bunx`)
5. Creates global `AGENTS.md` with rule references

Then run `/sync` in an OpenCode session within your project:

```bash
opencode
/sync
```

### Both Assistants

Claude Code and OpenCode can coexist. Each uses separate config directories:
- Claude Code: `~/.claude/plugins/sentinal/`
- OpenCode: `~/.config/opencode/` (plugin, commands, rules merged into existing config)

Install for both at once:

```bash
./install.sh both
```

## Project Structure

```
sentinal/
├── src/                              # Shared TypeScript source
│   ├── index.ts                      # Barrel exports (API surface)
│   ├── hooks/                        # Claude Code lifecycle hooks
│   │   ├── tool-redirect.ts          # PreToolUse: block/redirect tools
│   │   ├── file-checker.ts           # PostToolUse: quality checks on file edits
│   │   ├── context-monitor.ts        # PostToolUse: track context usage %
│   │   ├── spec-stop-guard.ts        # Stop: prevent exit during /spec
│   │   ├── pre-compact.ts            # PreCompact: save plan state
│   │   ├── post-compact-restore.ts   # SessionStart: restore after compaction
│   │   ├── session-end.ts            # SessionEnd: cleanup
│   │   └── memory-observer.ts        # PostToolUse: capture memories from edits
│   ├── checkers/                     # Framework detection & validation
│   │   ├── detect.ts                 # Auto-detect package manager, test runner, frameworks
│   │   ├── typescript.ts             # Prettier, ESLint, tsc checks
│   │   ├── angular.ts                # Angular template/compiler checks
│   │   └── nestjs.ts                 # NestJS pattern checks (decorators, DTOs)
│   ├── memory/                       # Persistent memory system
│   │   ├── store.ts                  # SQLite + sqlite-vec storage
│   │   ├── vector-store.ts           # Vector similarity search
│   │   ├── embeddings.ts             # @xenova/transformers 384-dim embeddings
│   │   ├── service.ts                # High-level memory service
│   │   ├── capture.ts                # Automatic memory capture from sessions
│   │   ├── restore.ts                # Memory restore on session start
│   │   ├── mcp-server.ts             # MCP server (5 tools)
│   │   └── cli.ts                    # CLI for memory management
│   ├── utils/                        # Shared utilities
│   │   ├── hook-output.ts            # JSON I/O helpers for hooks
│   │   ├── file-length.ts            # Line count enforcement
│   │   ├── tdd.ts                    # Test file detection
│   │   └── git.ts                    # Git root detection
│   └── db/                           # Database utilities
│       ├── database.ts               # SQLite connection management
│       └── schema.ts                 # Schema definitions
│
├── bin/
│   └── sentinal-memory.sh            # Shell shim for `bunx sentinal-memory`
│
├── targets/
│   ├── claude-code/                  # Claude Code target
│   │   ├── tsconfig.json             # TypeScript config (builds to hooks/dist/)
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json           # Plugin metadata
│   │   ├── hooks/
│   │   │   ├── hooks.json            # Hook pipeline definition
│   │   │   └── dist/                 # Compiled JS (build output, gitignored)
│   │   ├── rules/                    # 5 coding standards rule sets
│   │   ├── commands/                 # Slash commands (/spec, /sync, /learn)
│   │   ├── agents/                   # Sub-agents (plan-reviewer, spec-reviewer)
│   │   ├── settings.json             # Claude Code settings & permissions
│   │   ├── .mcp.json                 # MCP server configuration
│   │   ├── .lsp.json                 # Language server configuration
│   │   ├── install.sh                # Claude Code installer
│   │   └── uninstall.sh              # Claude Code uninstaller
│   │
│   └── opencode/                     # OpenCode target
│       ├── plugins/
│       │   └── sentinal.ts           # Plugin (imports from @endpoint/sentinal)
│       ├── commands/                  # Slash commands
│       ├── rules/                    # Coding standards
│       ├── opencode.json             # MCP, LSP, permissions config
│       ├── install.sh                # OpenCode installer (jq-based config merging)
│       └── uninstall.sh              # OpenCode uninstaller
│
├── templates/
│   └── commands/                     # Command templates with {{model}} placeholders
│
├── scripts/
│   └── generate-commands.js          # Generates target-specific commands from templates
│
├── install.sh                        # Multi-target dispatcher
├── uninstall.sh                      # Multi-target dispatcher
├── package.json                      # @endpoint/sentinal (private registry)
└── bunfig.toml                       # Bun test configuration
```

## How It Works

Sentinal integrates with each assistant through its native extension mechanism. Both targets share the same core logic (`src/`), with target-specific wrappers in `targets/`.

### Claude Code: Hook Pipeline

Claude Code uses compiled TypeScript hooks that intercept lifecycle events:

| Event | Hook | What It Does |
|-------|------|-------------|
| `SessionStart` | post-compact-restore | Restores the active `/spec` plan path after context compaction |
| `SessionStart` | memory-restore | Restores relevant memories for the current project |
| `PreToolUse` | tool-redirect | Denies `WebSearch`/`WebFetch` (use MCP instead), blocks `EnterPlanMode` (use `/spec`), hints on vague Grep patterns |
| `PostToolUse` | file-checker | Runs Prettier, ESLint, `tsc`, framework-specific checks, file length enforcement, and TDD checks on every `Write`/`Edit` |
| `PostToolUse` | memory-observer | Captures significant patterns and solutions from edits |
| `PostToolUse` | context-monitor | Monitors context window usage %, warns at 65/75/85%+ thresholds |
| `PreCompact` | pre-compact | Saves active plan path and metadata to `.sentinal/compact-state.json` |
| `Stop` | spec-stop-guard | Blocks session exit if a `/spec` plan is in PENDING or COMPLETE state |
| `SessionEnd` | session-end | Captures end-of-session memories and cleanup |

Hooks are compiled from `src/` to `targets/claude-code/hooks/dist/` and executed by Bun at runtime. The hook I/O protocol uses JSON on stdin/stdout (see [Hook I/O Protocol](#hook-io-protocol) below).

### OpenCode: Plugin Events

OpenCode uses a TypeScript plugin (`targets/opencode/plugins/sentinal.ts`) executed natively by Bun:

| Event | What It Does |
|-------|-------------|
| `tool.execute.before` | Hints on better tool choices |
| `tool.execute.after` | Quality checks on file edits (file length, TDD, NestJS patterns, tsc) |
| `experimental.session.compacting` | Inject /spec plan state into context summary |
| `session.created` | Restore state after session start |
| `session.idle` | Warn about incomplete /spec plans |

The plugin imports shared checkers and utilities from the `@endpoint/sentinal` package, so the same quality logic runs in both targets.

### Architecture Comparison

The two targets have different extension mechanisms but deliver the same quality enforcement:

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| **Extension type** | Compiled hook scripts | Native TypeScript plugin |
| **Hook system** | 6 lifecycle events | Plugin events |
| **Formatters** | Explicit in hooks | Built-in automatically |
| **Runtime** | Compiled JS executed by Bun | Native TypeScript via Bun |
| **Tool blocking** | Exit code 2 | Throw Error |
| **Compaction** | Save state to file | Inject context directly |

**Claude Code advantages:**
- Full tool blocking/denial via exit codes
- Fine-grained hook matchers (regex on tool names)
- Sub-agents for background review tasks

**OpenCode advantages:**
- Built-in Prettier/ESLint on every file write (no manual execution)
- Native TypeScript execution (no compilation step)
- Direct context injection during compaction
- Simpler plugin development cycle

### File Edit Flow

When the assistant edits a TypeScript file, quality checks run automatically:

1. Checks line count (warns at 400+, blocks at 600+)
2. Detects the project's package manager from lockfiles (pnpm, yarn, bun, or npm)
3. Runs **Prettier** — auto-formats if needed (Claude Code only; OpenCode handles this built-in)
4. Runs **ESLint** — auto-fixes lint issues (Claude Code only; OpenCode handles this built-in)
5. Runs **TypeScript** — `tsc --noEmit` for type errors
6. If Angular file detected — runs `ng build --dry-run` for template/compiler errors
7. If NestJS file detected — checks for `@ApiTags`, `class-validator`, `@Entity` decorators
8. Checks for companion test file — warns if missing

All feedback is returned as structured hints that the assistant acts on automatically.

### Framework Detection

Sentinal auto-detects your project setup:

| Detection | Method |
|-----------|--------|
| **Package manager** | Lockfile presence: `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` / `package-lock.json` |
| **Test runner** | Config files: `jest.config.*` / `vitest.config.*` / `karma.conf.*` |
| **Framework** | Dependency inspection: `@angular/core` / `@nestjs/core` in `package.json` |

### Hook I/O Protocol

Claude Code hooks receive JSON on stdin and output JSON to stdout:

```typescript
// Input (from Claude Code)
{
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// Output — deny a tool (exit code 2)
{ permissionDecision: "deny", reason: "Use MCP web-search instead" }

// Output — provide a hint (exit code 0)
{ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "..." } }

// Output — block an action (exit code 2)
{ decision: "block", reason: "File exceeds 600 lines" }
```

## Coding Standards

Sentinal ships 5 rule sets that activate based on file patterns:

### TypeScript (`**/*.ts`, `**/*.tsx`)
- Strict types: `noImplicitAny`, no `any` casts, explicit return types
- `node:` prefix for built-in imports
- kebab-case filenames
- Prefer `const`, destructuring, template literals
- Barrel exports, no circular imports, type-only imports
- Async/await over `.then()`, typed errors, dependency injection

### Angular (`.component.ts`, `.directive.ts`, `.pipe.ts`, etc.)
- Standalone components by default (Angular 17+)
- `OnPush` change detection everywhere
- Signals over RxJS for component state
- Built-in control flow: `@if`, `@for`, `@switch` (not `*ngIf`/`*ngFor`)
- Tailwind CSS styling, smart/dumb component pattern
- Lazy loading routes, functional guards, reactive typed forms
- Virtual scrolling for lists > 100 items

### NestJS (`.controller.ts`, `.service.ts`, `.module.ts`, etc.)
- Module encapsulation, dependency injection (never `new Service()`)
- Repository pattern for data access
- One controller per resource, Swagger decorators on every endpoint
- DTOs with `class-validator` for all inputs, separate Create/Update/Response DTOs
- Guards for auth, interceptors for cross-cutting concerns
- TypeORM or Prisma with migrations

### Frontend (`.html`, `.css`, `.scss`, `.component.html`)
- Tailwind CSS utility-first
- WCAG 2.1 AA accessibility: semantic HTML, ARIA labels, keyboard nav, 4.5:1 contrast
- Responsive mobile-first, fluid typography with `clamp()`
- Lazy images, bundle splitting, preload critical assets

### Backend (`controllers/`, `services/`, `entities/`, etc.)
- RESTful API design with consistent response format
- Parameterized queries (SQL injection prevention), input validation at boundaries
- Rate limiting, CORS, Helmet middleware
- Short-lived JWTs + refresh tokens
- Migrations only (no `synchronize: true`), reversible migrations
- N+1 prevention, global exception filter

## Commands

### `/spec` — Structured Development Workflow

The primary workflow command. Provides a plan-implement-verify cycle for features and bugfixes.

```
/spec Add user profile component with avatar upload
/spec Fix the 404 error on the dashboard route
/spec docs/plans/2026-03-04-user-profile.md    # Resume existing plan
```

**Flow:**

```
/spec <description>
  -> Detect type (feature vs bugfix)
  -> Plan phase (explore codebase, write plan, get approval)
  -> Implement phase (TDD loop per task)
  -> Verify phase (tests, execution, code review)
  -> VERIFIED
```

Plan files are written to `docs/plans/YYYY-MM-DD-<slug>.md` with status tracking (PENDING -> COMPLETE -> VERIFIED).

**Sub-agents** (Claude Code only, launched in background during verification):
- **plan-reviewer** — Reviews feature plans with > 3 tasks for completeness
- **spec-reviewer** — Reviews implementation for quality and standards compliance

### `/sync` — Generate Project Rules

Explores your codebase and generates project-specific rules tailored to your stack, patterns, and conventions.

```
/sync
```

### `/learn` — Extract Session Knowledge

Captures non-obvious solutions, workarounds, and workflows from the current session into persistent memory for future sessions.

```
/learn
```

## MCP Servers

Sentinal configures 5 MCP servers for enhanced capabilities:

| Server | Purpose | Package |
|--------|---------|---------|
| **context7** | Up-to-date library/framework documentation | `@upstash/context7-mcp` |
| **web-search** | Web search via DuckDuckGo/Bing/Exa | `open-websearch` |
| **grep-mcp** | GitHub code search across 1M+ public repos | `mcp.grep.app` |
| **web-fetch** | Full web page fetching via Playwright | `fetcher-mcp` |
| **sentinal-memory** | Persistent vector memory (save, search, list, delete, stats) | `@endpoint/sentinal` |

These are preferred over built-in web tools. In Claude Code, the `tool-redirect` hook blocks `WebSearch`/`WebFetch` in favor of the MCP servers.

## Development

### Build

```bash
bun install                # Install dependencies
bun run build              # Compile Claude Code hooks to targets/claude-code/hooks/dist/
bun run build:opencode     # Bundle OpenCode plugin to targets/opencode/dist/
bun run build:all          # Build both targets
bun run build:watch        # Watch mode (Claude Code hooks)
```

### Test

```bash
bun test             # Run all tests
bun test:watch       # Watch mode
```

### Architecture

The codebase is organized into shared layers consumed by both targets:

- **Hooks** (`src/hooks/`) — Lifecycle event handlers for Claude Code. Each reads JSON from stdin, processes it, and outputs JSON to stdout. The hook pipeline is defined in `targets/claude-code/hooks/hooks.json`.
- **Checkers** (`src/checkers/`) — Framework-specific validation logic. Used by both Claude Code hooks and the OpenCode plugin. Auto-detect project tooling and run appropriate checks.
- **Memory** (`src/memory/`) — Persistent vector-based knowledge storage using SQLite + sqlite-vec for embeddings. Exposed as an MCP server with 5 tools. Available to both targets.
- **Utils** (`src/utils/`) — Shared helpers for hook I/O, file length checks, TDD enforcement, and git operations.

### Claude Code Development

The Claude Code target is located in `targets/claude-code/`:

```bash
bun run build              # Compile hooks
./install.sh claude        # Install to ~/.claude/plugins/sentinal/
```

**Adding a new hook:**
1. Create `src/hooks/my-hook.ts` implementing the hook I/O protocol
2. Add a test file `src/hooks/my-hook.test.ts`
3. Register the hook in `targets/claude-code/hooks/hooks.json` with the appropriate event and matcher
4. Build and reinstall: `bun run build && ./install.sh claude`

### OpenCode Development

The OpenCode target is located in `targets/opencode/`:

```bash
./install.sh opencode      # Install to ~/.config/opencode/
```

OpenCode plugins are written in TypeScript and executed directly by Bun. No compilation step required. The plugin imports shared logic from the `@endpoint/sentinal` package.

**Adding a new feature:**
1. Edit `targets/opencode/plugins/sentinal.ts` to add new plugin events
2. Reinstall: `./install.sh opencode`

### Adding a New Checker

Checkers are shared between both targets:

1. Create `src/checkers/my-framework.ts` with a check function
2. Add detection logic to `src/checkers/detect.ts`
3. Call the checker from `src/hooks/file-checker.ts` (Claude Code) and/or `targets/opencode/plugins/sentinal.ts` (OpenCode)
4. Add tests and build

## Settings

### Claude Code

Configured via `targets/claude-code/settings.json`:

| Setting | Value | Purpose |
|---------|-------|---------|
| `CLAUDE_CODE_ENABLE_TASKS` | `true` | Enable task management tools |
| `ENABLE_TOOL_SEARCH` | `true` | Enable MCP tool discovery |
| `ENABLE_LSP_TOOL` | `true` | Enable LSP integration |
| `alwaysThinkingEnabled` | `true` | Extended thinking for better analysis |
| `respectGitignore` | `false` | Plugin needs access to `dist/` files |

Pre-approved permissions include common dev tools (npm, bun, ng, nest, tsc, prettier, eslint, jest, vitest, git), file operations, MCP servers, `/spec` workflow skills, and sub-agents.

### OpenCode

Configured via `targets/opencode/opencode.json`:

- **Plugin registration** — `sentinal.ts` added to the `plugin[]` array
- **MCP servers** — All 5 MCP servers configured with appropriate transport types
- **LSP** — TypeScript language server for code intelligence

OpenCode settings are merged surgically into existing user config using `jq`, preserving any pre-existing configuration.

## License

Proprietary — UNLICENSED
