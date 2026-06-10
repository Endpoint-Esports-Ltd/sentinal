---
name: sentinal-ci-only-failures
description: |
  Diagnosis for CI test failures that don't reproduce locally. Use when:
  (1) CI log shows full pass counts ("N pass / 0 fail") immediately followed
  by "Process completed with exit code 1", (2) CI fails a whole describe
  block with ENOENT or connection errors that pass locally, (3) release
  workflow shows "Test failure / Release skipped" but local bun test looks
  green.
author: Claude Code
version: 1.0.0
---

# CI-Only Test Failures (Pass Locally, Fail in CI)

## When to Use

Release/test workflow fails; the same suite "passes" on your machine.

## Solution — check in this order

### 1. Exit-code leak (all tests pass, exit 1)

Signature: pass summary then `##[error]Process completed with exit code 1`,
no failing test names.

**Bun gotcha:** `process.exitCode = undefined` does NOT clear a previously
set code (Node does). Any test exercising a CLI failure path that sets
`process.exitCode = 1` poisons the whole run unless reset to `0`:

```ts
afterEach(() => { process.exitCode = 0; });   // NOT undefined
```

Find the leaking file by running suspects individually and checking `$?`:

```bash
for f in src/path/*.test.ts; do bun test "$f" >/dev/null 2>&1; echo "$f → $?"; done
```

**⛔ Never trust `bun test | tail` / `| grep` for greenness — the pipe masks
the exit code.** Verify with `bun test > /tmp/t.log 2>&1; echo $?`.

### 2. Fresh-HOME assumption (ENOENT / connect failures in one suite)

CI runners have never created `~/.sentinal` (or any dotdir your code writes
to). Reproduce locally:

```bash
HOME=$(mktemp -d) bun test src/path/suite.test.ts
```

Fix at the source: `mkdirSync(dirname(target), { recursive: true })` before
any state-file write (see `startSidecar`, commit bace87a).

**Simulation caveat:** fake HOME also empties bun's cache, so
subprocess-spawning tests (tsc/eslint) may hit their 5s timeout as an
artifact — distinguish those from real failures (they pass in actual CI).

### 3. Test-order nondeterminism

CI checkouts have identical file mtimes → bun's file order can differ from
local, exposing ordering dependencies (e.g. an early test used to create a
directory a later suite needs). If a failure appears/disappears across
pushes with no related diff, suspect this; fix the hidden dependency, not
the order.

## Verification

```bash
bun test > /tmp/t.log 2>&1; echo "exit: $?"   # must be 0, not just "0 fail"
HOME=$(mktemp -d) bun test <suspect-suite>     # fresh-machine check
```

## When NOT to Use

- The failing test names ARE listed in CI → ordinary failure, debug directly.
- Failures also reproduce locally → not CI-specific.
- Timeout-only failures in subprocess tests → see sentinal-test-timing skill.

## Example

v1.30.0 release was blocked twice: 1473 pass / exit 1 (exitCode leak from a
`runSetupCommand` failure-path test, fixed in 6d26afe) and 26 sidecar
failures (missing `~/.sentinal` on the runner, fixed in bace87a).

## References

- Memory #141 (exitCode gotcha), #128 (fresh-HOME + repro technique)
