# Sentinal

Quality enforcement plugin for TypeScript, Angular, and NestJS projects — supports **Claude Code** and **OpenCode**.

Sentinal runs as an intelligent hook pipeline inside Claude Code or OpenCode, automatically checking every file edit against framework-specific rules, running formatters and linters, enforcing TDD practices, and providing structured development workflows.

## Supported AI Assistants

| Assistant | Status | Installation |
|-----------|--------|--------------|
| **Claude Code** | Primary | `./install.sh` |
| **OpenCode** | Supported | `./targets/opencode/install.sh` |

Both assistants can be used simultaneously — Sentinal detects which environment is running.

## Features

- **Automatic Quality Checks** — Prettier, ESLint, and `tsc --noEmit` run on every file edit (Claude Code: via hooks, OpenCode: built-in + plugin)
- **Framework-Specific Rules** — Targeted standards for Angular 17+ (standalone, signals, control flow) and NestJS (DTOs, guards, Swagger)
- **TDD Enforcement** — Warns when implementation files lack companion test files
- **File Length Guardrails** — Warns at 400 lines, blocks at 600 lines (test files exempt)
- **Structured `/spec` Workflow** — Plan-implement-verify cycle
- **Context Monitoring** — Tracks context usage and suggests knowledge extraction at thresholds
- **Tool Redirection** — Hints on better tool choices (MCP alternatives, semantic search)
- **Compact Resilience** — Preserves active plan state across context window compaction
- **MCP Servers** — Pre-configured context7 (library docs), web-search, grep-mcp (GitHub code search), and web-fetch
- **LSP Integration** — TypeScript language server (vtsls) for go-to-definition, references, and hover

## Requirements

- **Node.js** 18+
- **Bun** 1.0+
- **Claude Code** or **OpenCode**

## Installation

### Claude Code

```bash
git clone <repo-url> sentinal
cd sentinal
bash install.sh
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
bash targets/opencode/install.sh
```

The OpenCode installer:
1. Verifies OpenCode is installed
2. Copies the plugin to `~/.config/opencode/plugins/`
3. Installs commands to `~/.config/opencode/commands/`
4. Copies rules to `~/.config/opencode/rules/`
5. Creates global `AGENTS.md` with rule references
6. Configures MCP servers and permissions

Then run `/sync` in an OpenCode session within your project:

```bash
opencode
/sync
```

### Both Assistants

Claude Code and OpenCode can coexist! Each uses separate config directories:
- Claude Code: `~/.claude/plugins/sentinal/`
- OpenCode: `~/.config/opencode/plugins/sentinal.ts`

## Project Structure

