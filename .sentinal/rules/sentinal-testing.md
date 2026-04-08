# Testing in Sentinal

Specifics about `bun test`, sqlite-vec preload, subprocess timeouts, and TDD expectations. Most of this differs from stock Bun/Jest docs.

## Runner: `bun test`, NOT Jest

Despite `package.json`'s description mentioning "jest", Sentinal uses **`bun:test`** (`bun test`). Tests import from `"bun:test"`, not `"@jest/globals"` or `"vitest"`.

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
```

## `bunfig.toml` Preload — sqlite-vec Native Addon

`bunfig.toml` preloads `src/memory/test-preload.ts`:

```toml
[test]
preload = ["./src/memory/test-preload.ts"]
```

The preload script loads **Homebrew SQLite** (macOS) before any `Database` instance is created, because default `bun:sqlite` cannot load the `sqlite-vec` extension. **Do not remove the preload** — memory/vector tests fail immediately without it.

If tests fail with `SQLITE_ERROR: not authorized` or `no such module: vec0`, the preload didn't run. Check:

- Test was launched through `bun test` (not `bun src/...test.ts` directly)
- `bunfig.toml` is in the working directory
- Homebrew SQLite is installed (`brew install sqlite`)

## Per-Test Timeouts — Subprocess Cascade Gotcha

Bun's default test timeout is **5 seconds**. Tests that spawn long-running subprocesses (tsc, eslint, prettier, sidecar spawn) will time out and — worse — can cascade-fail every subsequent test in the same describe block when a concurrency guard (e.g., `activeChecks.has(projectPath)`) stays locked.

**Always pass an explicit timeout as the 3rd argument to `it()`** when a test spawns subprocesses:

```ts
it(
  "runs tsc check",
  async () => {
    const r = await post(base, "/quality-check", {
      projectPath,
      checks: ["tsc"],
      timeout: 60000, // subprocess timeout
    });
    expect(r.ok).toBe(true);
  },
  60_000, // bun:test timeout MUST match subprocess timeout
);
```

See `.sentinal/skills/sentinal-test-timing/SKILL.md` for the full pattern (including the rolling-window date bug).

## Time-Dependent Tests

Never hardcode ISO dates in tests that interact with rolling-window filters (`Date.now() - 7*day`). Use dynamic offsets:

```ts
// BAD — breaks after 7 days
const timestamp = "2026-03-10T10:00:01Z";

// GOOD — always inside any sensible window
const timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
```

## TDD Enforcement on This Repo

Sentinal eats its own dog food. When editing `src/**/*.ts`:

- **The TDD guard blocks Write/Edit on an implementation file until a failing test exists in the corresponding `*.test.ts`.**
- Red → Green → Refactor: write a failing test first, then the implementation.
- Use `sentinal_tdd_status` / `sentinal_tdd_set_state` MCP tools (or the `sentinal hook shared tdd-guard`) to inspect state.
- Test files (`*.test.ts`, `*.spec.ts`) are exempt from both TDD guard and file-length limits.

## File-Length Limits Apply to Sentinal Too

- **Warn** at 400 lines.
- **Block** at 600 lines.
- Exempt: test files, generated files.
- If a file grows past 400 lines, split it by cohesion (one concept per file). See how `src/sidecar/` is organized into `routes.ts`, `quality-routes.ts`, `tdd-routes.ts`, etc.

## Running a Single Test

```bash
bun test src/memory/store.test.ts                     # single file
bun test --test-name-pattern "memory_search"          # filter by test name
bun test src/hooks/ --watch                           # watch a directory
```

Test discovery: bun picks up `**/*.test.ts` by default. No jest/vitest config needed.
