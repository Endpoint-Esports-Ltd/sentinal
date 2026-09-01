---
name: sentinal-sidecar-path-blindness
description: |
  Sentinal MCP tools get `store: null` in production because the sidecar is running.
  A tool that derives state from `store` silently does nothing in production while
  every test passes. Use when: (1) adding or changing a tool registered via a
  `registerXxxTools(server, { client, store })` function, (2) a tool's feature works
  in tests or locally but never appears in real output, (3) writing a regression test
  for anything in `src/*/mcp-tools.ts`, (4) auditing whether a tool has spec/DB
  context at runtime, (5) you see `effectiveStore`, `specStore`, or
  `store ?? (client ? null : new MemoryStore())` in a diff.
author: Claude Code
version: 1.0.0
---

# Sidecar Path Blindness

## When to Use

Any change to a tool registered through `{ client, store }` injection, or when a
feature demonstrably works under test but never fires in production.

This shipped **twice**. It caused `impact_analysis`'s entire spec-compliance half to
be inert in every real session (fixed in v1.36.0, `ab7068e`), and `check_diagnostics`
still has the same shape (issue #6).

## The Trap

```
src/mcp/server.ts:43          const store = client ? null : (opts.store ?? new MemoryStore());
                              └─ production ALWAYS has a client (server.ts connects one)
                                 ⇒ store === null

src/analysis/mcp-tools.ts:52  effectiveStore = store ?? (client ? null : new MemoryStore());  → null
                          :53 specStore = effectiveStore ? new SpecStore(effectiveStore) : null → null
                          :56 registerImpactAnalysisTool(server, specStore)

src/analysis/impact.ts:68     specStore?.getCurrentSpec(project) ?? null   → null, ALWAYS
```

Downstream, any `specFiles.size > 0` guard is permanently false. The feature does not
error — it silently evaluates to "nothing to do".

**Why no test caught it:** tests construct the tool with a real `store`, which is the
path that *works*. Production is the `client`-only path, which nothing exercised.
Passing tests were evidence about the wrong code path.

## Solution

**1. Find every tool with the same shape:**

```bash
rg -n 'effectiveStore|store \?\? \(client \?' src/*/mcp-tools.ts
```

As of v1.36.0 this returns **three** domains carrying the `client ? null :` shape —
`src/analysis/mcp-tools.ts:53` (fixed for `impact_analysis`, still open for
`check_diagnostics`, issue #6), `src/spec/mcp-tools.ts:54`, and
`src/tdd/mcp-tools.ts:27`. Each passes both `client` and a possibly-null
`effectiveStore` down to its tools, so whether it actually degrades depends on
whether the individual tool falls back to the client. **Audit per tool, not per
domain.** `src/worktree/mcp-tools.ts:77` is safe — it does `d.store ?? new
MemoryStore()` with no `client ? null :`, so it always has a store.

**2. Take the state from the sidecar client when the store is absent.** The client
already exposes the same reads — check `src/sidecar/client-routes.ts` before adding a
route:

```bash
rg -n 'async (getCurrentSpec|getSession|getTddState)' src/sidecar/client-routes.ts
```

Tool handlers are already `async`, so awaiting a client call is not a structural change.
Keep the `store` path for the no-sidecar fallback.

**3. Write the regression test on the CLIENT path — this is the whole point:**

```ts
// ✅ production's shape — fails before the fix
registerAnalysisTools(server, { client, store: null });

// ❌ the path that already worked; proves nothing
registerImpactAnalysisTool(server, specStore);
```

Register through the **production entry point** (`registerXxxTools`), not the inner
per-tool function, or the wiring under test is bypassed.

## Verification

```bash
bun test src/analysis/          # new client-path test must FAIL before the fix
rg -n 'store: null' src/**/*.test.ts   # confirm the client path is covered somewhere
```

Confirm RED for the right reason: the assertion should fail on **missing feature
output**, not on a thrown error.

## When NOT to Use

- Tools registered as **direct-only by design** — `registerRuntimeTools` ignores its
  deps deliberately (stateless fs reads; see the docblock in `src/runtime/mcp-tools.ts`).
  Do not "fix" those by adding a route.
- Pure functions and helpers with no `{ client, store }` in scope.
- Cases where `null` state degrades **safely**. `check_diagnostics` over-reports rather
  than dropping signal, which is why it was deferred rather than rushed — but it is
  still wrong, and it is issue #6.

## Example

```
Symptom:  impact_analysis never printed "_Active spec:_" and never warned about
          unexpected files, in any real session. All 2588 tests passed.
Cause:    specStore was null under the sidecar, so specFiles was always empty and
          `hasUnexpected = specFiles.size > 0 && ...` was permanently false —
          killing one of only two HIGH risk triggers.
Fix:      thread SidecarClient through; resolve via client.getCurrentSpec(project)
          when specStore is null.
Test:     registerAnalysisTools(server, { client, store: null }) → assert the spec
          title renders. Failed before, passes after.
```

## References

- `src/mcp/server.ts:43` — where `store` becomes null
- `src/analysis/mcp-tools.ts:52-56` — the injection chain
- `src/sidecar/client-routes.ts` — reads available on the client
- Issue #6 — `check_diagnostics` still has this shape
- `.sentinal/rules/sentinal-sidecar.md`, `.sentinal/rules/sentinal-mcp-servers.md`
