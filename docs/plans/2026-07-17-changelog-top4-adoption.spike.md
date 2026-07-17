# Capability Spike Verdict — Changelog Top-4 Adoption

**Date:** 2026-07-17
**Hosts tested:** Claude Code 2.1.185, OpenCode 1.18.3 (installed)
**Method:** Authoritative on-disk type definitions + official docs (not guesses).

---

## Q1 — CC Stop hook exit-0 `additionalContext` → GATES TASK 2

**Verdict: `SOFT_EXIT0` ✅**

Claude Code docs (code.claude.com/docs/en/hooks) are explicit:

- A Stop hook may emit `{ "hookSpecificOutput": { "hookEventName": "Stop", "additionalContext": "..." } }` as **non-error feedback**; "the conversation continues so Claude can act on it, labeled as 'Stop hook feedback'." It keeps the turn going **under the 8-consecutive-continuation cap**.
- **Exit-code constraint (decisive):** "The hook must exit with code **0** for the JSON to be processed. If the hook exits with code **2**, any JSON output is **ignored**."

**Resolves plan-review must-fix #1:** the codebase's `blockExit` docstring ("exiting 0 downgrades to a no-op") applies ONLY to the `{decision:"block"}` hard-block route. For `additionalContext`, exit 0 is REQUIRED and works.

**Task 2 mechanism:** `stopContext(reason)` = `output(hint("Stop", reason))` then exit 0. NO `decision:"block"`. The `SENTINAL_STOP_GUARD_HARD=1` escape still uses `denyExit` (exit 2).

---

## Q2 — OpenCode V2 / Promise plugin API → GATES TASK 4

**Verdict: NOT AVAILABLE on 1.18.3 → Task 4 path = `LEGACY_DISPOSE_FALLBACK` ✅ (gate working as designed)**

`/Users/evan/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (the shipped plugin package) exports ONLY the **legacy** plugin type:

```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
export type PluginModule = { id?: string; server: Plugin; tui?: never };
```

There is **no `@opencode-ai/plugin/v2/effect` or `/v2/promise`** in the published package. The Effect-based V2 API exists in upstream `packages/core/src/plugin/*` but is **not surfaced to plugin authors** in the installed release.

**Decision:** Do NOT attempt the full V2 migration. It is not viable against the installed host and would be a blind rewrite. Full V2 is **deferred** to a future plan if/when `@opencode-ai/plugin/v2` is published.

---

## Q3 — OpenCode plugin `dispose` hook

**Verdict: NO `dispose` key in the installed `Hooks` interface.**

The installed `Hooks` interface (index.d.ts) contains: `event`, `config`, `tool`, `auth`, `provider`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before`, `shell.env`, `tool.execute.after`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete`, `tool.definition`. **No `dispose`.**

**Decision (Task 3):** dispose-equivalent teardown stays on the legacy plugin — extract the current `session.deleted`-branch shutdown into a testable `src/opencode/plugin-dispose.ts` and invoke it from `session.deleted` (and any future `dispose` when available). Note: the SDK client has an `InstanceDispose` endpoint (client-level), not a plugin hook.

---

## Q4 — OpenCode SDK active-sessions + event stream → GATES TASK 5

**Verdict: FULLY AVAILABLE ✅**

`PluginInput.client = ReturnType<typeof createOpencodeClient>` — the **full SDK client**, NOT the stripped `app.log`+`session.messages` we hand-typed in `targets/opencode/types/opencode-plugin.d.ts`.

The SDK `Session` class exposes: **`list`**, create, status, delete, get, update, children, todo, init, fork, abort, unshare, share, diff, summarize, messages, prompt, message, promptAsync, command, shell, revert, unrevert.
The SDK `Event` class exposes: **`subscribe`**.

**Decision (Task 5):** `client.session.list()` is the authoritative active-sessions source; `MemoryStore.isSessionAlive` remains the fallback. Also **widen the hand-written client type** (`opencode-plugin.d.ts`) to include `session.list` (guarded at runtime with `typeof client.session?.list === "function"`).

---

## MCP timeout field names → feeds TASK 6

- **OpenCode:** `McpLocalConfig.timeout?: number` (ms) — "Timeout in ms for **fetching tools** from the MCP server. Defaults to 5000." ⚠️ This is a tool-**catalog-fetch** timeout, NOT a per-tool-call timeout. Set it generously so our 28-tool catalog + cold sidecar don't trip the 5s default. **No `cwd` field** on `McpLocalConfig` in 1.18.3 — drop the `cwd` idea for OC (changelog v1.17.4 not reflected in the shipped type).
- **Claude Code:** per-server `timeout` (min 1000ms; sub-1000 ignored, CC 2.1.162). This governs MCP tool-call requests.

**Decision (Task 6):** OC `sentinal` entry → `"timeout": 30000` (tool-fetch headroom). CC `.mcp.json` `sentinal` entry → `"timeout": 120000` (covers embedding cold-start + 3×30s quality run). Re-embed `.mcp.json` (mandatory).

---

## Additional finding (out of top-4 scope — flag only)

The installed `Hooks` uses **`experimental.compaction.autocontinue`**, but our plugin registers **`compaction.autocontinue`** (no `experimental.` prefix). This may be a silent no-op on 1.18.3. Not in scope for this plan; recorded for a follow-up.

---

## Gate outcomes

| Task | Path set by spike |
| --- | --- |
| Task 2 (CC stop-guard) | **`SOFT_EXIT0`** — `hint("Stop", reason)` at exit 0 |
| Task 4 (OC V2) | **`LEGACY_DISPOSE_FALLBACK`** — full V2 deferred, dispose-equivalent teardown only |
| Task 5 (OC SDK sessions) | **PROCEED** — `client.session.list()` authoritative + store fallback |
| Task 6 (MCP timeouts) | OC `timeout:30000`, CC `timeout:120000`; no OC `cwd` |
