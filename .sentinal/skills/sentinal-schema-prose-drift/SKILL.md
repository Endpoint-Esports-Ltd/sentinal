---
name: sentinal-schema-prose-drift
description: |
  Changing an MCP tool's zod schema silently invalidates the shipped rules and
  /sync recipes that tell agents what payload to send — and a test that greps source
  text for field names cannot catch it. Use when: (1) editing any `z.object` exposed
  through `server.tool(...)`, (2) adding or renaming a schema field, (3) writing a
  test that asserts a documented parameter name exists, (4) adding a `.refine()` and
  expecting the agent to see the constraint, (5) shipped prose contains a literal
  example payload.
author: Claude Code
version: 1.0.0
---

# Schema / Prose Drift

## When to Use

Any change to a zod schema that reaches an agent through `server.tool()`, or any test
that claims to bind prose to a schema.

## The Three Traps

**1. The shipped docs are part of the contract.** Sentinal ships agent-facing prose
that states the payload shape — `targets/*/rules/mcp-servers.md` documents it, and
`/sync` Phase 7 *emits a literal recipe* into each project's generated rule. Change
the schema alone and agents keep sending the old shape against a rule that is now
wrong. Both surfaces are already in users' hands.

⛔ **A schema change and the shipped docs that describe it MUST land in the same task.**

**2. `.refine()` never reaches the agent.** The zod→JSON-Schema converter drops
refinements, so a constraint expressed only in `.refine()` is enforced **server-side
at parse time** and is invisible to the client. Pinned by `src/analysis/impact.test.ts`
(search `inputSchema`).

⇒ **Restate every constraint in `.describe()` text**, which does ship.

**3. `src.includes(fieldName)` cannot fail for its own reason.** A cross-check that
greps the schema file's raw text matches comments, error-message builders and helper
code. Measured: after renaming `moduleCount` → `universeSize` in the zod object, the
string still appeared on **25 other lines** of the same file, so the test stayed green.

⇒ **Bind to the parsed shape**, not the source text.

## Solution

**Constraints go in `.describe()`, not only `.refine()`:**

```ts
files: z.record(z.string(), z.number().int().nonnegative())
  .describe("Repo-relative path -> count. Must cover EVERY changed .ts/.tsx/.js file, " +
            "and every value must be <= moduleCount (a larger value proves the two " +
            "came from different metrics).")
```

**Consider `.strict()`.** Without it, a mis-nested key is silently stripped and the
tool answers with wrong defaults instead of erroring — a silent wrong answer is worse
than a rejection. In zod 4 `.strict()` does not disturb `.shape`, so shape-bound tests
keep working.

**Bind cross-checks to the shape:**

```ts
import { AgentReachSchema } from "../analysis/reach.js";
import { ReachSourceSchema, CallSiteSchema } from "../analysis/reach-sources.js";

const FIELDS = new Set([
  ...Object.keys(AgentReachSchema.shape),
  ...Object.keys(ReachSourceSchema.shape),
  ...Object.keys(CallSiteSchema.shape),
]);
// ✅ fails when a field is renamed
// ❌ never: readFileSync("reach.ts").includes("moduleCount")
```

**Add a contract test that parses the shipped examples.** Extract every literal
payload from the shipped prose and `safeParse` it against the **imported** schema:

```bash
rg -n 'reach=\{' targets/*/commands/sync.md targets/*/rules/mcp-servers.md
```

This is the cheap machine-checkable guard. See `src/cli/sync-graph-tools.test.ts`
(`PROSE_SOURCES`) for the working implementation — it covers 10 payloads across 4 files.

## Verification

```bash
bun test src/cli/sync-graph-tools.test.ts src/cli/plan-impact-prose.test.ts
```

**Mutation-verify, always.** Rename a schema field, confirm the test fails, revert.
An assertion you have not watched fail is an assertion you have not tested. A real run
of this produced 5 failures on a single rename; the naive `includes()` form produced 0.

## When NOT to Use

- Internal types and helpers not exposed via `server.tool()` — no agent-facing contract.
- Purely additive optional fields where the old shape still parses **and** you have
  verified the shipped examples still validate. Back-compat is the exception that
  makes an in-flight change safe, not a reason to skip the check.

## Example

```
Change:  AgentReachSchema restructured to accept `sources: [...]`
Missed:  targets/*/rules/mcp-servers.md still documented a flat `moduleCount`,
         and sync.md still EMITTED the old recipe into every project's rule.
         Neither file was in any task's Files list.
Caught:  by the plan-reviewer, not by 2600 passing tests.
Fixed:   both surfaces updated in the same task; single-object form kept valid;
         contract test now parses all 10 shipped examples against the real schema.
```

## References

- `src/analysis/reach.ts`, `src/analysis/reach-sources.ts` — schema + `.strict()` + `.describe()`
- `src/cli/sync-graph-tools.test.ts` — `PROSE_SOURCES`, the payload contract test
- `src/analysis/impact.test.ts` — asserts the emitted `inputSchema` via a real
  `Client` over `InMemoryTransport`
- `.sentinal/rules/sentinal-mcp-servers.md` — the add-a-tool checklist
