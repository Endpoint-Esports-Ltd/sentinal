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
- **MCP Servers** — Pre-configured context7 (library docs), web-search, grep-mcp (GitHub code search), web-fetch, and sentinal (35 tools across 7 domains)
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

## Runtime Contract — `.sentinal/runtime.json`

**Optional and project-authored.** If the file is absent, nothing changes: Sentinal behaves exactly as it did before this feature existed. If it is present, `/spec` verification stops guessing how to start your project and runs a declared lifecycle instead: **`up` → wait for `readiness` → tests → `down`.**

Sentinal can **draft** the file (`/sync`, or the `runtime_init` MCP tool) but never owns it — you review it and commit it, so your teammates and CI get the same lifecycle.

```jsonc
{
  // What `up` actually namespaces per-slot. OPTIONAL — see the warning below.
  "isolation": { "ports": "isolated", "database": "shared", "cache": "none" },

  "up": "./scripts/stack up ${SENTINAL_WORKTREE_SLOT}",
  "down": "./scripts/stack down ${SENTINAL_WORKTREE_SLOT}",
  "detached": false,

  // Shorthand: a bare string means { "type": "http", "target": <string> }.
  "readiness": {
    "type": "http", // http | exec
    "target": "http://localhost:3000/health", // URL, or a shell command for `exec`
    "expectStatus": [200], // http only; default is any 2xx–3xx
    "startupTimeoutMs": 60000,
    "pollIntervalMs": 250
  },

  "shutdown": { "signal": "SIGTERM", "graceMs": 10000 }
}
```

Comments are allowed (`//` and `/* */`); trailing commas are not.

**Rules:**

- `up` **requires** `readiness`. Starting something with no way to know it started is the failure this contract exists to prevent.
- `down` may be omitted — Sentinal falls back to signal escalation on the process group. But `"detached": true` **requires** `down`, because a detaching starter's process group owns nothing.
- `expectStatus` is valid only for `"type": "http"`. An `exec` probe passes on exit code 0.
- Interpolation is scoped to Sentinal's own prefix. **`${SENTINAL_WORKTREE_SLOT}`** is substituted with the worktree's slot; any other `${SENTINAL_*}` token is a **validation error naming the token**, never a silent empty string. Everything else — `${PORT:-3000}`, `${DOCKER_HOST}`, bare `$VAR` — is passed to your shell **verbatim** and is none of Sentinal's business.
- Interpolated fields are exactly `up`, `down` and `readiness.target`.

### ⚠️ `isolation` is self-attested, and a false claim is worse than no file

The map declares **the sharing that remains after `up` runs** — the common half-measure is a start command that parameterizes the port while the database URL still comes from a shared `.env`.

| Declaration           | Blocks a run? | Reported?                |
| --------------------- | ------------- | ------------------------ |
| `"isolated"`          | no            | no                       |
| `"shared"` (explicit) | **yes**       | yes                      |
| `"none"`              | no            | no                       |
| **absent**            | **no**        | yes, **non-blocking**    |

- **Unstated means `unknown`, not `shared`, and `unknown` never prompts.** A prompt that fires on every run of every project carries no information, and a reflexively-accepted one teaches you to wave through "not isolated". You get a line of context instead.
- **Only an explicit, human-written `"shared"` gates anything.** Deliberate, therefore rare, therefore worth reading.
- **Sentinal cannot verify any of it, and never infers `"isolated"` on your behalf.** A wrong `"isolated"` is a confident, silent green light — strictly worse than having no file at all. That is why the `/sync` scaffolder **omits the map entirely** rather than guessing: omission is fail-safe, because omission means `unknown`.

Vocabulary: `ports`, `database`, `cache`, `queue`, `filesystem`, `objectStorage`, `searchIndex`, `outboundEmail`, `browser`, plus `other: [{ "name": "…", "state": "shared" }]` for anything else. Note `browser` describes the E2E browser instance regardless of whether `up` starts it — declare it `"isolated"` when the run uses per-session isolation (`-s=$SENTINAL_SESSION_ID`, or a dedicated Chrome).

### Running the lifecycle — `runtime_up` / `runtime_stop`

Declaring the contract is half of it; the other half is that Sentinal, not the agent, executes it. Two MCP tools do that:

