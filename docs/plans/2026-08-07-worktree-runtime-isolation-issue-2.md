# GitHub Issue #2 (verbatim)

> Source of truth for `docs/plans/2026-08-07-worktree-runtime-isolation.md`.
> Captured 2026-08-07 via `gh issue view 2`. Do not edit.

## Worktree runtime isolation: spec-verify treats shared ports/DBs as something to work around, not isolate from

## Summary

A Sentinal worktree isolates **code**, but not **runtime**. Ports, databases, caches, queues and OS processes are still shared with the developer's main checkout and with every other concurrent worktree.

`spec-verify` Phase B instructs the agent to run the program, and its only isolation guidance tells the agent to *inspect* shared global state rather than *isolate* from it:

```
Step 3.6b  Check `ps aux | grep <service>` before restarting shared services.
Step 3.7   ⚠️ Parallel spec warning: Before starting a server, check port availability: `lsof -i :<port>`.
```

"Find a free port" implicitly authorises running against the developer's **live database** on a different port — and that half is never mentioned. The worktree gives a false sense of sandboxing, which makes the omission easy to miss.

**Environment:** Sentinal 1.33.0, OpenCode, a TypeScript monorepo with a multi-app dev stack.

## Concrete incident

Verifying a change to application startup logic, in a worktree, an agent (me) did the following:

1. Needed to boot the app to prove startup still worked after the change — a genuinely necessary runtime check, since unit tests can't prove boot behaviour.
2. Found the default port occupied, so followed Step 3.7 and improvised a different one.
3. Copied the repo root `.env` into the worktree to get database config.
4. Booted — which ran the startup routine against **the developer's live local databases**, not an isolated set.
5. Cleaned up with a pattern kill (`pkill -f "<path-fragment>"`), which terminated the developer's own dev server — a process the agent never started.

No data was corrupted, but only because that particular change happened to be a no-op at runtime. A change that actually wrote would have hit the developer's working data.

The kicker: **the project had already solved this.** It ships tooling that allocates fully isolated stacks — per-slot ports, per-slot databases, per-slot cache index, own ingress entrypoint — documented in the project's own rules and a project-local skill. `spec-verify` is a general skill, so it had no way to know that existed, and no mechanism to ask.

This is not project-specific. Rails, Django, Next.js, Spring and any docker-compose stack have the same exposure, and most already have a namespacing mechanism — `COMPOSE_PROJECT_NAME` is precisely this concept.

## Proposal

Four tiers, each independently shippable and useful on its own.

### Tier 1 — Wording only (no code)

Replace the port-centric warnings in `spec-verify` with a shared-state decision point:

> **⚠️ A worktree isolates code, not runtime.** Ports, databases, caches and processes are shared with the developer's checkout and other worktrees. Before starting anything:
>
> 1. If the project declares an isolated-runtime command, use it.
> 2. Otherwise determine what this run **shares**. If it writes to a shared database, cache or queue, get explicit user confirmation before starting.
> 3. Record the PID you start. **Never terminate by name or pattern** (`pkill -f`, `killall`) — kill only PIDs you captured; a pattern will match the developer's processes.

Point 3 alone would have prevented the incident above.

### Tier 2 — The enabling primitive: worktree slots

Sentinal already allocates a worktree per plan. Give each one an **integer slot**, unique among *active* worktrees, released on cleanup:

- expose as `SENTINAL_WORKTREE_SLOT` in the worktree environment
- return `slot` from `worktree_create` / `worktree_detect` JSON
- the only guarantee needed: unique while active, reused only after release

Sentinal needs no knowledge of what a project does with the number. Projects that have already built parallel-stack tooling are necessarily reimplementing this exact primitive, as would every other adopter.

### Tier 3 — The contract: `.sentinal/runtime.json`

The `spec-plan` template's `## Runtime Environment` section **already has the right fields** — start command, port, health check, restart procedure. They're prose, so nothing can act on them. Making them machine-readable closes the loop:

```jsonc
{
  "slots": { "min": 1, "max": 5 },
  "isolation": ["ports", "database", "cache"],
  "bootstrap": "./scripts/stack bootstrap ${SENTINAL_WORKTREE_SLOT}",
  "up":        "./scripts/stack up ${SENTINAL_WORKTREE_SLOT}",
  "down":      "./scripts/stack down ${SENTINAL_WORKTREE_SLOT}",
  "health":    "http://localhost:${PORT}/health"
}
```

`spec-verify` Phase B then becomes generic: if the file exists, run `up` → `health` → tests → `down`. If it's absent, behaviour is unchanged, so this is fully backward compatible.

The `isolation` array is the load-bearing part — it lets the agent *reason*. A project declaring `["ports"]` but not `"database"` tells `spec-verify` to warn and require confirmation before any stateful run. That is precisely the signal that was missing.

This also fits the existing convention: `.sentinal/` already carries per-project `rules/`, `skills/` and JSON state. Sentinal has extension points for **knowledge**, but none for an **executable runtime contract**.

### Tier 4 — Safety net: process ownership + destructive-command guard

Sentinal already demonstrates it can intercept tool calls — the TDD guard blocked implementation edits twice in the session described above. The same machinery could:

- record PIDs/PGIDs started under a worktree in Sentinal state
- provide `runtime_stop` that kills only those PIDs
- have `worktree_cleanup` warn when a worktree still owns running processes
- guard broad destructive commands: `pkill -f`, `killall`, `git checkout .`, and `rm -rf` targeting paths outside the current worktree

Worth stating plainly: the TDD guard stopped me writing implementation code before a test. Nothing stopped me killing an unrelated process — a strictly larger blast radius.

## Suggested minimum

Tiers 1 and 2 are cheap, require no project-specific knowledge, and deliver most of the safety. Tier 3 is the natural follow-on that lets projects plug existing tooling in. Tier 4 is the safety net.

Happy to submit a PR for Tier 1 (and Tier 3's schema) if that would be useful — just say which shape you'd prefer.

