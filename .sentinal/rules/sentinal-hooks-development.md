# Hook Development (Claude Code + OpenCode)

Rules for writing and modifying hooks. Skim this before touching `src/hooks/` or `targets/opencode/plugins/sentinal.ts`.

## Two Hook Systems, One Shared Core

| Target      | Location                                | Entry mechanism                                                     |
| ----------- | --------------------------------------- | ------------------------------------------------------------------- |
| Claude Code | `src/hooks/*.ts` → compiled via `build:claude` | `sentinal hook <scope> <name>` CLI dispatcher (see `hooks.json`)    |
| OpenCode    | `targets/opencode/plugins/sentinal.ts`  | Plugin event handlers (`tool.execute.before/after`, `session.*`)    |

Hooks that work on both platforms live under `sentinal hook shared <name>`. Claude-only hooks live under `sentinal hook claude <name>`. OpenCode's plugin handler imports the same logic from `src/`.

## Claude Code Hook I/O Protocol

Hooks are spawned as subprocesses. They receive JSON on **stdin** and respond via **stdout** (and sometimes **exit code + stderr**).

### Input (`HookInput`, see `src/utils/hook-output.ts:1`)

```ts
{
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { output?: string; [k: string]: unknown };  // PostToolUse only
}
```

### Output — use helpers from `src/utils/hook-output.ts`

```ts
import { readStdin, hint, output, denyExit } from "../utils/hook-output.js";

// Read input
const input = await readStdin();

// Provide a hint (exit 0)
output(hint("PostToolUse", "File exceeds 400 lines — consider splitting"));

// Deny a tool (writes reason to stderr, JSON to stdout, exits 2)
denyExit("Use the MCP web-search tool instead of WebSearch");

// Block an action (exit 2)
output(block("File exceeds 600 lines"));
process.exit(2);
```

**⚠️ Exit code 2 requires the reason on stderr too** — Claude Code ignores stdout JSON `reason` fields on exit 2. Always use `denyExit()` (which writes to both) instead of manually calling `deny()` + `exit(2)`.

## Hook Pipeline (from `targets/claude-code/hooks.json`)

| Event             | Matcher                          | Hook                 | Async |
| ----------------- | -------------------------------- | -------------------- | ----- |
| `SessionStart`    | `compact`                        | post-compact-restore | no    |
| `SessionStart`    | (any)                            | memory-restore       | no    |
| `SessionStart`    | (any)                            | session-start        | no    |
| `PreToolUse`      | `Write\|Edit\|MultiEdit`         | tdd-guard            | no    |
| `PreToolUse`      | `Write\|Edit\|MultiEdit`         | pre-edit-guide       | no    |
| `PreToolUse`      | `Bash\|WebSearch\|WebFetch\|...` | tool-redirect        | no    |
| `PostToolUse`     | `...\|Bash`                      | tdd-tracker          | **yes** |
| `PostToolUse`     | `Write\|Edit\|MultiEdit` + `if`  | file-checker         | no    |
| `PostToolUse`     | `...\|Bash`                      | memory-observer      | **yes** |
| `PostToolUse`     | `Read\|...\|Glob`                | context-monitor      | **yes** |
| `UserPromptSubmit`| (any)                            | prompt-context       | no    |
| `PreCompact`      | (any)                            | pre-compact          | no    |
| `Stop`            | (any)                            | spec-stop-guard      | no    |
| `SessionEnd`      | (any)                            | session-end          | no    |

### ⛔ Gotchas

- **`async: true` hooks CANNOT block or deny** — they can only return `additionalContext` (delivered next turn). If a hook needs to stop a tool, it must be sync.
- **`UserPromptSubmit` has no matchers** — fires on every prompt. Keep it fast (<50ms).
- **`if:` conditions use a mini-DSL** — see `file-checker` entry: `Write(*.ts)|Write(*.tsx)|Edit(*.ts)|...`. Lowercase extension matters.
- **`timeout` is in seconds**, not milliseconds. Default is 60s if omitted; be explicit.

## OpenCode Plugin Handler Mapping

| Claude Code hook     | OpenCode equivalent                         |
| -------------------- | ------------------------------------------- |
| `PreToolUse` matcher | `tool.execute.before` + tool name check     |
| `PostToolUse`        | `tool.execute.after`                        |
| `SessionStart`       | `session.created`                           |
| `Stop`               | `session.idle`                              |
| `PreCompact`         | `experimental.session.compacting`           |
| `UserPromptSubmit`   | No direct equivalent — use `session.compacting` context injection |

**Tool names differ:** Claude Code sees `Write`, `Edit`, `Bash`. OpenCode sees lowercase `write`, `edit`, `bash`. MCP tools keep their full name (e.g. `sentinal_memory_search`). Any tool-name filter must match both conventions — use helpers in `src/hooks/` where available.

## Adding a New Hook

1. Create `src/hooks/<name>.ts` using `readStdin()` + `hint()`/`denyExit()`/`output()` from `src/utils/hook-output.ts`.
2. Create `src/hooks/<name>.test.ts` — the repo enforces TDD; the hook is blocked from edit until a failing test exists.
3. Wire into **Claude Code**: add an entry to `targets/claude-code/hooks/hooks.json` with event, matcher, and timeout.
4. Wire into **OpenCode**: add a handler in `targets/opencode/plugins/sentinal.ts` calling the same shared function.
5. Register the CLI dispatch path in `src/cli/commands/hook.ts` (or wherever `sentinal hook <scope> <name>` is routed).
6. Build and test both targets: `bun run build:all && bun test src/hooks/<name>.test.ts`.

## Testing Hooks

Hooks are plain async functions — test them by feeding a `HookInput` through the exported function directly, asserting on returned output objects. Do NOT spawn subprocesses or pipe through stdin in tests unless you're testing the CLI wiring itself. See `src/hooks/file-checker.test.ts` for the standard pattern.