| Tool           | Does                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime_up`   | Runs `up` in a **new process group Sentinal owns**, records it, polls `readiness`, and returns only once the probe passes. Failures carry a log tail.       |
| `runtime_stop` | **DESTRUCTIVE.** Runs `down`, then escalates `shutdown.signal` → `graceMs` → `SIGKILL` **to that group and nothing else**. Idempotent; safe to call twice.  |

**The ownership record is a file, not a daemon.** `runtime_up` writes `<worktree>/.sentinal/runtime.pid` — pid, pgid, the command, and a state of `starting` or `ready` — **before** the first readiness poll, not after. Writing it only on success would leave the entire startup window (up to 60s) with a detached process group and nothing recording it, which is the orphan the record exists to prevent. Both the pidfile and `.sentinal/runtime.log` are hidden from git automatically.

Staleness is evaluated **on read**, so there is no background sweeper and no state outside the worktree. The record dies with the worktree.

**Sentinal never signals a process it cannot prove is yours.** Before any signal it re-checks both that the PID is alive and that the process still references this worktree — by command line *or* by working directory. **If that cannot be established, it refuses and tells you what it found**, because a recycled PID belongs to someone else. That refusal is the whole point: `kill -- -$PGID` against a verified group is the correct alternative to `pkill -f`, and it only stays correct while the verification is unskippable.

**"Could not check" is never treated as "nothing is running."** If `ps` is missing or fails, Sentinal cannot enumerate the process group — and a probe that could not answer is not evidence that a group is gone. So an unenumerable group makes `runtime_stop` **refuse**, keeping the ownership record rather than deleting the only thing that can find that group again, and makes `worktree_cleanup --force` treat the worktree as **live** and skip it. The cost of the opposite default is a live process whose working directory has just been deleted.

#### If a worktree will not stop — the escape hatch

Because a failed stop aborts the exit path, a worktree whose runtime cannot be stopped **cannot be abandoned, cannot be merged, and is skipped by `worktree_cleanup --force`**. That is deliberate: "we could not stop it" is never a licence to delete the directory out from under it. It is also recoverable, and every refusal message names the way out:

1. Read the refusal — it lists the PIDs in the way and the command to inspect them:
   ```sh
   ps -A -o pid=,pgid=,command= | awk '$2 == <PGID>'
   ```
   (`ps -g` is *not* portable process-group selection: Darwin ignores the flag, and Linux reads it as a session id rather than a process-group id.)
2. Stop by hand whatever you recognise as belonging to that worktree.
3. Delete the ownership record: `rm <worktree>/.sentinal/runtime.pid`.
4. Re-run `worktree_abandon` / `worktree_sync`. With no pidfile the stop is an immediate no-op, so the worktree is no longer wedged.

⚠️ Step 3 is the only step that bypasses a safety check, which is why it is last and why nothing performs it for you. **There is deliberately no `--force` on abandon** — a flag that skipped the ownership check would be indistinguishable from the `pkill -f` this contract exists to replace.

**⛔ An occupied port is a hard failure. Sentinal never picks a different one.** A free port proves nothing about what is behind it — a second stack on port 3001 still writes to the same database as the one on 3000, so re-porting converts a loud, obvious failure into a silent one that corrupts shared state. `runtime_up` therefore fails and names the conflict:

| Situation                                     | What `runtime_up` does                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| A **ready** stack of ours already holds it    | **Reuses** it, and never tears it down — killing what we did not start is the same error class as `pkill -f` |
| A **half-started** stack of ours holds it     | Tears that group down, then starts fresh                                     |
| A dead leader, but its **group** still holds it | Reaps the group — but only after verifying a live member references this worktree |
| Anything else, or nothing we can identify     | **Fails, naming the port.** No alternative port is attempted, anywhere       |

**Stopping happens on every exit path.** `worktree_sync` and `worktree_abandon` stop the worktree's process group **before** they touch the directory (and, for a merge, before `git checkout` — a live process holding files can fail the checkout itself). `worktree_cleanup --force` skips any worktree that still owns live processes and tells you which. Worktrees that never started a runtime pay nothing: with no pidfile the stop returns immediately, without loading the contract or running `down`.

**⚠️ POSIX only.** Process groups exist on macOS and Linux. **On Windows Sentinal records no process group**, so teardown reduces to the declared `down` — the guarantee becomes _"we ran the declared `down`"_ rather than _"we own the PIDs"_, and the tool output says so. A Windows contract with no `down` and a non-detaching `up` has no teardown mechanism at all, and `runtime_stop` reports that as an explicit failure naming the PID rather than a false success. **On Windows, declare a `down`.** The same reduction applies on any platform when `"detached": true`, which is why the schema requires `down` in that case.

## MCP Servers

Sentinal configures 5 MCP servers for enhanced capabilities:

| Server         | Purpose                                    | Package                 |
| -------------- | ------------------------------------------ | ----------------------- |
| **context7**   | Up-to-date library/framework documentation | `@upstash/context7-mcp` |
| **web-search** | Web search via DuckDuckGo/Bing/Exa         | `open-websearch`        |
| **grep-mcp**   | GitHub code search across 1M+ public repos | `mcp.grep.app`          |
| **web-fetch**  | Full web page fetching via Playwright      | `fetcher-mcp`           |
| **sentinal**   | Memory, spec, worktree, TDD, analysis, runtime | `@endpoint/sentinal` |

These are preferred over built-in web tools. In Claude Code, the `tool-redirect` hook blocks `WebSearch`/`WebFetch` in favor of the MCP servers.

### Sentinal MCP Tool Catalog

The `sentinal` MCP server exposes **35 tools across 7 domains**:

| Domain       | Count | Tools                                                                                      |
| ------------ | ----- | ------------------------------------------------------------------------------------------ |
| **Memory**   | 9     | `memory_search`, `memory_timeline`, `memory_get`, `memory_save`, `memory_update`, `memory_delete`, `memory_share`, `memory_maintain`, `memory_stats` |
| **Spec**     | 9     | `spec_init`, `spec_status`, `spec_register`, `spec_plan_parse`, `spec_config`, `spec_events`, `spec_metrics`, `spec_notify`, `spec_wait_file` |
| **Worktree** | 6     | `worktree_detect`, `worktree_create`, `worktree_diff`, `worktree_sync`, `worktree_abandon`, `worktree_cleanup` |
| **TDD**      | 3     | `tdd_status`, `tdd_set_state`, `tdd_clear`                                                |
| **Analysis** | 3     | `check_diagnostics`, `impact_analysis`, `quality_report`                                  |
| **Runtime**  | 4     | `runtime_config`, `runtime_init`, `runtime_up`, `runtime_stop`                             |
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

### End-to-End Test Harness (isolated)

An E2E harness under `tests/e2e/` installs Sentinal into a **fully isolated sandbox**
(a temp `$HOME` with `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `SENTINAL_NO_AUTO_SETUP=1`,
and `CLAUDE_PLUGIN_DATA` cleared) and exercises it end-to-end — **without ever touching
your real `~/.claude`, `~/.config/opencode`, `~/.opencode`, or `~/.sentinal`.** Isolation
is enforced structurally (`assertEnvContained` proves every spawned process stays inside
the sandbox) plus a content-hash backstop over the real dirs (`assertNoRealEscape`).

