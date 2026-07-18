---
name: sentinal-bun-e2e-discovery
description: |
  Bun test file-discovery + runner gotchas for slow/opt-in tests that must be
  EXCLUDED from the default `bun test` but runnable on demand. Use when:
  (1) adding a test that must NOT run in the default suite (e2e, network, opt-in),
  (2) `bun test tests/e2e/` or a directory path finds NO test files,
  (3) `bun test ./file` errors "Tests need '.test'/'.spec'/'_test_'/'_spec_' in the filename",
  (4) a runner script's "0 tests ran" / result-count check is wrong,
  (5) a block comment breaks parsing with "Unexpected *".
author: Claude Code
version: 1.0.0
---

# Bun Test Discovery & Runner Gotchas

## When to Use

Wiring or debugging tests that must be excluded from the default `bun test` yet
run via an explicit runner (E2E, network, opt-in gates), or a script that shells
out to `bun test` and inspects the result.

## The rules (all verified in this repo)

1. **Naming controls discovery.** A bare `bun test` globs `**/*.test.ts`. To
   EXCLUDE a file from the default suite, name it `*.e2e.ts` or `*.spec-e2e.ts`
   (NOT `*.e2e.test.ts` — that still ends in `.test.ts` and IS discovered).
   Unit tests that SHOULD run in the default suite keep `*.test.ts`.

2. **Bun's DIRECTORY scan also skips those suffixes.** `bun test tests/e2e/`
   finds NOTHING, because dir-scan requires a `.test.`/`.spec.` (dotted) or
   `_test_`/`_spec_` token — `.e2e.ts`/`.spec-e2e.ts` don't match. So a runner
   MUST enumerate explicit file paths, not a directory:
   ```bash
   bun test ./tests/e2e/harness/sandbox.spec-e2e.ts ./tests/e2e/foo.e2e.ts ...
   ```

3. **Explicit `.e2e.ts` paths need a `./` prefix.** `bun test tests/e2e/x.e2e.ts`
   is treated as a name FILTER (finds nothing → "Tests need '.test'/'.spec'..."):
   run `bun test ./tests/e2e/x.e2e.ts`.

4. **`bun test` writes its results to STDERR**, including the `Ran N tests across
   M files` summary. A script that captures only stdout sees an empty result. In
   `spawnSync`, use `stdio: ["inherit","pipe","pipe"]` and inspect
   `stdout + stderr`.

5. **`*/` inside a block comment closes it early** ("Unexpected *"). In test
   files that document globs like `**/*.test.ts`, use `//` line comments, not
   `/* ... */`.

6. **Sentinal's TDD guard treats a new `*.e2e.ts`/harness `.ts` as an impl file.**
   Before writing one, set it RED_CONFIRMED so the guard allows the write:
   `tdd_set_state { file_path=<the .e2e.ts>, test_file_path=<same>, state:"RED_CONFIRMED", spec_id }`.

## Falsifiable exclusion check (both halves)

Do NOT rely on `bun test 2>&1 | rg -c "<file>"` == 0 — a passing run may not print
filenames at all (trivially 0). Instead:

```bash
# POSITIVE: the unit test IS discovered by the default suite
bun test --test-name-pattern "<a name defined in the .test.ts>"   # >0 tests run
# NEGATIVE: a name defined ONLY in a .e2e.ts is NOT in the default suite
bun test --test-name-pattern "<a name defined only in an .e2e.ts>" # "matched 0 tests"
```

## Runner 0-tests guard (guards a mistyped ./path silently running nothing)

```js
const combined = (proc.stdout ?? "") + (proc.stderr ?? "");
const ran = Number(/Ran (\d+) tests?/.exec(combined)?.[1] ?? 0);
if (ran === 0) throw new Error("gate ran 0 tests — a path is likely mistyped");
```

## Verification

```bash
bun test > /tmp/t.log 2>&1; echo $?         # default suite: e2e files NOT run
grep -c "tests/e2e/.*\.e2e" /tmp/t.log      # 0 (excluded)
bun run e2e                                 # explicit-path runner: e2e files DO run
```

## When NOT to Use

- Ordinary `*.test.ts` unit tests (default discovery is correct for them).
- Jest/Vitest projects — this is bun:test-specific discovery behavior.

## References

- `package.json` scripts `e2e` / `pre-release` (explicit path enumeration)
- `scripts/pre-release.mjs` (stderr capture + 0-tests guard)
- Sibling skill `sentinal-e2e-harness`; `sentinal-ci-only-failures` (exit-code leaks)
