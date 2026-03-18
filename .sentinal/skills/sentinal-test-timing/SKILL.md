---
name: sentinal-test-timing
description: |
  Fix for CI test failures caused by time-dependent assertions. Use when:
  (1) tests pass locally but fail in CI with undefined/missing data,
  (2) tests use hardcoded timestamps with rolling-window filtering (e.g., "last 7 days"),
  (3) subprocess-spawning tests timeout and cause cascading failures via concurrency guards.
author: Claude Code
version: 1.0.0
---

# Test Timing Patterns

## When to Use

- Tests fail in CI but pass locally (or vice versa)
- Error is `undefined is not an object` on data that should exist after filtering
- Tests spawn subprocesses (tsc, eslint, prettier) and hit bun:test's default 5s timeout
- One test timeout causes ALL subsequent tests in the same describe block to fail

## Solution

### Pattern 1: Rolling Window Timestamp Drift

**Problem:** Tests use hardcoded dates (e.g., `"2026-03-10T10:00:01Z"`) but the code filters by a rolling window (`Date.now() - 7 days`). As real time advances, the hardcoded date falls outside the window and filtered results become empty.

**Fix:** Use a dynamic recent timestamp:

```typescript
// BAD — will break after 7 days
const timestamp = "2026-03-10T10:00:01Z";

// GOOD — always 1 hour ago, always within any rolling window
const timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
```

**Detection:** Look for `getTime()`, `Date.now() -`, `WEEKLY_WINDOW`, `SESSION_WINDOW` in the implementation and hardcoded ISO dates in the test.

### Pattern 2: Subprocess Timeout Cascade

**Problem:** bun:test defaults to 5s per test. Tests that spawn tsc/eslint/prettier can take 5-30s in CI. When the first test times out, a concurrency guard (e.g., `activeChecks.has(projectPath)`) still has the project locked, causing ALL subsequent tests to get "already running" rejections.

**Fix:** Add per-test timeouts matching the subprocess timeout:

```typescript
// BAD — uses default 5s timeout
it("should run tsc check", async () => {
  const r = await post(base, "/quality-check", {
    projectPath,
    checks: ["tsc"],
    timeout: 60000, // subprocess timeout is 60s...
  });
  expect(r.ok).toBe(true);
});

// GOOD — test timeout matches subprocess timeout
it(
  "should run tsc check",
  async () => {
    const r = await post(base, "/quality-check", {
      projectPath,
      checks: ["tsc"],
      timeout: 60000,
    });
    expect(r.ok).toBe(true);
  },
  60_000, // bun:test timeout matches
);
```

**Detection:** Tests calling endpoints that spawn subprocesses without a third argument to `it()`. Look for `Bun.spawn`, `runWithTimeout`, or `child_process.exec` in the endpoint code.

## Verification

```bash
# Run affected tests with extended timeout to confirm
bun test <test-file> --timeout 60000

# Compare against baseline
git stash && bun test <test-file> && git stash pop
```

## When NOT to Use

- Tests that don't involve time filtering or subprocess spawning
- Tests failing for actual logic bugs (not timing)
- Tests with `--timeout` already set appropriately
