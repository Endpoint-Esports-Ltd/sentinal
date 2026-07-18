---
name: sentinal-cc-hook-signals
description: |
  The Claude Code hook exit-code ↔ output-shape contract, and specifically the
  Stop/SubagentStop `additionalContext` exit-0 trap. Use when: (1) making a hook
  a "soft nudge" instead of a hard block, (2) a Stop hook change seems to do
  nothing / is a silent no-op, (3) deciding between denyExit / blockExit /
  stopContext / hint in src/utils/hook-output.ts, (4) the codebase docstring says
  "exiting 0 downgrades to a no-op" and you're unsure if it applies to your case,
  (5) a test that calls a hook's real entry point poisons the bun runner exit code.
author: Claude Code
version: 1.0.0
---

# Claude Code Hook Output Signals

## When to Use

You are changing what a Claude Code hook emits (block vs allow vs feedback) and
need to know the exact exit-code + JSON-shape combination CC actually honors.
Especially for **Stop / SubagentStop** hooks going from a hard deny to a soft nudge.

## The Contract (verified against code.claude.com/docs/en/hooks)

Claude Code reads hook output via **two mutually exclusive channels**:

| Goal | Exit code | stdout JSON | stderr | Helper in `src/utils/hook-output.ts` |
| --- | --- | --- | --- | --- |
| **Hard block** (PreToolUse deny / Stop deny) | **2** | ignored | reason (shown to model) | `denyExit(reason)` |
| **Soft block** feed reason back, continue turn | **2** | `{decision:"block",reason}` | reason | `blockExit(reason)` **+ `continueOnBlock:true` in hooks.json** |
| **Soft feedback** (Stop nudge, keep turn alive) | **0** | `{hookSpecificOutput:{hookEventName,additionalContext}}` | — | `stopContext(reason)` / `hint(event,ctx)`+`output()` |
| **Context injection** (PostToolUse, SessionStart) | **0** | `hint(...)` JSON | — | `output(hint(...))` |

### The trap that cost real time (2026-07-17)

`blockExit`'s docstring says *"Exiting 0 would silently downgrade to a no-op."*
**That is TRUE ONLY for the `{decision:"block"}` route.** It is FALSE for
`hookSpecificOutput.additionalContext`:

- CC docs: *"The hook must exit with code **0** for the JSON to be processed. If
  the hook exits with code **2**, any JSON output is **ignored**."*
- So a Stop hook that wants to nudge (not hard-block) MUST emit
  `additionalContext` and **exit 0**. It keeps the turn alive as "Stop hook
  feedback" under the 8-consecutive-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

**Rule of thumb:** deny/block ⇒ exit **2**, stderr carries the reason, stdout
JSON is decorative. Feedback/context ⇒ exit **0**, stdout JSON is authoritative.
Never mix: exit 2 with only `additionalContext` = silent no-op.

## Solution (making a hook soft)

1. Add/confirm a helper in `src/utils/hook-output.ts` that emits at exit 0:
   `stopContext(reason)` = `process.stdout.write(JSON.stringify(hint("Stop", reason))); process.exit(0);`
2. In the hook, replace `denyExit(reason)` with `stopContext(reason)` on the
   soft path. Keep an env escape (e.g. `SENTINAL_STOP_GUARD_HARD=1 → denyExit`).
3. **No `continueOnBlock` needed** for the exit-0 additionalContext path — that
   flag is only for the exit-2 `{decision:"block"}` soft-block route.
4. If `hooks.json` was edited: `bun run embed-assets` (it is embedded).

## Verification

Compiled-dispatcher live-smoke (unit tests can't call the real fn — it
`process.exit()`s and poisons the bun runner; see `sentinal-ci-only-failures`):

```bash
bun build --compile src/cli/index.ts --outfile /tmp/s
echo '{"session_id":"x","cwd":"'"$PROJ"'","hook_event_name":"Stop","agent_type":"main","permission_mode":"auto","transcript_path":""}' \
  | /tmp/s hook shared <hook-name>; echo "exit $?"
# Soft path  → exit 0, stdout contains "additionalContext"
# Hard path  → exit 2 (SENTINAL_STOP_GUARD_HARD=1)
```

## When NOT to Use

- Async hooks (`"async":true` in hooks.json) — they CANNOT block/deny/continue,
  only return `additionalContext` next-turn. See `sentinal-hook-architecture`.
- OpenCode plugin handlers — OpenCode has NO exit-2/deny equivalent; `session.idle`
  is advisory-only (warn log). This skill is Claude-Code-specific.

## References

- code.claude.com/docs/en/hooks (JSON Response, Exit code output, Stop decision control)
- `src/utils/hook-output.ts` (deny/denyExit/block/blockExit/hint/output/stopContext)
- Memory #141 (bun exitCode leak), #123 (blockExit dead-path wiring)
