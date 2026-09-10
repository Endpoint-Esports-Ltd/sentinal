## Verification

**Core Rules:** (1) Tests passing ≠ program working — always execute. (2) No completion claims without fresh evidence in the current message.

### Execution Verification

Unit tests with mocks prove nothing about real-world behavior. After tests pass:

- CLI command → **run it** | API endpoint → **call it** | Frontend UI → **open it in a browser-automation tool with instance isolation** — `playwright-cli -s="${SENTINAL_SESSION_ID:-default}"`, or Chrome DevTools MCP against a dedicated Chrome (see `playwright-cli.md`)
- Any runnable program → **run it**

**When:** After tests pass, after refactoring, after changing imports/deps/config, before marking any task complete.

**Skip only for:** documentation-only, test-only, pure internal refactoring (no entry points), config-only changes.

### ⛔ Frontend Changes Require Browser Verification

**Unit tests and typechecks are NOT sufficient.** After tests pass, verify in a real browser that the change works in the running app: build → open → snapshot/interact → close. Use `playwright-cli` (with session isolation) **or** Chrome DevTools MCP — either satisfies this; instance isolation does not.

**Common pitfalls:** stale cached bundles, bundle not deployed to served location, CSS layout issues invisible to tests, elements in DOM but not visible/interactive.

### ⛔ A Worktree Isolates Code, Not Runtime

A git worktree gives you a separate checkout. It gives you **nothing else**. Ports, databases, caches, queues and OS processes are still shared with the developer's main checkout and with every other worktree on the machine. Before starting anything:

