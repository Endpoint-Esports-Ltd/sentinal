## Testing

### TDD — Mandatory Workflow

**⛔ STOP: Do you have a failing test? If not, write the test FIRST.**

#### The Red-Green-Refactor Cycle

1. **RED** — Write one minimal test for the desired behavior. Focus on behavior, not implementation. Mocks only for external deps.
   - **Naming:** TS: `it("should <behavior> when <condition>")`
2. **VERIFY RED** — Run the test, confirm it fails because the feature doesn't exist (not syntax errors). If it passes → rewrite.
3. **GREEN** — Write the simplest code that passes. No extras, no refactoring. Hardcoding is fine.
4. **VERIFY GREEN** — Run all tests, confirm they pass. Check diagnostics.
5. **REFACTOR** — Improve code quality (tests must stay green). No new behavior.

**When TDD applies:** New functions, API endpoints, business logic, bug fixes (reproduce first), behavior changes.

**Skip:** Documentation, config updates, dependency versions, formatting-only.

**Recovery (code written before test):** Don't revert — write the test immediately, verify it catches regressions. Goal is coverage, not ritual.

**TDD MCP tools:** Use `tdd_status` to check current TDD cycle state. Use `tdd_set_state` to set state (e.g. `RED_CONFIRMED` to allow implementation edits after verifying a red test). Use `tdd_clear` to clean up TDD state after completing a cycle.

---

### Test Strategy & Coverage

**Unit tests for logic, integration tests for interactions, E2E tests for workflows. Minimum 80% coverage.**

| Type            | Use When                                              | Requirements                       |
| --------------- | ----------------------------------------------------- | ---------------------------------- |
| **Unit**        | Pure functions, business logic, validation, utilities | < 1ms each, mock ALL external deps |
| **Integration** | DB queries, external APIs, file I/O, auth flows       | Real test deps, fixtures, cleanup  |
| **E2E**         | Complete user workflows, API chains, data pipelines   | Test entire flow                   |

```
External dependencies? NO → Unit test | YES → Integration test
Complete user workflow? YES → E2E test | NO → Unit or integration
```

### Property-Based Testing (PBT)

**Use PBT when behavior depends on data shape, ranges, or combinations — not a single known input.**

| Language   | Tool         | Example                                               |
| ---------- | ------------ | ----------------------------------------------------- |
| TypeScript | `fast-check` | `fc.assert(fc.property(fc.array(fc.integer()), ...))` |

**When to use:** Parsers, serializers, data structure invariants, encode/decode roundtrips, bugfix preservation properties.

**When NOT to use:** Simple CRUD, UI interactions, fixed-input validation, config changes.

**Rules:** PBT supplements example-based tests — don't replace them. Set `numRuns` low enough for CI (100–200).

### Running Tests

```bash
bun test                              # Bun (preferred for this project)
npm test -- --silent                  # Jest/Vitest
npx ng test --watch=false            # Angular
```

### Mandatory Mocking in Unit Tests

| Call Type     | MUST Mock          | Example                         |
| ------------- | ------------------ | ------------------------------- |
| HTTP/Network  | `fetch`, `axios`   | `vi.mock('axios')`              |
| Subprocess    | `subprocess.run`   | `jest.mock('child_process')`    |
| File I/O      | `fs`, `path`       | `jest.mock('fs')` or `tmp_path` |
| Database      | SQLite, PostgreSQL | Use test fixtures               |
| External APIs | Any third-party    | Mock the client                 |

Mock at module level (where imported, not where defined). Test > 1s = likely unmocked I/O.

### E2E: Frontend/UI (MANDATORY for web apps)

Use `playwright-cli` with session isolation (`-s="${SENTINAL_SESSION_ID:-default}"`) for all E2E verification. See `playwright-cli.md`.

### ⛔ Mock Audit on Dependency Changes

**When adding a new dependency to an existing function, you MUST update ALL existing tests for that function.** Search for the function name in test files and add mocks for the new dependency to every test.

**Checklist when modifying a function's dependencies:**

1. `Grep` for the function name in test files
2. For each test: verify all subprocess/I/O calls are mocked
3. Run tests with `--tb=short` to catch unmocked calls fast

### Anti-Patterns

- **Dependent tests** — each test must work independently
- **Testing implementation, not behavior** — assert outputs and state changes, not that specific mocks were called
- **Incomplete mocks hiding structural assumptions** — mocks must mirror the complete real API structure
- **Unmocked environment dependencies** — tests that rely on locally-installed tools pass locally but fail in CI
- **Test-only methods in production** — never add methods purely for test access
- **Mocking without understanding** — before mocking a dependency, understand what it actually does

### ⛔ Zero Tolerance for Failing Tests

**Every test failure MUST be fixed before work is done.** Run the FULL suite, not just files you touched.

### Completion Checklist

- [ ] All new functions have tests
- [ ] Tests follow naming convention
- [ ] Unit tests mock external dependencies
- [ ] **Full test suite passes (0 failures)**
- [ ] Coverage ≥ 80% verified
- [ ] Actual program executed and verified