```
sentinal/
├── src/                          # TypeScript source (shared)
│   ├── hooks/                    # 6 lifecycle hooks (Claude Code)
│   │   ├── tool-redirect.ts      # PreToolUse: block/redirect tools
│   │   ├── file-checker.ts       # PostToolUse: quality checks on file edits
│   │   ├── context-monitor.ts    # PostToolUse: track context usage %
│   │   ├── spec-stop-guard.ts    # Stop: prevent exit during /spec
│   │   ├── pre-compact.ts        # PreCompact: save plan state
│   │   ├── post-compact-restore.ts  # SessionStart: restore after compaction
│   │   └── session-end.ts        # SessionEnd: cleanup
│   ├── checkers/                 # Framework detection & validation
│   │   ├── detect.ts             # Auto-detect package manager, test runner, frameworks
│   │   ├── typescript.ts         # Prettier, ESLint, tsc checks
│   │   ├── angular.ts            # Angular template/compiler checks
│   │   └── nestjs.ts            # NestJS pattern checks (decorators, DTOs)
│   └── utils/                    # Shared utilities
│       ├── hook-output.ts        # JSON I/O helpers for hooks
│       ├── file-length.ts        # Line count enforcement
│       ├── tdd.ts               # Test file detection
│       └── git.ts               # Git root detection
│
├── targets/
│   ├── claude-code/              # Claude Code target (original)
│   │   ├── plugin/               # Plugin structure
│   │   │   ├── hooks/            # Hook pipeline
│   │   │   ├── rules/            # Coding standards
│   │   │   ├── commands/         # Slash commands
│   │   │   └── ...
│   │   └── install.sh
│   │
│   └── opencode/                 # OpenCode target (NEW)
│       ├── plugins/
│       │   └── sentinal.ts       # Plugin with hooks
│       ├── tools/
│       │   └── sentinal-check.ts # Custom quality check tool
│       ├── commands/              # Slash commands
│       ├── rules/                 # Coding standards
│       ├── opencode.json         # MCP, LSP, permissions
│       └── install.sh            # OpenCode installer
│
├── plugin/                       # Legacy (Claude Code)
├── install.sh                    # Claude Code installer
├── package.json
└── tsconfig.json
```
sentinal/
├── src/                          # TypeScript source
│   ├── hooks/                    # 6 lifecycle hooks
│   │   ├── tool-redirect.ts      # PreToolUse: block/redirect tools
│   │   ├── file-checker.ts       # PostToolUse: quality checks on file edits
│   │   ├── context-monitor.ts    # PostToolUse: track context usage %
│   │   ├── spec-stop-guard.ts    # Stop: prevent exit during /spec
│   │   ├── pre-compact.ts        # PreCompact: save plan state
│   │   ├── post-compact-restore.ts  # SessionStart: restore after compaction
│   │   └── session-end.ts        # SessionEnd: cleanup
│   ├── checkers/                 # Framework detection & validation
│   │   ├── detect.ts             # Auto-detect package manager, test runner, frameworks
│   │   ├── typescript.ts         # Prettier, ESLint, tsc checks
│   │   ├── angular.ts            # Angular template/compiler checks
│   │   └── nestjs.ts             # NestJS pattern checks (decorators, DTOs)
│   └── utils/                    # Shared utilities
│       ├── hook-output.ts        # JSON I/O helpers for hooks
│       ├── file-length.ts        # Line count enforcement
│       ├── tdd.ts                # Test file detection
│       └── git.ts                # Git root detection
├── plugin/                       # Installed plugin structure
│   ├── .claude-plugin/
│   │   └── plugin.json           # Plugin metadata
│   ├── hooks/
│   │   ├── hooks.json            # Hook pipeline definition
│   │   └── dist/                 # Compiled JS (generated by build)
│   ├── rules/                    # 5 coding standards rule sets
│   ├── commands/                 # Slash commands (/spec, /sync, /learn)
│   ├── agents/                   # Sub-agents (plan-reviewer, spec-reviewer)
│   ├── settings.json             # Claude Code settings & permissions
│   ├── .mcp.json                 # MCP server configuration
│   └── .lsp.json                 # Language server configuration
├── install.sh                    # One-step installer
├── package.json
└── tsconfig.json
```

## How It Works

### Claude Code Hook Pipeline

Sentinal registers 6 lifecycle hooks that intercept Claude Code events:

| Event | Hook | What It Does |
|-------|------|-------------|
| `SessionStart` | post-compact-restore | Restores the active `/spec` plan path after context compaction |
| `PreToolUse` | tool-redirect | Denies `WebSearch`/`WebFetch` (use MCP instead), blocks `EnterPlanMode` (use `/spec`), hints on vague Grep patterns |
| `PostToolUse` | file-checker | Runs Prettier, ESLint, `tsc`, framework-specific checks, file length enforcement, and TDD checks on every `Write`/`Edit` |
| `PostToolUse` | context-monitor | Monitors context window usage %, warns at 65/75/85%+ thresholds |
| `PreCompact` | pre-compact | Saves active plan path and metadata to `.sentinal/compact-state.json` |
| `Stop` | spec-stop-guard | Blocks session exit if a `/spec` plan is in PENDING or COMPLETE state |

### File Edit Flow

When Claude edits a TypeScript file, the `file-checker` hook:

1. Checks line count (warns at 400+, blocks at 600+)
2. Detects the project's package manager from lockfiles (pnpm, yarn, bun, or npm)
3. Runs **Prettier** — auto-formats if needed
4. Runs **ESLint** — auto-fixes lint issues
5. Runs **TypeScript** — `tsc --noEmit` for type errors
6. If Angular file detected — runs `ng build --dry-run` for template/compiler errors
7. If NestJS file detected — checks for `@ApiTags`, `class-validator`, `@Entity` decorators
8. Checks for companion test file — warns if missing

All feedback is returned as structured hints that Claude acts on automatically.

### OpenCode Implementation

OpenCode has a different architecture that provides some advantages:

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| **Hook system** | 6 lifecycle events | Plugin events |
| **Formatters** | Manual in hooks | Built-in automatically |
| **TypeScript** | Compiled JS | Native execution |
| **Tool blocking** | Exit code 2 | Throw Error |
| **Compaction** | Save to file | Inject context directly |

#### OpenCode Plugin Events

The OpenCode plugin (`targets/opencode/plugins/sentinal.ts`) implements:

| Event | What It Does |
|-------|-------------|
| `tool.execute.before` | Hints on better tool choices |
| `tool.execute.after` | Quality checks on file edits (file length, TDD, NestJS patterns, tsc) |
| `experimental.session.compacting` | Inject /spec plan state into context summary |
| `session.created` | Restore state after session start |
| `session.idle` | Warn about incomplete /spec plans |

#### Key Differences

1. **Built-in Formatters**: OpenCode automatically runs Prettier, ESLint, gofmt, etc. on every file write. No manual formatter execution needed.

2. **Native TypeScript**: OpenCode plugins are written in TypeScript and executed directly by Bun. No compilation step required.

3. **Better Compaction**: The `experimental.session.compacting` hook can directly inject context into the summary, rather than saving to a file.

4. **Tool Hints**: OpenCode can't fully block tools, but can log warnings/hints that are shown to the user.

### Framework Detection

Sentinal auto-detects your project setup:

| Detection | Method |
|-----------|--------|
| **Package manager** | Lockfile presence: `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` / `package-lock.json` |
| **Test runner** | Config files: `jest.config.*` / `vitest.config.*` / `karma.conf.*` |
| **Framework** | Dependency inspection: `@angular/core` / `@nestjs/core` in `package.json` |

### Hook I/O Protocol

Hooks receive JSON on stdin and output JSON to stdout:

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
  → Detect type (feature vs bugfix)
  → Plan phase (explore codebase, write plan, get approval)
  → Implement phase (TDD loop per task)
  → Verify phase (tests, execution, code review)
  → VERIFIED
```

