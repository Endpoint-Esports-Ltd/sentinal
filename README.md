# Sentinal

Quality enforcement plugin for TypeScript, Angular, and NestJS projects — supports **Claude Code** and **OpenCode**.

Sentinal runs as an intelligent hook pipeline inside Claude Code or OpenCode, automatically checking every file edit against framework-specific rules, enforcing TDD practices, tracking development plans, and maintaining a persistent semantic memory across sessions.

## Quick Install

Download and install the latest `sentinal` binary with a single command. Requires a [GitHub personal access token](https://github.com/settings/tokens) with `repo` scope (private repository).

```bash
export GITHUB_TOKEN=ghp_xxx  # or GH_TOKEN

curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
  https://raw.githubusercontent.com/Endpoint-Esports-Ltd/sentinal/main/scripts/install.sh | sh
```

The installer will:

1. Download the latest binary for your platform (linux/darwin, x64/arm64)
2. Install it to `~/.sentinal/bin/sentinal`
3. Add `~/.sentinal/bin` to your `PATH` (bash, zsh, or fish)
4. Set up the `snt` alias
5. Enable shell tab completions
6. Provision semantic search dependencies (`~/.sentinal/deps`) for vector memory

After installation, restart your shell and install for your AI assistant:

```bash
sentinal install claude     # Claude Code
sentinal install opencode   # OpenCode
sentinal install both       # Both
```

> **macOS:** If Gatekeeper blocks the binary, run `codesign -s - ~/.sentinal/bin/sentinal`

## Supported AI Assistants

| Assistant       | Status       | Installation                |
| --------------- | ------------ | --------------------------- |
| **Claude Code** | Full support | `sentinal install claude`   |
| **OpenCode**    | Full support | `sentinal install opencode` |

Both assistants can be used simultaneously — Sentinal detects which environment is running. Running `sentinal install` with no argument auto-detects available assistants and prompts interactively if both are found.

## Features

- **Automatic Quality Checks** — Prettier, ESLint, and `tsc --noEmit` run on every file edit (Claude Code: via hooks, OpenCode: built-in + plugin)
- **Framework-Specific Rules** — Targeted standards for Angular 17+ (standalone, signals, control flow) and NestJS (DTOs, guards, Swagger)
- **TDD Enforcement** — Blocks edits to implementation files until a failing test exists (RED→GREEN→REFACTOR cycle tracking)
- **File Length Guardrails** — Warns at 400 lines, blocks at 600 lines (test files exempt)
- **Structured `/spec` Workflow** — Plan-implement-verify cycle with plan-reviewer and spec-reviewer sub-agents
- **Console Dashboard** — Live session overview at `http://127.0.0.1:41778` (auto-started with the sidecar)
- **Git Worktree Integration** — Isolated branches per spec plan; merge back with a squash commit
- **Context Monitoring** — Tracks context usage and suggests knowledge extraction at thresholds
- **Tool Redirection** — Hints on better tool choices (MCP alternatives, semantic search)
- **Compact Resilience** — Preserves active plan state across context window compaction
- **Persistent Semantic Memory** — Vector-based knowledge storage with automatic capture/restore and hybrid keyword+semantic search
- **MCP Servers** — Pre-configured context7 (library docs), web-search, grep-mcp (GitHub code search), web-fetch, and sentinal (28 tools across 6 domains)
- **LSP Integration** — TypeScript language server (vtsls) for go-to-definition, references, and hover
- **Long-Running Sidecar** — Background process holding a warm DB + embeddings; hooks connect via Unix socket for sub-15ms response times

## Requirements

- **Bun** 1.0+ (required runtime)
- **Node.js** 18+
- **Claude Code** or **OpenCode**

## CLI

Sentinal provides a unified `sentinal` binary. Primary distribution is the compiled binary installed by the installer or `sentinal update`.

```bash
# ─── Core ──────────────────────────────────────────────────────────────────
sentinal --help              # Show available commands
sentinal --version           # Print version
sentinal greet               # Display the Sentinal banner

# ─── Install / Update ──────────────────────────────────────────────────────
sentinal install [target]    # Install for claude, opencode, or both
sentinal install --local     # Install OpenCode to current project only
sentinal install --bundled   # Offline install (ships plugin .js, no npm)
sentinal uninstall [target]  # Uninstall (--remove-binary to also remove binary)
sentinal update              # Self-update binary from GitHub Releases
sentinal update --check      # Check for updates without installing

# ─── Sidecar ───────────────────────────────────────────────────────────────
sentinal sidecar start       # Start sidecar (-d for background, --http-only)
sentinal sidecar stop        # Stop the running sidecar
sentinal sidecar status      # Show PID, transport, port
sentinal sidecar restart     # Restart (-d for background)
sentinal sidecar logs        # Tail recent log lines (-n 50 by default)
sentinal sidecar logs --file sidecar    # sidecar.log only
sentinal sidecar logs --file plugin     # plugin.debug.log only
sentinal sidecar logs --file dashboard  # dashboard.log only
sentinal sidecar logs --file all        # All three logs (default)

# ─── Dashboard ─────────────────────────────────────────────────────────────
sentinal serve               # Start dashboard at http://127.0.0.1:41778
sentinal serve --background  # Start detached (auto-started by session hooks)
sentinal serve --port 8080   # Custom port

# ─── Memory ────────────────────────────────────────────────────────────────
sentinal memory search <q>   # Hybrid keyword + semantic search
sentinal memory list         # List recent observations
sentinal memory timeline <id># Chronological context around an observation
sentinal memory get <id>     # Full observation details
sentinal memory stats        # DB statistics incl. vector index size
sentinal memory prune        # Remove old observations (--older-than)
sentinal memory export       # Export to JSON or markdown
sentinal memory repair       # Integrity check + index rebuild
sentinal memory setup        # Provision semantic search native deps (~/.sentinal/deps)

# ─── Spec & Worktree ───────────────────────────────────────────────────────
sentinal spec list           # List all tracked specs
sentinal spec current        # Show the current active spec
sentinal spec sync           # Sync plan files to SQLite index
sentinal worktree list       # List worktrees
sentinal worktree detect <slug>  # Find worktree for a plan slug
sentinal worktree create <slug>  # Create git worktree for a plan
sentinal worktree diff <slug>    # Summarize changes
sentinal worktree sync <slug>    # Squash-merge back to base
sentinal worktree abandon <slug> # Remove worktree
sentinal register-plan <path>    # Register a plan file in SQLite

# ─── Sessions & Context ────────────────────────────────────────────────────
sentinal sessions list       # List sessions (--active, --json)
sentinal sessions cleanup    # Remove stale sessions
sentinal check-context [path]# Estimate context window usage

# ─── Config ────────────────────────────────────────────────────────────────
sentinal config list         # Show all config settings
sentinal config get <key>    # Get a setting
sentinal config set <key> <value>  # Set a setting
sentinal config reset -y     # Reset to defaults

# ─── Other ─────────────────────────────────────────────────────────────────
sentinal mcp-server          # Start Sentinal MCP server (stdio)
sentinal usage               # Per-model token usage report (-d 7 --json)
sentinal statusline          # Claude Code statusline formatter (reads stdin)
sentinal completion [shell]  # Shell completion script (bash/zsh/fish)
sentinal shell-init          # Set up aliases, PATH, completions
```

### Building a Standalone Binary

```bash
bun run build:cli    # Produces dist/sentinal (compiled Bun binary)
./dist/sentinal --help
```

## Installation

### Claude Code

```bash
sentinal install claude
```

The installer:

1. Verifies Node.js 18+, Bun, and Claude Code CLI are installed
2. Creates a local plugin marketplace at `~/.claude/plugins/sentinal-marketplace/`
3. Registers the marketplace and installs the plugin via `claude plugin install`
4. Provisions semantic search dependencies (`sentinal memory setup`)

After installation, restart Claude Code and run `/sentinal:sync` in your project to generate project-specific rules.

### OpenCode

```bash
sentinal install opencode
```

The installer:

1. Verifies OpenCode, Bun, and Node.js are installed
2. Copies the plugin, commands, rules, agents, and skills to `~/.config/opencode/`
3. Creates or merges `opencode.json` config with MCP servers (native JSON — no `jq` dependency)
4. Creates global `AGENTS.md` with rule references
5. Provisions semantic search dependencies (`sentinal memory setup`)

For project-local installs instead of global:

```bash
sentinal install opencode --local
```

Then run `/sync` in an OpenCode session within your project.

### Both Assistants

Claude Code and OpenCode can coexist. Each uses separate config directories:

- Claude Code: installed via marketplace to `~/.claude/plugins/cache/` (managed by `claude plugin`)
- OpenCode: `~/.config/opencode/` (plugin, commands, rules merged into existing config)

```bash
sentinal install both
```

## Updating

Sentinal self-updates from GitHub Releases:

```bash
sentinal update         # Download and replace binary, reinstall plugins
sentinal update --check # Check for a newer version without installing
```

**What `sentinal update` does (v1.30+):**

1. Downloads the latest binary for your platform
2. Atomically replaces `~/.sentinal/bin/sentinal`
3. Spawns the new binary with `update --reinstall-plugins` so fresh embedded assets (commands, rules, skills) are deployed immediately
4. Auto-detects installed assistants and reinstalls for each
5. Runs `sentinal memory setup` to provision or refresh semantic search deps

A background update check runs automatically with most commands (24-hour cache). When a newer version is available, it prints a notice and the update command.

**Transition note (versions ≤ 1.29.1):** After running `sentinal update` from an older version, run once manually:

```bash
sentinal install claude && sentinal install opencode
```

This deploys the fresh embedded assets that the old binary cannot self-deploy. From v1.30.0 onward, updates are fully self-maintaining.

**Stale dashboard:** If a dashboard process started before v1.30.1 is still running (check: `curl http://127.0.0.1:41778/api/health`), clear it once:

```bash
lsof -ti :41778 | xargs kill
```

From v1.30.1 onward, `sentinal serve` detects and replaces stale-version dashboards automatically.

## Semantic Memory Search

Sentinal uses vector embeddings for semantic (meaning-based) memory search alongside keyword search. This requires native binaries that are provisioned separately from the main install.

### Setup

```bash
sentinal memory setup
```

This downloads and bundles `sqlite-vec` and `@xenova/transformers` into `~/.sentinal/deps`. It runs automatically at install and update time, so manual invocation is only needed if setup was skipped or failed.

**Environment variables:**

```bash
SENTINAL_NO_AUTO_SETUP=1   # Skip auto-setup at install/update (for CI or airgapped environments)
```

### How It Works

- The sidecar starts vector initialization in the background after startup
- A one-time backfill embeds existing observations (typically < 10s for hundreds of observations)
- `sentinal memory stats` shows vector index status and count
- If native deps are unavailable, search falls back to keyword-only (FTS5) — no errors

### Self-Heal

If the sidecar starts without vector search (deps missing or corrupt), it automatically retries provisioning once per version in the background. If repair succeeds, the next sidecar start uses vector search.

## Console Dashboard

Sentinal includes a web dashboard for monitoring sessions, specs, memories, and notifications:

```bash
sentinal serve               # Start at http://127.0.0.1:41778 (foreground)
sentinal serve --background  # Start detached
sentinal serve --port 8080   # Custom port
```

The dashboard is auto-started alongside the sidecar when a Claude Code or OpenCode session begins. It shuts down automatically when the sidecar detects no active sessions.

**Lifecycle logging:** All dashboard start/stop events are written to `~/.sentinal/dashboard.log`. View alongside sidecar and plugin logs:

```bash
sentinal sidecar logs --file dashboard
sentinal sidecar logs --file all       # All three logs together
```

**Idempotent startup:** `sentinal serve` probes the health endpoint before binding. If the same version is already running, it exits silently. If an older version is running and its PID is known, it performs a takeover (SIGTERM + rebind).

## Project Structure

```
sentinal/
├── src/                              # Shared TypeScript source (both targets)
│   ├── index.ts                      # Barrel exports (public API)
│   ├── analysis/                     # check_diagnostics, impact_analysis, quality_report MCP tools
│   ├── checkers/                     # typescript, angular, nestjs, detect — framework validation
│   ├── cli/                          # Unified sentinal CLI
│   │   ├── index.ts                  # Commander dispatcher
│   │   ├── embedded-assets.ts        # Generated — do not hand-edit
│   │   └── commands/                 # ~20 command modules (install, update, serve, sidecar, memory, ...)
│   ├── config/                       # Config loading
│   ├── dashboard/                    # Web dashboard (Bun.serve, port 41778)
│   │   ├── server.ts                 # HTTP server + route dispatch
│   │   ├── lifecycle.ts              # PID file, probe, startup decision helper
│   │   └── routes/                   # API + view handlers
│   ├── hooks/                        # Claude Code lifecycle hooks (stdin/stdout JSON I/O)
│   ├── mcp/                          # MCP server factory — registers all 28 tool modules
│   ├── memory/                       # SQLite + sqlite-vec vector store + embeddings + MCP tools
│   ├── opencode/                     # OpenCode-specific helpers (workspace adaptor, compaction)
│   ├── project/                      # project_context MCP tool
│   ├── session/ sessions/            # Session tracking, context window estimation
│   ├── sidecar/                      # Long-running HTTP sidecar (Unix socket preferred)
│   ├── spec/                         # Spec workflow engine + MCP tools
│   ├── tdd/                          # TDD cycle state + MCP tools
│   ├── utils/                        # hook-output, file-length, tdd, git, file-log, shell
│   └── worktree/                     # Git worktree management + MCP tools
│
├── targets/
│   ├── claude-code/                  # Shipped to Claude Code users
│   │   ├── hooks/                    # Hook pipeline (hooks.json + compiled dist/)
│   │   ├── rules/                    # 5 coding standards rule sets (standards-*.md)
│   │   ├── commands/                 # Slash commands (/spec, /sync, /learn)
│   │   ├── agents/                   # Sub-agents (plan-reviewer, spec-reviewer)
│   │   ├── settings.json             # Claude Code settings & permissions
│   │   ├── .mcp.json                 # MCP server configuration
│   │   └── .lsp.json                 # Language server configuration
│   │
│   └── opencode/                     # Shipped to OpenCode users
│       ├── plugins/sentinal.ts       # Plugin entry point (Node.js-compatible)
│       ├── dist/sentinal.mjs         # Bundled plugin (build output)
│       ├── commands/                 # Slash commands (/spec, /sync, /learn)
│       ├── skills/                   # Spec sub-phase skills (invoked by /spec)
│       ├── agents/                   # Sub-agents (plan-reviewer, spec-reviewer)
│       └── rules/                    # 5 coding standards rule sets
│
├── scripts/
│   ├── install.sh                    # Remote install script (curl | sh)
│   ├── embed-assets.mjs              # Generates src/cli/embedded-assets.ts
│   └── release-build.mjs             # Cross-compilation for semantic-release
│
├── .sentinal/                        # Dev rules and runtime state for this repo
├── package.json                      # @endpoint/sentinal (private registry)
└── bunfig.toml                       # Bun test config (preloads sqlite-vec)
```

## How It Works

Sentinal integrates with each assistant through its native extension mechanism. Both targets share the same core logic (`src/`), with target-specific wrappers in `targets/`.

### Long-Running Sidecar

The sidecar (`sentinal sidecar start`) is a background HTTP server that holds a warm `MemoryStore`, `SpecStore`, `WorktreeStore`, and vector embeddings. Hooks and the MCP server connect via Unix domain socket (`~/.sentinal/sidecar.sock`) with HTTP fallback, avoiding the ~100ms per-invocation cold start of opening SQLite directly.

The sidecar shuts itself down automatically:
- 60 seconds after the last active session ends
- 30 minutes of idle time if no sessions were ever created
- 1 hour of no HTTP activity (stale session detection)

When it shuts down, it also stops the dashboard process.

### Claude Code: Hook Pipeline

Claude Code uses compiled TypeScript hooks that intercept lifecycle events via the `sentinal hook <scope> <name>` CLI dispatcher:

| Event              | Hook                 | What It Does                                                                                              |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `SessionStart`     | session-start        | Create session record; auto-start sidecar + dashboard                                                    |
| `SessionStart`     | memory-restore       | Restore relevant memories for the current project                                                         |
| `SessionStart`     | post-compact-restore | Restore active `/spec` plan after context compaction                                                      |
| `PreToolUse`       | tdd-guard            | Block edits to implementation files until a failing test exists (RED state required)                      |
| `PreToolUse`       | pre-edit-guide       | Provide context-aware guidance before file edits                                                          |
| `PreToolUse`       | tool-redirect        | Deny `WebSearch`/`WebFetch` (use MCP instead), hint on vague Grep patterns                               |
| `PostToolUse`      | file-checker         | Prettier, ESLint, tsc, framework checks, file length, TDD checks on every `Write`/`Edit`                 |
| `PostToolUse`      | tdd-tracker          | Track RED/GREEN state transitions after test runs                                                         |
| `PostToolUse`      | memory-observer      | Auto-capture learning moments from tool results                                                           |
| `PostToolUse`      | context-monitor      | Monitor context window %, warn at 65/75/85%+ thresholds                                                  |
| `UserPromptSubmit` | prompt-context       | Inject active plan + memory context into every prompt                                                     |
| `PreCompact`       | pre-compact          | Save active plan path and metadata to `.sentinal/compact-state.json`                                     |
| `Stop`             | spec-stop-guard      | Block session exit if a `/spec` plan is in PENDING or COMPLETE state                                     |
| `SessionEnd`       | session-end          | End session record; stop sidecar + dashboard if no other sessions active                                  |

Hooks are compiled to `targets/claude-code/hooks/dist/` and invoked by the `sentinal hook` CLI dispatcher.

### OpenCode: Plugin Events

OpenCode uses a TypeScript plugin (`targets/opencode/plugins/sentinal.ts`) executed natively by OpenCode's Node.js runtime:

| Event                             | What It Does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| Plugin init                       | Auto-start sidecar; version-aware dashboard ensure                      |
| `tool.execute.before`             | TDD guard, tool redirection hints, pre-edit guidance                    |
| `tool.execute.after`              | Quality checks on file edits (file length, TDD, NestJS/Angular, tsc)   |
| `experimental.session.compacting` | Inject active `/spec` plan state + memory context into compaction       |
| `session.created`                 | Create session record; restore memories                                 |
| `session.idle`                    | Warn about incomplete `/spec` plans                                     |
| `session.deleted`                 | End session; stop sidecar + dashboard when no sessions remain           |

### Architecture Comparison

| Feature            | Claude Code                      | OpenCode                         |
| ------------------ | -------------------------------- | -------------------------------- |
| **Extension type** | Compiled hook scripts            | Native TypeScript plugin         |
| **Hook dispatch**  | `sentinal hook <scope> <name>`   | Plugin event handlers            |
| **Formatters**     | Explicit in hooks                | Built-in automatically           |
| **Runtime**        | Compiled JS via Bun              | Node.js (plugin) + Bun (sidecar) |
| **Tool blocking**  | Exit code 2 + stderr             | Throw Error                      |
| **Compaction**     | Save state to file               | Direct context injection         |
| **Sub-agents**     | plan-reviewer, spec-reviewer     | plan-reviewer, spec-reviewer     |

### File Edit Flow

When the assistant edits a TypeScript file, quality checks run automatically:

1. Checks line count (warns at 400+, blocks at 600+)
2. Detects the project's package manager from lockfiles (pnpm, yarn, bun, or npm)
3. Runs **Prettier** — auto-formats if needed (Claude Code only; OpenCode handles this built-in)
4. Runs **ESLint** — auto-fixes lint issues (Claude Code only; OpenCode handles this built-in)
5. Runs **TypeScript** — `tsc --noEmit` for type errors
6. If Angular file detected — runs `ng build --dry-run` for template/compiler errors
7. If NestJS file detected — checks for `@ApiTags`, `class-validator`, `@Entity` decorators
8. Checks for companion test file — blocks edit if TDD guard is active (RED state not confirmed)

All feedback is returned as structured hints that the assistant acts on automatically.

### Framework Detection

Sentinal auto-detects your project setup:

| Detection           | Method                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Package manager** | Lockfile presence: `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` / `package-lock.json` |
| **Test runner**     | Config files: `jest.config.*` / `vitest.config.*` / `karma.conf.*`                   |
| **Framework**       | Dependency inspection: `@angular/core` / `@nestjs/core` in `package.json`            |

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

**Sub-agents** (both Claude Code and OpenCode — launched in background during verification):

- **plan-reviewer** — Reviews feature plans for completeness and adversarial risks
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

| Server         | Purpose                                    | Package                 |
| -------------- | ------------------------------------------ | ----------------------- |
| **context7**   | Up-to-date library/framework documentation | `@upstash/context7-mcp` |
| **web-search** | Web search via DuckDuckGo/Bing/Exa         | `open-websearch`        |
| **grep-mcp**   | GitHub code search across 1M+ public repos | `mcp.grep.app`          |
| **web-fetch**  | Full web page fetching via Playwright      | `fetcher-mcp`           |
| **sentinal**   | Memory, spec, worktree, TDD, analysis      | `@endpoint/sentinal`    |

These are preferred over built-in web tools. In Claude Code, the `tool-redirect` hook blocks `WebSearch`/`WebFetch` in favor of the MCP servers.

### Sentinal MCP Tool Catalog

The `sentinal` MCP server exposes **28 tools across 6 domains**:

| Domain       | Count | Tools                                                                                      |
| ------------ | ----- | ------------------------------------------------------------------------------------------ |
| **Memory**   | 6     | `memory_search`, `memory_timeline`, `memory_get`, `memory_save`, `memory_maintain`, `memory_stats` |
| **Spec**     | 9     | `spec_init`, `spec_status`, `spec_register`, `spec_plan_parse`, `spec_config`, `spec_events`, `spec_metrics`, `spec_notify`, `spec_wait_file` |
| **Worktree** | 6     | `worktree_detect`, `worktree_create`, `worktree_diff`, `worktree_sync`, `worktree_abandon`, `worktree_cleanup` |
| **TDD**      | 3     | `tdd_status`, `tdd_set_state`, `tdd_clear`                                                |
| **Analysis** | 3     | `check_diagnostics`, `impact_analysis`, `quality_report`                                  |
| **Project**  | 1     | `project_context`                                                                          |

## Development

### Build

```bash
bun install                # Install dependencies
bun run build:claude       # Compile Claude Code hooks to targets/claude-code/hooks/dist/
bun run build:opencode     # Bundle OpenCode plugin to targets/opencode/dist/sentinal.mjs
bun run build:all          # Build both targets
bun run build:cli          # Compile sentinal binary to dist/sentinal
```

### Test

```bash
bun test             # Run all tests (bun:test — NOT jest)
bun test:watch       # Watch mode
bun test src/path/to/file.test.ts  # Single file
```

### Architecture

The codebase is organized into shared layers consumed by both targets:

- **Sidecar** (`src/sidecar/`) — Long-lived background HTTP server. Hooks and the MCP server connect via `SidecarClient` to avoid per-invocation SQLite cold starts.
- **Hooks** (`src/hooks/`) — Lifecycle event handlers for Claude Code. Each reads JSON from stdin, processes it, and outputs JSON to stdout. Invoked via the `sentinal hook <scope> <name>` CLI dispatcher (`src/cli/commands/hook.ts`).
- **Checkers** (`src/checkers/`) — Framework-specific validation logic shared between both targets.
- **Memory** (`src/memory/`) — SQLite + sqlite-vec vector store + embeddings. Exposed as 6 MCP tools. Sidecar holds a warm instance.
- **Dashboard** (`src/dashboard/`) — `Bun.serve()` HTTP server on port 41778. Lifecycle logged to `~/.sentinal/dashboard.log`.
- **Utils** (`src/utils/`) — Shared helpers for hook I/O, file-length, TDD, git, and file logging.

### Claude Code Development

```bash
bun run build:claude                   # Compile hooks to targets/claude-code/hooks/dist/
sentinal install claude                # Install to ~/.claude/
```

**Adding a new hook:**

1. Create `src/hooks/my-hook.ts` implementing the hook I/O protocol
2. Create `src/hooks/my-hook.test.ts` (TDD guard requires a failing test first)
3. Register the hook in `targets/claude-code/hooks/hooks.json` with the appropriate event and matcher
4. Register the CLI dispatch path in `src/cli/commands/hook.ts`
5. Add the equivalent handler in `targets/opencode/plugins/sentinal.ts` (see dual-target rule)
6. Build and reinstall: `bun run build:all && sentinal install claude`

### OpenCode Development

```bash
bun run build:opencode         # Bundle plugin to targets/opencode/dist/sentinal.mjs
sentinal install opencode      # Deploy to ~/.config/opencode/
```

OpenCode plugins are executed by OpenCode's embedded Node.js runtime — no Bun APIs inside the plugin. Shared logic lives in `src/` and is imported by the plugin.

### Adding a New Checker

Checkers are shared between both targets:

1. Create `src/checkers/my-framework.ts` with a check function
2. Add detection logic to `src/checkers/detect.ts`
3. Call the checker from the hook dispatcher (`src/cli/commands/hook.ts`) and from `targets/opencode/plugins/sentinal.ts`
4. Add tests and build

## Settings

### Claude Code

Configured via `targets/claude-code/settings.json`:

| Setting                    | Value   | Purpose                               |
| -------------------------- | ------- | ------------------------------------- |
| `CLAUDE_CODE_ENABLE_TASKS` | `true`  | Enable task management tools          |
| `ENABLE_TOOL_SEARCH`       | `true`  | Enable MCP tool discovery             |
| `ENABLE_LSP_TOOL`          | `true`  | Enable LSP integration                |
| `alwaysThinkingEnabled`    | `true`  | Extended thinking for better analysis |
| `respectGitignore`         | `false` | Plugin needs access to `dist/` files  |

Pre-approved permissions include common dev tools (npm, bun, ng, nest, tsc, prettier, eslint, jest, vitest, git), file operations, MCP servers, `/spec` workflow skills, and sub-agents.

### OpenCode

Configured via `targets/opencode/opencode.json`:

- **Plugin registration** — `sentinal.ts` added to the `plugin[]` array
- **MCP servers** — All 5 MCP servers configured with appropriate transport types
- **LSP** — TypeScript language server for code intelligence

OpenCode settings are merged natively in TypeScript into existing user config, preserving any pre-existing configuration. Existing MCP server entries and other user settings take precedence over Sentinal defaults. JSONC files (with `//` comments) are handled automatically.

## License

Proprietary — UNLICENSED
