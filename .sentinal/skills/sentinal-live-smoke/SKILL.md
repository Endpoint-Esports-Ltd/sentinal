---
name: sentinal-live-smoke
description: |
  End-to-end liveness checks for sentinal's production paths. Use when:
  (1) changing hook behavior (blockExit/deny/hint) — unit tests can pass
  while the live CLI dispatcher path stays old, (2) after deploying the
  OpenCode plugin or restarting a session — the plugin can fail to load
  entirely with no visible symptom, (3) a guard/feature "should" be active
  but isn't blocking/firing, (4) after any sentinal update or install.
author: Claude Code
version: 1.0.0
---

# Live-Path Smoke Verification

## When to Use

After changing hooks, the plugin, or upgrading binaries. Unit tests prove
the function works; these checks prove the LIVE path runs that function.
Three real incidents motivated this (one session, all with green suites):
dead `main()` vs live dispatcher (a321bac), plugin load ReferenceError
silently disabling every handler (b644bf2), stale installed binary.

## Solution

### 1. Hooks — the live path is the CLI dispatcher, not main()

Every hook has TWO paths: legacy `main()` in `src/hooks/<name>.ts`
(import.meta.main only — DEAD in production) and the live wrapper in
`src/cli/commands/hook.ts`. Behavior changes MUST land in the dispatcher.
Smoke the real entry exactly as hooks.json invokes it:

```bash
printf '%s' '{"session_id":"s","transcript_path":"/tmp/t","cwd":"'$PWD'","permission_mode":"default","hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"<test-file>"}}' \
  | sentinal hook claude file-checker; echo "exit: $?"
# Blocking hooks: expect exit 2 + {"decision":"block",...} on stdout + reason on stderr
```

For permanent coverage, add a subprocess CLI-wiring test (sanctioned for CLI
wiring): see `src/cli/commands/hook.test.ts`.

### 2. OpenCode plugin — verify it LOADED, then that it ACTS

```bash
# Load status (the only place load errors appear):
grep -E "plugins/sentinal.*(loading|failed)" "$(ls -t ~/.local/share/opencode/log/*.log | head -1)"
# Healthy init lines:
grep -E "workspace adaptor registered|Connected to sidecar" ~/.sentinal/plugin.debug.log | tail -2
```

Then one behavioral probe: attempt an Edit on a guarded impl file with no
RED state — the TDD guard MUST block it. If the edit goes through, the
plugin is not live (revert the probe edit).

Permanent coverage: `targets/opencode/plugins/sentinal.test.ts` invokes
`SentinalPlugin(mockContext)` — catches any init-time throw.

### 3. Binary / asset staleness

```bash
sentinal --version                              # matches latest release?
ls -la ~/.sentinal/bin/sentinal                 # build date sane?
grep -c "<feature-marker-string>" ~/.config/opencode/plugins/sentinal.mjs   # new feature string present?
ps -p $(cat ~/.sentinal/sidecar.pid) -o command # sidecar runs WHICH binary?
```

The running MCP server / sidecar keeps serving old code after upgrades until
the session/sidecar restarts — disk state ≠ process state.

## Verification

Each probe has a binary outcome (exit code, log line, grep count, blocked
edit). A probe that "looks fine" without one of those is not a probe.

## When NOT to Use

- Pure logic changes with no hook/plugin/binary surface — unit tests suffice.
- Diagnosing CI-only failures → sentinal-ci-only-failures skill.
- Choosing WHERE to implement a feature → sentinal-hook-architecture skill.

## Example

Phase 5 shipped `blockExit` with green tests; the live smoke (650-line file
through `sentinal hook claude file-checker`) returned exit 0 — the change
was in dead `main()`. Fixed in the dispatcher the same hour.

## References

- Memory #123 (dead-path wiring), #126 (plugin load failure), #124 (stale assets)
- `src/cli/commands/hook.test.ts`, `targets/opencode/plugins/sentinal.test.ts`