Two layers:

- **Layer A — deterministic (default, CI-safe, no LLM):** builds the CLI, then drives
  Sentinal's real entrypoints inside the sandbox — `sentinal install`, hook dispatch,
  the MCP server (via the `@modelcontextprotocol/sdk` client), the session-aware
  stop-guard, and sidecar + memory round-trips.

  ```bash
  bun run e2e          # build CLI + run Layer A
  ```

- **Layer B — opt-in real binaries (local-only):** drives the real `opencode`/`claude`
  binaries headless and asserts the **Sentinal plugin actually loaded** (via a
  `~/.sentinal` artifact — not the LLM exit code). Gated behind `SENTINAL_E2E_REAL=1`
  and **skipped by default**.

  ```bash
  bun run e2e:real     # local, authenticated (SENTINAL_E2E_REAL=1)
  ```

  - **OpenCode:** runs with your real subscription OAuth — it copies
    `~/.local/share/opencode/auth.json` into the sandbox (deleted afterward, even on
    throw). ✅ Verified: the plugin loads in a real `opencode run` session.
  - **Claude Code:** requires a **portable** credential — `ANTHROPIC_API_KEY` or a
    `~/.claude/.credentials.json` file. A Claude **subscription** stores its OAuth token
    in the macOS Keychain (bound to your real profile), which cannot be transferred to a
    sandbox `HOME`, so the Claude case **skips** for subscription-only auth. (A Docker
    container would not help — it has no macOS Keychain either.)

