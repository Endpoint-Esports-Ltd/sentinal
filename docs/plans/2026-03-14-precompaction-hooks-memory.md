# Precompaction Hooks & Memory Observations Fix Plan

Created: 2026-03-14
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** Memory observations stopped appearing after 2026-03-12 despite active sessions. Precompaction hooks investigated and found working correctly.

**Root Cause:** Two distinct issues discovered:

1. **Stale HTTP port file** — The sidecar writes a dynamic port to `~/.sentinal/sidecar.port` on startup. When the sidecar is restarted or the binary is rebuilt, a new start attempt may detect the existing sidecar via Unix socket (`alreadyRunning` path) and exit cleanly — but this path does NOT update the port file. Meanwhile the file may have been overwritten with a different port by the attempted restart. The OpenCode plugin runs in Node.js (no Unix socket support), so it relies on the HTTP port file fallback. A stale port file means the plugin silently fails all sidecar HTTP calls with "Was there a typo in the url or port?" errors.

2. **Auto-capture heuristics never fire** — All 48 existing observations came from explicit `memory_save` MCP tool calls, not auto-capture. The plugin's `tool.execute.after` hook only receives quality-check event data (file issues), not full tool outputs. The `analyzeEvent()` heuristics require richer data (bash outputs, error indicators) that the event stream doesn't provide in OpenCode's plugin model. This is a design limitation, not a code regression.

**Evidence:**

- `sidecar.port` contains `51871`, but sidecar PID 74023 listens on port `65186`
- Unix socket (`sidecar.sock`) works fine — MCP server (Bun) connects successfully
- Plugin debug log shows `"insertSession failed: Was there a typo in the url or port?"` starting 2026-03-12 19:32
- `sqlite3 memory.db "SELECT DISTINCT json_extract(metadata, '$.source') ..."` shows all 48 observations have `source: "mcp-tool"`
- Precompaction hook (`experimental.session.compacting`) is correctly implemented and unaffected by recent refactoring

## Tasks

### Fix 1: Stabilize sidecar port file

- [x] 1. In `startSidecar()` (server.ts), when `alreadyRunning` is detected, probe the existing sidecar's HTTP port and re-write `sidecar.port` if stale
- [x] 2. In `SidecarClient.tryConnect()` (client.ts), add a fallback: if the HTTP port file probe fails, try discovering the port via the Unix socket health response before returning null
- [x] 3. Add logging in the OpenCode plugin when sidecar HTTP calls fail (currently silently swallowed by `catch {}`)

### Fix 2: Improve auto-capture event quality (stretch)

- [x] 4. In the OpenCode plugin `tool.execute.after`, pass the actual tool output (bash stdout/stderr) into the ToolEvent instead of only quality-check issues — this requires checking what OpenCode provides in `output.args`
