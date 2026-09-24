---
name: sentinal-opencode-api-source
description: |
  Where to find the AUTHORITATIVE OpenCode plugin/SDK API for the OpenCode plugin
  (targets/opencode/plugins/sentinal.ts), and how to keep that plugin's bundle
  self-contained. Use when: (1) adding/changing an OpenCode plugin hook, client
  call, dispose, workspace, or SDK usage, (2) unsure if a changelog capability
  (V2 plugin, dispose, session.list, event.subscribe) actually exists in the
  installed OpenCode, (3) the self-contained bundle guard fails
  (src/cli/target-assets.test.ts: "bare imports of zod or native externals"),
  (4) you need the OpenCode CHANGELOG (repo is anomalyco/opencode, not sst),
  (5) you changed a signature the plugin calls and `bunx tsc --noEmit` /
  check_diagnostics report nothing, (6) handling tool FAILURES in the plugin.
author: Claude Code
version: 1.1.0
---

# OpenCode Plugin/SDK API Sourcing & Bundle Purity

## When to Use

Any OpenCode-plugin work where you need the real API surface (not the hand-written
stubs) or must avoid crashing OpenCode at plugin load.

## 1. The API truth is on disk — not in our repo

`@opencode-ai/plugin` is **NOT installed in this repo** (package.json has no
`@opencode-ai/*`; `targets/opencode/types/opencode-plugin.d.ts` is a hand-written,
under-specified stub). The AUTHORITATIVE, version-exact types ship with the
installed OpenCode binary:

```bash
OC=$(readlink -f "$(which opencode)")            # e.g. ~/.opencode/bin/opencode
PLUG=$(dirname "$OC")/../node_modules/@opencode-ai/plugin/dist
SDK=$(dirname "$OC")/../node_modules/@opencode-ai/sdk/dist
cat "$PLUG/index.d.ts"        # Plugin, PluginInput, Hooks (all hook keys)
cat "$SDK/gen/sdk.gen.d.ts"   # OpencodeClient: session.list/get/..., event.subscribe
cat "$SDK/gen/types.gen.d.ts" # Session, McpLocalConfig (timeout field), etc.
```

Key facts confirmed this way (installed OpenCode 1.18.3):

- **`PluginInput.client` is the FULL SDK client** (`ReturnType<typeof createOpencodeClient>`),
  not the `app.log`+`session.messages` subset our stub declares. `client.session.list()`
  and `client.event.subscribe()` DO exist.
- The published plugin is **legacy-only**: `Plugin = (input, opts) => Promise<Hooks>`.
  There is **NO** `@opencode-ai/plugin/v2/{effect,promise}` and **NO `dispose`** key
  in `Hooks`. (The Effect-based V2 API exists in `anomalyco/opencode` upstream
  `packages/core/src/plugin/*` but is not surfaced to plugin authors.)
- MCP config timeout field: `McpLocalConfig.timeout?: number` ("timeout for
  fetching tools", default 5000). **No `cwd`** on `McpLocalConfig` in 1.18.3.
- Hook key drift risk: installed API uses `experimental.compaction.autocontinue`.

**OpenCode CHANGELOG:** repo is `anomalyco/opencode`, default branch `dev`. There
is NO raw `CHANGELOG.md`; use GitHub release notes:
`gh api "repos/anomalyco/opencode/releases?per_page=100"` (semver tags `vX.Y.Z`).

## 2. Spike-gate any changelog capability before building on it

Never migrate/build against a capability inferred from a changelog. Verify it in
the installed `.d.ts` (above) and, if runtime-only, dump it live from the plugin:
`log("client keys: " + Object.keys(client))`, run a real OC session, read
`~/.sentinal/plugin.debug.log`, then remove the probe. Record a verdict doc.

## 3. Bundle purity — the plugin .mjs must not reach bun:sqlite

`targets/opencode/plugins/sentinal.ts` is bundled to `sentinal.mjs` (embedded via
`bun run embed-assets`). If its import graph reaches `src/memory/store.ts`, Bun
hoists a top-level `import { Database } from "bun:sqlite"` (and pulls
sqlite-vec/@xenova), which **crashes OpenCode at load** on machines with
`node_modules` in `~/.config/opencode/`. Guard: `src/cli/target-assets.test.ts`
forbids bare `zod|bun:sqlite|sqlite-vec|@xenova/transformers` in the embedded bundle.

**Gotchas:**

- The guard reads the **embedded asset**, so it only catches a leak **after
  `bun run embed-assets`**. A committed embedded-asset can be STALE and hide a
  leak that a fresh build reintroduces — always re-embed + run the guard after
  touching the plugin or its `src/` imports.
- A `new MemoryStore()` or `await import(".../memory/store.js")` in a plugin
  handler is enough to pull it in. **Route DB/spec/session needs through the
  `sidecar` client instead** (it has no sqlite). Add a sidecar route + client
  method if the data isn't already exposed (e.g. `/session/alive`).
- Keep new plugin-only logic in `src/opencode/*.ts` with imports that DON'T reach
  `src/memory/*`. Inline small constants rather than importing from `memory/types`.

## 4. Type-check the plugin — the project gates can't see it

The root `tsconfig.json` includes only `src/**`, so `bunx tsc --noEmit` and
`check_diagnostics` are **silent** about `targets/`. A changed `src/` signature
the plugin calls stays green there (it happened: `sentinal.ts:1235`). Run:

```bash
.sentinal/skills/sentinal-opencode-api-source/scripts/typecheck-plugin.sh
```

An out-of-repo tsconfig needs `typeRoots` pointed back at the repo's
`node_modules` (else `TS2688 bun-types`) and `allowImportingTsExtensions`
(`sentinal.test.ts` imports `./sentinal.ts`, else `TS5097`). `bun run
build:opencode` does not type-check either.

## 5. Tool failures (verified on 1.18.32)

Non-zero bash exits reach `tool.execute.after` (`metadata.exit`) and finish
`completed`. Tools that **throw** skip `tool.execute.after` and surface only as
`event` → `message.part.updated`, `part.type === "tool"`,
`part.state.status === "error"`. Real `properties` = `{sessionID, part, time}`
(not the SDK union). De-duplicate on `part.id`, never `callID`.

## Verification

```bash
.sentinal/skills/sentinal-opencode-api-source/scripts/typecheck-plugin.sh
bun run embed-assets
rg -c 'from "bun:sqlite"|memory/store' targets/opencode/dist/sentinal.mjs   # want 0
bun test src/cli/target-assets.test.ts                                       # guard green
bun test targets/opencode/plugins/sentinal.test.ts                           # load-smoke (init-throw guard)
```

## When NOT to Use

- Claude Code hooks/MCP (different bundling; the compiled CLI binary uses
  `sentinal-compiled-bundling` rules, not this).
- Non-plugin `src/` code that legitimately uses `MemoryStore` directly.

## References

- Installed types: `~/.opencode/node_modules/@opencode-ai/{plugin,sdk}/dist/*.d.ts`
- `src/cli/target-assets.test.ts` (self-contained guard, FORBIDDEN_SPECIFIERS)
- Memory #343 (spike verdict: legacy API, SDK client available), #345 (session.idle
  bun:sqlite leak), #154 (--external zod leak), #124 (stale embedded assets)
- `.sentinal/rules/sentinal-dual-target.md`, `.sentinal/rules/sentinal-sidecar.md`
