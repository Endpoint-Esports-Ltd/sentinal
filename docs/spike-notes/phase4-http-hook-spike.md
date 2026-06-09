# Phase 4 Spike: HTTP Hook Transport

**Date:** 2026-06-09

## Method

Direct empirical measurement against the running sidecar (HTTP port 60688 + Unix socket). Claude Code documentation for request/response semantics.

## Findings

### Invocation

**Works per CC docs.** Format:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:PORT/hooks/tdd-guard"
}
```

CC POSTs the full hook event JSON as the request body. The response body is parsed as a hook decision (same rules as command stdout).

### Request Payload

CC sends the full `HookInput` JSON as the POST body — all fields available (`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`, etc.). This is a key advantage over MCP-tool hooks (which only expose a subset via variable substitution).

### Response Handling

The response body is parsed as a hook decision:

- `{"decision": "block", "reason": "..."}` → blocks the tool call
- `{"additionalContext": "..."}` → injects context
- Non-JSON or 2xx with no relevant JSON → continues normally
- Non-2xx → treated as a non-blocking error, execution continues

### Unix Socket Support

`curl --unix-socket` works from the command line. Whether CC's HTTP hook implementation supports `http+unix://` URLs is **not confirmed** — CC docs only show `http://` examples. The sidecar has both HTTP (dynamic port) and Unix socket available.

**Risk:** HTTP hooks require a hardcoded port in hooks.json, but the sidecar port is dynamic. Solutions:

1. Use a fixed port (add `--port 47123` to sidecar start) — requires config change
2. Route discovery via port file at hook runtime — not supported by static hooks.json
3. Use Unix socket URL if CC supports it
4. Use MCP-tool instead (avoids port discovery entirely)

### Latency

| Transport          | Median (ms) | Notes                          |
| ------------------ | ----------- | ------------------------------ |
| HTTP (curl)        | 8.7         | Same machine, loopback         |
| Unix socket (curl) | 8.8         | Negligible difference on macOS |
| Subprocess hook    | 63.7        | Baseline                       |

**~7.3× improvement** over subprocess. Essentially identical to MCP-tool expected latency.

### Conclusion

HTTP hooks are fast and receive the full HookInput payload (advantage over MCP-tool). But they have a critical operational problem: **the sidecar port is dynamic**. This makes HTTP hooks impractical unless we pin the port.

MCP-tool hooks avoid this entirely (MCP server is always reachable by name via the CC MCP registry). For Sentinal's use case, **MCP-tool is preferred over HTTP**.
