## MCP Tools (Preferred)

When the sentinal MCP server is connected, prefer MCP tool calls over Bash:

| MCP Tool | Replaces | Description |
|----------|----------|-------------|
| `spec_status` | `sentinal spec-status` | Get current spec progress |
| `spec_register` | `sentinal register-plan` | Register/update a plan |
| `spec_config` | `echo $SENTINAL_*` | Get all workflow toggles |
| `spec_plan_parse` | `sentinal register-plan` + manual parse | Parse plan file metadata |
| `spec_wait_file` | `for` loop polling | Wait for file to appear |
| `spec_notify` | N/A | Create notification |
| `spec_events` | N/A | Get spec event history |
| `worktree_detect` | `sentinal worktree detect` | Find worktree by slug |
| `worktree_create` | `sentinal worktree create` | Create worktree |
| `worktree_diff` | `sentinal worktree diff` | Get worktree diff |
| `worktree_sync` | `sentinal worktree sync` | Squash-merge worktree |

---

## CLI Tools (Bash Fallback)

### Sentinal CLI

The `sentinal` binary manages sessions, worktrees, and context. All commands support `--json` for structured output.

**Session & Context:**

| Command | Purpose |
|---------|---------|
| `sentinal check-context --json` | Get context usage % (informational only) |
| `sentinal register-plan <path> <status>` | Associate plan with session |

**Worktree:** `sentinal worktree detect|create|diff|sync|cleanup|status --json <slug>`

Slug = plan filename without date prefix and `.md`. `create` auto-stashes uncommitted changes.

**Other:** `sentinal greet`, `sentinal statusline`

---

### Vexor — Code Search (CLI)

**⛔ Primary codebase search tool.** Instant results (<0.3s), runs via Bash. Always use Vexor first for codebase search. Fallback: Grep/Glob for exact patterns.

```bash
# Semantic search by intent
vexor "authentication AND login"
vexor "error handling"
vexor "database connection setup"

# With directory scope
vexor "interface" ./src

# Language filter
vexor "service class" ./src --language typescript
```

**Always use Vexor first for any codebase search.** Only fall back to Grep/Glob when:
- You need an exact symbol or pattern match
- Vexor returns no relevant results
- You're searching for a specific known string

#### Grep/Glob Fallback

```bash
# Exact pattern search
Grep(pattern="class FooService", path="./src")

# File discovery
Glob(pattern="**/*.service.ts")
```