1. **If `.sentinal/runtime.json` declares an `up` command, start it with the `runtime_up` MCP tool — that is the only thing that actually buys you isolation.** Pass the WORKTREE path as `project`. `runtime_up` runs the declared lifecycle for you: **`up` → wait for `readiness` → ready.** It starts the stack in a process group Sentinal owns, records that group in `.sentinal/runtime.pid`, and returns only once the readiness probe passes — never start the tests before it does, because a failure against a half-booted stack looks exactly like a code bug. Every failure it returns already carries the tail of `.sentinal/runtime.log`; read it before changing anything. Use `runtime_config` if you only want to *see* the contract (already interpolated for this worktree's slot) without starting it. **No `.sentinal/runtime.json`? Nothing changes** — fall through to the rules below.
2. **Otherwise determine what this run shares.** **Do not copy the repo-root `.env` into the worktree** — it points at the developer's live databases, caches and queues. Git worktrees correctly do not inherit gitignored files; copying one in defeats that on purpose. **State plainly what is shared and proceed** — do not stop to ask on every run. Ask only where the project has explicitly declared a resource `"shared"` in `.sentinal/runtime.json`. **An undeclared resource is `unknown`, not `shared` — report it and carry on; never prompt on `unknown`**, because a prompt that fires on every run of every project carries no information. ⚠️ `isolation` is **self-attested**: Sentinal cannot verify it and never infers `"isolated"` for you, so a wrong `"isolated"` is a silent green light and is worse than having no file at all.
3. **Stop what you started with `runtime_stop`, not with a pattern.** `runtime_stop` signals **only** the process group recorded in this worktree's pidfile, and refuses outright when it cannot prove the process still belongs to this worktree — so it can never reach the developer's processes. It is idempotent and safe to call twice. Anything you start **outside** the contract, you must record the PID of yourself and stop by PID. **Never terminate by name or pattern** (`pkill -f`, `killall`) — a pattern matches the developer's processes too, and you cannot tell from the pattern which ones you own.
4. **If the port you need is occupied, stop and ask. Never switch to a different port.** A second stack on a spare port still writes to the same shared database — **a free port proves nothing about what is behind it**, so re-porting converts a loud, obvious failure into a silent one that corrupts shared state. `runtime_up` enforces this structurally: an occupied port with no pidfile is a hard failure, and there is no code path anywhere in it that tries another port. If a *previous* run's group is still holding the port it will offer to reuse or reap that group — a stack it did not start is always left alone.
5. **Tests green is not a pass if the stack died mid-run.** Re-check the runtime is still up before reporting success; a run that finished green against a stack that fell over partway through is a false pass.

#### ⚠️ Process ownership is POSIX-only

`runtime_up` / `runtime_stop` own a **process group**, which exists on macOS, Linux and other POSIX systems. **On Windows there is no process group**, so Sentinal records none and teardown reduces to running the declared `down` command — the guarantee there is _"we ran the declared `down`"_, not _"we own the PIDs"_. A Windows contract with **no** `down` and a non-detaching `up` has no teardown mechanism at all; `runtime_stop` reports that as an explicit failure naming the PID rather than pretending to have stopped it. **On Windows, declare a `down`.**

The same reduction applies on any platform when `"detached": true`: a detaching starter (`docker compose up -d`, `pm2 start`) returns immediately and the group it left behind owns nothing, which is why the contract requires `down` in that case.

#### Destructive-command confirmation (Sentinal opt-out default)

Sentinal ships a default that turns `pkill` / `killall` into a **native confirmation prompt**, using the platform's own permission engine. It is a backstop for rule 3, not a substitute for it.

| Platform        | Shipped?                                                                                                                                    | How to change it                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenCode**    | Yes — `permission.bash` in your `opencode.json`                                                                                             | **Change the value to `"allow"`. Do not delete the line.** The installer merges additively: a _deleted_ key is re-added on the next update, a _changed_ value is preserved.                                  |
| **Claude Code** | No. Claude Code reads only the `agent` and `subagentStatusLine` keys from a plugin's `settings.json`, so Sentinal cannot ship this default. | To opt **in**, add to your own `~/.claude/settings.json`: `"permissions": { "ask": ["Bash(pkill:*)", "Bash(killall:*)"] }`. An `ask` rule takes precedence over any `allow` rule, including a bare `"Bash"`. |

**Coverage limit — read this before relying on it.** Permission patterns match the command string. On Claude Code each subcommand of a compound command is matched independently, so `foo && pkill -f x` prompts, but `sh -c "pkill …"` does not. On OpenCode the pattern matches the whole command string, so anything other than a leading `pkill` / `killall` does not prompt. **Rule 3 above is the primary control. The prompt is only a backstop, and it is one you own and can remove.**

### Output Correctness

**Running without errors ≠ correct output.** If code processes external data, fetch that data independently and compare. Numbers and content MUST match.

### Evidence Before Claims

**Before proceeding:** Ask "Do these tests verify what matters, or only what was easy to test?" If important edge cases go untested, acknowledge the gap explicitly — don't claim full coverage when you only have partial coverage.

1. **Identify** — What command proves this claim?
2. **Execute** — Run the full command (not cached)
3. **Read output** — Check exit code, count failures
4. **Report** — State claim WITH evidence

**If you haven't run the command in this message, you cannot claim it passes.**

| Claim            | Required Evidence       | Insufficient                |
| ---------------- | ----------------------- | --------------------------- |
| "Tests pass"     | Fresh run: 0 failures   | Previous run, "should pass" |
| "Build succeeds" | Build exit 0            | "Linter passed"             |
| "Bug fixed"      | Reproducing test passes | "Code changed"              |
| "UI works"       | Browser snapshot        | "API returns 200"           |

### ⛔ Fix ALL Errors — No Exceptions, No Asking

When verification reveals errors during a `/spec` workflow, fix ALL of them without asking. Outside of `/spec`, respect the user's current mode — if in plan mode, present the issues and proposed fixes instead of applying them directly.

### ⛔ Auto-Fix in /spec Workflow

**must_fix** and **should_fix** → Fix immediately. **suggestions** → Implement if quick. The ONLY user interaction in /spec is plan approval.

### Sentinal Quality Tools

**Quality checks (tsc, eslint, prettier) do NOT run automatically on every edit.** Sentinal only performs instant structural checks (file length, companion tests) per edit. You MUST call `quality_report` after finishing edits to each file.

| Tool                | When                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `quality_report`    | **MUST call after finishing edits to each file.** Runs tsc + eslint + prettier in one call. |
| `check_diagnostics` | TypeScript diagnostics with delta tracking (NEW/FIXED since last run). Spec-filtered.       |
| `impact_analysis`   | Verify changed files align with active spec. Shows file length warnings and risk score.     |

**Prefer `quality_report`** over running tsc/eslint/prettier separately. **Prefer `check_diagnostics`** over raw `npx tsc --noEmit` — it filters to spec-relevant files and tracks deltas.

### Stop Signals — Verify NOW

If you're about to use uncertain language ("should", "probably"), express satisfaction ("Done!"), commit/push, or mark task complete — run verification first.

### When Execution Fails After Tests Pass

This is a real bug. During `/spec`, fix immediately → re-run tests → re-execute → add test to catch this failure type. Outside `/spec`, report the issue and proposed fix to the user.
