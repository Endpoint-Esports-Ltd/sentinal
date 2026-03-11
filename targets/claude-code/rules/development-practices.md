## Development Practices

### Codebase Search — Vexor First

**⛔ Always use Vexor as the first tool for codebase search.** Finds by intent, not exact text. Instant results via Bash. Only fall back to Grep/Glob when you need an exact symbol or pattern match that Vexor missed.

```bash
vexor "how is authentication handled"
vexor "database connection setup"
```

### Project-Specific Policies

**File Size:** Aim for production files under 400 lines. Over 600 lines is blocked by Sentinal hooks (tests exempt).

**Dependency Check:** Before modifying any function, use Vexor first (then `Grep` or LSP `findReferences` if needed) to find all callers. Update all affected call sites.

**Self-Correction:** Fix obvious mistakes (syntax errors, typos, missing imports) in code you are actively writing. Do not auto-fix errors in code the user edited — report them and let the user decide.

**Diagnostics:** Check before starting work and after changes. Fix all errors before marking complete.

**Formatting:** Let automated formatters handle style (Prettier runs automatically on every edit via Sentinal hooks).

### Systematic Debugging

**No fixes without root cause investigation. Complete phases sequentially.**

**Phase 1 — Root Cause:** Read errors completely, reproduce consistently, check recent changes (git diff), instrument at boundaries.

**Phase 2 — Pattern Analysis:** Use Vexor to find working examples in codebase by intent. Compare against references, identify ALL differences.

**Phase 3 — Hypothesis:** Form specific, falsifiable hypothesis. Test with minimal change — one variable at a time.

**Phase 4 — Implementation:** Create failing test first (TDD), implement single fix, verify completely.

**3+ failed fixes = architectural problem.** Question the pattern, don't fix again.

**Red Flags → STOP:** "Quick fix for now", multiple changes at once, proposing fixes before tracing data flow, 2+ failed fixes.

**Revert-First:** When something breaks during implementation:
1. **Revert** — undo the change that broke it. Clean state.
2. **Delete** — can the broken thing be removed entirely?
3. **One-liner** — minimal targeted fix only.
4. **None of the above** → stop, reconsider the approach.

**Meta-Debugging:** Treat your own code as foreign. Your mental model is a guess — the code's behavior is truth.

#### Defense-in-Depth & Root-Cause Tracing

**After fixing a bug, make it structurally impossible — not just patched.**

When a bug is caused by invalid data flowing through multiple layers:

1. **Trace backward** from symptom through the call chain to the original trigger. Fix at the source — never fix just where the error appears.
2. **Then add validation at every layer** the data passes through:

| Layer | Purpose | Example |
|-------|---------|---------|
| Entry point | Reject invalid input at API boundary | Validate non-empty, exists, correct type |
| Business logic | Ensure data makes sense for this operation | Validate required fields for specific context |
| Environment guards | Prevent dangerous operations in specific contexts | Refuse destructive ops outside temp dirs in tests |
| Debug instrumentation | Capture context for forensics | Log directory, cwd, stack trace before risky ops |

#### Condition-Based Waiting (Test Flakiness)

**Replace arbitrary `sleep`/`setTimeout` with polling for the actual condition.**

```typescript
// ❌ Guessing at timing (flaky)
await sleep(500)
const result = getResult()

// ✅ Wait for the condition (reliable)
const result = await waitFor(() => getResult() !== null, { timeout: 5000 })
```

**When to use:** Tests with arbitrary delays, flaky tests, waiting for async operations.

**Rules:** Poll every 10ms. Always include timeout with clear error message.

### Constraint Classification

When exploring a problem or codebase, classify constraints you encounter:

- **Hard** — non-negotiable (physical limits, external contracts, security requirements, deadlines)
- **Soft** — preferences or conventions — negotiable if trade-off is stated explicitly
- **Ghost** — past constraints baked into the current approach that **no longer apply**

Ghost constraints are the most valuable to find. Ask "why can't we do X?" — if nobody can point to a current requirement, it may be a ghost.

### Git Operations

**Read git state freely. NEVER execute write commands without EXPLICIT user permission.**

**⛔ Write commands need permission:** `git add`, `commit`, `push`, `pull`, `merge`, `rebase`, `reset`, `stash`, `checkout`, etc.

**⛔ NEVER `git checkout --` on unstaged changes.** This is irreversible — unstaged work is permanently lost. If the user wants to discard changes, tell them the consequences and let THEM run the command.

**⛔ Never `git add -f`.** If gitignored, tell the user — don't force-add.

**⛔ Never selectively unstage.** Commit ALL staged changes as-is.

**Read commands — always allowed:** `git status`, `diff`, `log`, `show`, `branch`
