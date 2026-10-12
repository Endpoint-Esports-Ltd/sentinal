# Phase 4 Spike: HTTP Hook Transport

**Date:** 2026-06-09 (curl benchmarks + docs) — **re-run live 2026-10-12** on Claude Code 2.1.287

## Method

The 2026-06-09 version measured the sidecar with curl and took CC's behaviour from its docs. On
2026-10-12 the hooks were run in live headless sessions (`claude -p --settings <throwaway>
--debug-file <log>`) in a throwaway repo, against (a) a local Bun receiver that logged every request
and answered block JSON for `blocked.txt` and hint JSON otherwise, and (b) the running sidecar's
`/health` (the plan's target). Nothing in this repo was modified; there is nothing to revert.

## Findings

### Invocation — confirmed

```json
{ "type": "http", "url": "http://127.0.0.1:PORT/hook", "timeout": 5 }
```

`Hooks: HTTP hook POST to http://127.0.0.1:47611/hook` → `response status 200`. CC always
**POSTs**: the sidecar's GET-only `/health` answered `404`.

### Request Payload — confirmed full

`Content-Type: application/json`, `User-Agent: axios/1.15.2`, body ~650 bytes with keys
`session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name,
tool_input, tool_use_id`. `tool_input.file_path` is absolute. This is the full hook input — the
advantage over MCP-tool hooks.

### Response Handling — confirmed

- `{"decision":"block","reason":"HTTP-HOOK-BLOCKED: …"}` → Write **blocked** (`blocked.txt` never
  created); the model quoted the reason verbatim.
- `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}` → **delivered**;
  the model quoted `HTTP-HOOK-CONTEXT-MARKER`.
- Non-2xx → `error: status code 404` (`HTTP 404 from …/health`), a **non-blocking** error: the Read
  proceeded. Like MCP-tool hooks, HTTP hooks **fail open**.

### Unix Socket Support

**Not supported** (tested 2026-10-12 against a receiver on a Unix socket that `curl --unix-socket`
reached). Every URL form failed and the receiver saw no request:

| URL form                          | CC error                           |
| --------------------------------- | ---------------------------------- |
| `http+unix://<encoded-path>/hook` | `Unsupported protocol http+unix:`  |
| `unix://<path>:/hook`             | `Unsupported protocol unix:`       |
| `http://unix:<path>:/hook`        | `getaddrinfo ENOTFOUND unix`       |

The sidecar's Unix socket is therefore unreachable from HTTP hooks; only a TCP port works.

### Port

The sidecar's port is still dynamic (`~/.sentinal/sidecar.port` read `64814` on 2026-10-12;
`60688` on 2026-06-09). A static `hooks.json` URL therefore needs a pinned port.

### Latency

| Transport                    | Median / observed (ms) | Source                                    |
| ---------------------------- | ---------------------- | ----------------------------------------- |
| HTTP hook, live CC           | 2–7                    | CC debug log, POST → response (2 calls)   |
| HTTP (curl, sidecar)         | 8.7                    | 2026-06-09 benchmark                      |
| Unix socket (curl, sidecar)  | 8.8                    | 2026-06-09 benchmark                      |
| Subprocess hook              | 63.7                   | `docs/benchmarks/phase4-baseline.json`    |

### Conclusion

HTTP hooks work, block, hint, and receive the full payload, at single-digit milliseconds. The
operational problem stands: **the sidecar port is dynamic**, and the sidecar would also need POST
hook routes. MCP-tool remains preferred (no port), with the corrections recorded in
`phase4-mcp-tool-spike.md` — it must use the qualified server name `plugin:sentinal:sentinal`.