Plan files are written to `docs/plans/YYYY-MM-DD-<slug>.md` with status tracking (PENDING → COMPLETE → VERIFIED).

**Sub-agents** (launched in background during verification):
- **plan-reviewer** — Reviews feature plans with > 3 tasks for completeness
- **spec-reviewer** — Reviews implementation for quality and standards compliance

### `/sync` — Generate Project Rules

Explores your codebase and generates project-specific rules tailored to your stack, patterns, and conventions.

```
/sync
```

### `/learn` — Extract Session Knowledge

Captures non-obvious solutions, workarounds, and workflows from the current session for future reference.

```
/learn
```

## MCP Servers

Sentinal configures 4 MCP servers for enhanced capabilities:

| Server | Purpose | Package |
|--------|---------|---------|
| **context7** | Up-to-date library/framework documentation | `@upstash/context7-mcp` |
| **web-search** | Web search via DuckDuckGo/Bing/Exa | `open-websearch` |
| **grep-mcp** | GitHub code search across 1M+ public repos | `mcp.grep.app` |
| **web-fetch** | Full web page fetching via Playwright | `fetcher-mcp` |

These are preferred over Claude Code's built-in `WebSearch`/`WebFetch` tools (which the `tool-redirect` hook blocks).

## Development

### Build

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript to plugin/hooks/dist/
bun run build:watch  # Watch mode
```

### Test

```bash
bun test             # Run all tests (73 tests across 12 files)
bun test:watch       # Watch mode
```

### Architecture

The codebase is organized into three layers:

- **Hooks** (`src/hooks/`) — Lifecycle event handlers. Each reads JSON from stdin, processes it, and outputs JSON to stdout. The hook pipeline is defined in `plugin/hooks/hooks.json`.
- **Checkers** (`src/checkers/`) — Framework-specific validation logic. Called by the `file-checker` hook. Auto-detect project tooling and run appropriate checks.
- **Utils** (`src/utils/`) — Shared helpers for hook I/O, file length checks, TDD enforcement, and git operations.

Hooks are compiled to JavaScript in `plugin/hooks/dist/` and executed by Bun at runtime. The plugin structure under `plugin/` is what gets installed to `~/.claude/plugins/sentinal/`.

### Adding a New Hook

1. Create `src/hooks/my-hook.ts` implementing the hook I/O protocol
2. Add a test file `src/hooks/my-hook.test.ts`
3. Register the hook in `plugin/hooks/hooks.json` with the appropriate event and matcher
4. Build and reinstall: `bun run build && bash install.sh`

### Adding a New Checker

1. Create `src/checkers/my-framework.ts` with a check function
2. Add detection logic to `src/checkers/detect.ts`
3. Call the checker from `src/hooks/file-checker.ts`
4. Add tests and build

### OpenCode Development

The OpenCode target is located in `targets/opencode/`:

```bash
# Install for OpenCode
bash targets/opencode/install.sh

# Test quality checks locally
node targets/opencode/tests/run-checks.js
```

OpenCode plugins are written in TypeScript and executed directly by Bun. No compilation step required.

### Adding a New OpenCode Feature

1. Edit `targets/opencode/plugins/sentinal.ts` to add new hooks
2. Test with `node targets/opencode/tests/run-checks.js`
3. Reinstall: `bash targets/opencode/install.sh`

## Settings

Sentinal configures these Claude Code settings via `plugin/settings.json`:

| Setting | Value | Purpose |
|---------|-------|---------|
| `CLAUDE_CODE_ENABLE_TASKS` | `true` | Enable task management tools |
| `ENABLE_TOOL_SEARCH` | `true` | Enable MCP tool discovery |
| `ENABLE_LSP_TOOL` | `true` | Enable LSP integration |
| `alwaysThinkingEnabled` | `true` | Extended thinking for better analysis |
| `respectGitignore` | `false` | Plugin needs access to `dist/` files |

Pre-approved permissions include common dev tools (npm, bun, ng, nest, tsc, prettier, eslint, jest, vitest, git), file operations, MCP servers, `/spec` workflow skills, and sub-agents.

## License

MIT