E2E files use `*.e2e.ts` / `*.spec-e2e.ts` names so a bare `bun test` never discovers
them (they run only via `bun run e2e`).

### Pre-release gate

`bun run pre-release` validates the **actual release artifact** (not just the dev build)
before tagging. It builds the current platform's `sentinal-<os>-<arch>` binary exactly as
the release pipeline does (embedded assets, externalized native deps, injected version),
points the isolated harness at it via `SENTINAL_E2E_BINARY`, and runs the pinned gate
suite — including a **version-identity** check (fails if the wrong binary is under test)
and a **release-config install** check (embedded mode, the `install.sh` user path).

```bash
bun run pre-release            # offline, current-platform release artifact
bun run pre-release:deps       # + real native-dep provisioning (network, ~150MB)
bun run pre-release:download   # test a PUBLISHED asset (needs GITHUB_TOKEN)
```

- **`:deps`** unsets `SENTINAL_NO_AUTO_SETUP` so the release binary provisions
  `~/.sentinal/deps` and a real memory round-trip (embeddings + sqlite-vec) is exercised —
  the #1 thing that passes the bundled harness but can fail a real user. Opt-in (slow).
- **`:download`** fetches the latest (or `SENTINAL_E2E_TAG`) release asset **and verifies
  its sha256 against `checksums.txt`** (hard-fail on mismatch) before testing it.
- **Cross-platform caveat:** a host can only *execute* its own platform's binary (a Mac
  can't run `sentinal-linux-*`). Run `bun run pre-release` on a **Linux CI runner** for the
  authoritative Linux `run` coverage; `:download` can fetch + checksum-verify a Linux asset
  from any host but not execute it.

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

> **A plugin's `settings.json` is not a configuration channel.** Claude Code reads
> **only** the `agent` and `subagentStatusLine` keys from a plugin-root
> `settings.json` ([plugins reference → _File locations reference_](https://docs.claude.com/en/docs/claude-code/plugins-reference)).
> Sentinal therefore configures Claude Code through the channels that _do_ apply —
> `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `agents/`, `commands/`, `rules/` —
> and writes the statusline directly into your own `~/.claude/settings.json`
> (`configureStatusline()`). Anything else you want applied has to live in **your**
> settings file, not Sentinal's.

`targets/claude-code/settings.json` carries a handful of preference keys
(`env`, `plansDirectory`, `statusLine.refreshInterval`, `alwaysThinkingEnabled`,
`respectGitignore`, `spinnerTipsOverride`). They document intent; they do **not**
take effect from the plugin. To actually apply them, copy them into
`~/.claude/settings.json`.

#### Recommended `~/.claude/settings.json`

Sentinal does **not** write any of this for you — permissions are yours to own.
`/spec` runs comfortably with the following (trim it to taste; every `Bash(...)`
entry widens your own blast radius):

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TASKS": "true", // task management tools
    "ENABLE_TOOL_SEARCH": "true", // MCP tool discovery
    "ENABLE_LSP_TOOL": "true", // LSP integration
    "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "10000",
  },
  "alwaysThinkingEnabled": true,
  "respectGitignore": false, // Sentinal reads dist/ files
  "permissions": {
    // Prompt before a pattern-kill — see rules/verification.md.
    // `ask` beats `allow`, including a bare "Bash".
    "ask": ["Bash(pkill:*)", "Bash(killall:*)"],
    "allow": [
      "Bash(npm:*)",
      "Bash(bun:*)",
      "Bash(npx:*)",
      "Bash(git:*)",
      "Bash(tsc:*)",
      "Bash(eslint:*)",
      "Bash(prettier:*)",
      "Bash(sentinal:*)",
      "Edit",
      "Read",
      "Write",
      "Glob",
      "Grep",
      "mcp__plugin_sentinal_sentinal__*",
    ],
  },
}
```

### OpenCode

Configured via `targets/opencode/opencode.json`:

- **Plugin registration** — `sentinal.ts` added to the `plugin[]` array
- **MCP servers** — All 5 MCP servers configured with appropriate transport types
- **LSP** — TypeScript language server for code intelligence

OpenCode settings are merged natively in TypeScript into existing user config, preserving any pre-existing configuration. Existing MCP server entries and other user settings take precedence over Sentinal defaults. JSONC files (with `//` comments) are handled automatically.

## License

Proprietary — UNLICENSED
