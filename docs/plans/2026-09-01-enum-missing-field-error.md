# Missing Required Enum Reported as Invalid Value Fix Plan

Created: 2026-09-01
Status: COMPLETE
Approved: Yes
Iterations: 0
Worktree: Yes
Type: Bugfix

## Summary

**Symptom:** Omitting a required enum field from an MCP tool call reports `invalid_value` — _"Invalid option: expected one of …"_ — which reads as "the value you sent is wrong". Missing **string** fields correctly report `invalid_type` / _"received undefined"_. The two are inconsistent, and the enum wording sends you to inspect a value that was never sent. (Issue #7)

**Trigger:** Any tool call where a required enum field is absent. In the reported case the arguments were being truncated **client-side** before reaching the server, so `type` and `project` genuinely arrived absent — `project` reported correctly, `type` did not.

**Root Cause:** `zod@4.3.6` — `z.enum()` treats `undefined` as a failed literal-set match rather than a type error, so it emits `invalid_value` identically for "absent" and "present but wrong". Sentinal's schemas are correct; the default message is what misleads. Affects 4 required enums (below).

## Investigation

**Reproduced in isolation** (zod 4.3.6, `/tmp/zprobe.mjs`):

| Schema | Input | Result |
| --- | --- | --- |
| `z.string()` | `undefined` | `invalid_type` — _"expected string, received undefined"_ ✅ |
| `z.enum([...])` | `undefined` | `invalid_value` — _"Invalid option: expected one of …"_ ❌ |
| `z.enum([...])` | `"zzz"` | `invalid_value` — **byte-identical message** |

The last row is the crux: zod emits the *same* issue for a missing field and a wrong value, so nothing downstream can tell them apart from the message alone.

**The fix mechanism is verified working.** `z.enum(values, { error: (iss) => ... })` receives the issue with `iss.input`, so `iss.input === undefined` distinguishes the two cases. Returning `undefined` from the error function falls back to zod's default, so wrong-value messages stay byte-identical:

```
custom: undefined   → "Required — received undefined"                 (changed)
custom: wrong value → "Invalid option: expected one of \"a\"|\"b\"|\"c\""  (unchanged)
custom: valid       → OK                                              (unchanged)
```

**Scope — 4 required enums, all agent-reachable:**

| Tool | Field | Site |
| --- | --- | --- |
| `memory_save` | `type` | `src/memory/mcp-tools.ts:272` |
| `memory_maintain` | `action` | `src/memory/mcp-tools.ts:418` |
| `tdd_set_state` | `state` | `src/tdd/mcp-tools.ts:112` |
| `spec_notify` | `type` | `src/spec/events-mcp-tools.ts:50` |

Optional enums (`memory_search.type`, `memory_update.type`, `quality_report.checks`) are unaffected — a missing value simply passes. Enums in `src/*/types.ts`, `src/runtime/schema.ts` and `src/runtime/pidfile.ts` are internal domain schemas, not agent-reachable tool inputs, and are out of scope.

⚠️ **`rg 'z\.enum'` under-reports.** Prettier splits the call across lines (`type: z\n  .enum(...)`), so that pattern found 15 of the 21 real occurrences. **Search `\.enum\(`.**

**Not in scope — the argument truncation.** Issue #7 is explicit, and memory observation #590 independently confirms it: the dropped arguments are an MCP **client** behaviour when one field is large (measured: ~530 chars fails; ~1900 chars succeeds if `type`/`project` are ordered *before* `content`). That is not a Sentinal defect. This plan fixes only the misleading message, which is what made the client-side truncation so expensive to diagnose.

## Behavior Contract

### Fix Property (C ⇒ P)

**When C:** a required enum field is absent from a tool call.
**Then P:** the error identifies the field as **missing** — the message names the field and states it was not supplied — consistent with the existing `invalid_type` / "received undefined" wording for strings.

### Preservation Property (!C ⇒ unchanged)

**When !C:** the field is present.

- Value **in** the enum → parses successfully, unchanged.
- Value **not** in the enum → message is **byte-identical** to today's _"Invalid option: expected one of …"_. Inspecting the value remains the correct response, so that wording must not change.
- The emitted `inputSchema` (JSON Schema) is **unchanged** — the enum's advertised values must not move.

## Fix Approach

**Strategy:** add a small shared helper that wraps `z.enum` with an error function distinguishing `iss.input === undefined` from a wrong value, then use it at the 4 required-enum sites. Contained and explicit.

⛔ **Rejected: `z.config({ customError })`.** It would fix every enum including future ones, but applies process-wide to every zod schema — internal domain schemas, SQLite row validation, runtime config parsing. Wrong blast radius for a bugfix.

**Drift guard:** a helper only works if new required enums remember to use it. Add a test that walks the MCP tool schemas and asserts every **required** enum carries the custom error — the same guard-the-invariant pattern already used by `IDENTICAL_RULES` in `src/cli/target-parity.test.ts`.

**Files:**

- Create: `src/utils/schema.ts` — `requiredEnum(values, description?)`
- Create: `src/utils/schema.test.ts`
- Modify: `src/memory/mcp-tools.ts` (2 sites), `src/tdd/mcp-tools.ts` (1), `src/spec/events-mcp-tools.ts` (1)

**Tests:** regression on the real tool via the MCP boundary, not just the bare schema — the message has to survive the SDK. `src/analysis/impact.test.ts` has the precedent: a real `Client` over `InMemoryTransport`.

⚠️ **`src/analysis/mcp-tools.ts` is 418 lines** (over the 400 warn) but is **not** touched by this fix — its only enum is the optional `quality_report.checks`.

## Progress

- [x] Task 1: Fix — helper, 4 call sites, regression + drift-guard tests — `ef81f1b`, +10 tests
- [x] Task 2: Verify — full suite, tsc, prettier — 2795 pass, tsc clean, prettier clean

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Implementation Notes

**Result (verified independently):** missing and wrong are now distinguishable, and the two missing-field messages are parallel:

```
[project] Invalid input: expected string, received undefined      (unchanged)
[type]    Invalid input: expected one of "decision"|…, received undefined   (NEW)
[type]    Invalid option: expected one of "decision"|…             (wrong value — BYTE-IDENTICAL)
```

- **⚠️ `client.callTool()` does NOT reject on invalid arguments.** It resolves with an `isError` result whose text embeds the zod issue array. A test written as `expect(...).rejects.toThrow()` would have passed **vacuously**. The harness parses the embedded JSON and asserts on the issue at a specific `path`.
- **The custom error never reaches the JSON-Schema converter** — proved, not assumed, via `client.listTools()`: `properties.type.enum` deep-equals all five values, description byte-identical, `type` still in `required`. That assertion passed **before** the change too, so it is a genuine before/after pin. Unlike `.refine()`, which the converter silently drops, a custom `error` is runtime-only.
- **Wording deviates from the plan's illustrative `"Required — received undefined"`** in favour of mirroring zod's own missing-string shape. The message deliberately does **not** repeat the field name: `path: ["type"]` already carries it, and `requiredEnum(values)` has no knowledge of the key it is bound to.
- **The drift guard is behavioural, not structural** — it patches `McpServer.prototype.tool` around `createSentinalServer()`, captures every raw zod shape, selects fields whose `_zod.def.type === "enum"` (optional enums surface as `"optional"` and are correctly skipped), then `safeParse(undefined)` on each. Mutation-verified: reverting `memory_maintain.action` to a bare `z.enum` → 9 pass / 1 fail naming exactly that offender, no collateral. A companion test pins that the guard finds exactly the four known enums, so it cannot silently degrade to scanning nothing.
- **TDD guard, 6th sighting:** its RED gate is unreachable for a brand-new module — a stub `src/utils/schema.ts` cannot be created because no test "exists" for a file that does not exist. RED was confirmed honestly by temporarily shadowing the import with a local bare-`z.enum` inside the test (4 fail / 6 pass). Relates to issue #5.
- `TDD_CYCLE_STATES` lives in `src/memory/types.ts`, not under `src/tdd/`.

## Tasks

### Task 1: Fix

**Objective:** Add `requiredEnum`, apply it at the 4 sites, prove the message changes for absent and is unchanged for wrong.

**Files:** `src/utils/schema.ts`, `src/utils/schema.test.ts`, `src/memory/mcp-tools.ts`, `src/tdd/mcp-tools.ts`, `src/spec/events-mcp-tools.ts`

**TDD:**

1. RED — call `memory_save` through a real `Client`/`InMemoryTransport` with `type` omitted; assert the error names the field as missing. Must fail with today's _"Invalid option"_ text.
2. RED — assert a **wrong** `type` value still yields the byte-identical _"Invalid option: expected one of …"_. Should pass before and after; it is the preservation pin.
3. GREEN — add `requiredEnum`, apply at all 4 sites.
4. Assert the emitted `inputSchema` for `memory_save.type` still advertises all 5 values.
5. Add the drift guard: every required enum in an MCP tool schema uses `requiredEnum`. **Mutation-verify it** — revert one site, confirm the guard fails, restore.

**Verify:** `bun test src/utils/schema.test.ts src/memory/ src/tdd/ src/spec/`

### Task 2: Verify

**Objective:** Full suite + quality checks.

**Verify:** `bun run embed-assets && bun test && bunx tsc --noEmit` — 0 failures (baseline **2785 pass**), tsc clean, `bunx prettier --check` clean on changed files only.

⛔ Never run prettier project-wide or call `quality_report` — the repo is not prettier-clean at HEAD (~85 unrelated files would be reformatted).
