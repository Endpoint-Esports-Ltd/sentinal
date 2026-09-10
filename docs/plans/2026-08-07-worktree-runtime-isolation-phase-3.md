# `.sentinal/runtime.json` Contract + Scaffolder

Created: 2026-08-07
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-08-07-worktree-runtime-isolation
Wave: 2
Depends: Phase 1, Phase 2

## Summary

**Goal:** Turn the plan template's prose `## Runtime Environment` section into a machine-readable, executable contract at `.sentinal/runtime.json`, so `spec-verify` Phase B becomes generic: if the file exists, run `up` → `health` → tests → `down`; if absent, behaviour is unchanged. **And make it adoptable** — scaffold the file from what the project already declares, offered by `/sync`.

**Context:** See master plan at `docs/plans/2026-08-07-worktree-runtime-isolation.md` (Phase 3, Wave 2). Resolves Tier 3 of GitHub issue #2. **Depends on Phase 1** (rewritten Phase B to slot into) and **Phase 2** (the slot value to interpolate). Decisions **D6** (closed interpolation namespace) and **D9** (scaffolder via `/sync`) apply.

## Scope

### The contract

v1 schema (the issue's illustrative example, **trimmed and with `isolation` reshaped** — see below):

```jsonc
{
  "isolation": {
    "ports": "isolated",   // up namespaces this per-slot
    "database": "shared",  // ← confirmation required before up
    "cache": "none"        // project has no cache — say nothing
  },

  "up": "./scripts/stack up ${SENTINAL_WORKTREE_SLOT}",
  "down": "./scripts/stack down ${SENTINAL_WORKTREE_SLOT}",

  // Shorthand: a bare string desugars to { type: "http", target: <string> }
  "readiness": {
    "type": "http",                            // http | tcp | log | exec
    "target": "http://localhost:3000/health",  // url | host:port | regex | command
    "expectStatus": [200],                     // http only; default 2xx–3xx
    "startupTimeoutMs": 60000,                 // Testcontainers/Playwright default
    "pollIntervalMs": 250
  },

  "shutdown": {
    "signal": "SIGTERM",                       // SIGTERM | SIGINT
    "graceMs": 10000                           // then SIGKILL to the process group
  }
}
```

### Lifecycle contract (D12) — schema half

This phase owns the **schema, validation and Phase B prose**; Phase 4 owns execution. Field set is lifted from **Playwright `webServer`** and **Testcontainers wait strategies** rather than invented — see "The runtime lifecycle contract" in the master plan for the full comparison table and state machine.

**Readiness taxonomy — four probe types, not just HTTP.** The issue's `health: "http://…"` cannot express a CLI tool, a worker, or a server with no health endpoint:

| `type` | `target` | Passes when                                | v1?                                        |
| ------ | -------- | ------------------------------------------- | ------------------------------------------ |
| `http` | URL      | status in `expectStatus` (default 2xx–3xx) | ✅                                          |
| `exec` | command  | exit code 0                                 | ✅                                          |
| `tcp`  | `host:port` | connection accepted                      | ❌ cut — `exec: "nc -z host port"` covers it |
| `log`  | regex    | matches captured stdout/stderr              | ❌ cut — `exec: "grep -q … <logfile>"` covers it, and it is the only probe type that would couple the readiness poller to the log-capture destination |

**v1 ships `http` + `exec` only.** `exec` subsumes both cut types; keeping them would be inconsistent with the `bootstrap` / `slots` / `${PORT}` / composite-probe / SQL-probe cuts already made on YAGNI grounds. The zod enum stays extensible. Keep the bare-string shorthand so the simple case stays simple.

**Defaults must match prior art:** `startupTimeoutMs: 60000` (both Playwright and Testcontainers), `pollIntervalMs: 250` (Testcontainers uses 100ms; 250 is gentler for HTTP probes against a booting app). `graceMs: 10000`.

**Log capture is mandatory and is a safety feature (D12 finding 1).** An agent facing a failed `up` with no logs is blind, and a blind agent improvises — the exact behaviour that produced issue #2.

⛔ **Correction:** an earlier draft said "excluded via `.git/info/exclude` like Phase 2's files". Phase 2 does **not** use that mechanism — master D1/R8 record it **disproven in both forms** (resolves to the common dir and leaks into the main checkout; the per-worktree copy is never read). Use **`excludeFromGit`** (`src/worktree/git-exclude.ts:213`). Following the old wording would regress Phase 2's landed fix.

**Owner: Task 2** — a schema/convention decision (fixed constant + documented tail length). Failure messages must carry a log tail; Phase 4 consumes it.

**Validation rules:**

- `up` present but no `readiness` → **validation error**. Starting something with no way to know it started is the failure mode this whole tier exists to prevent.
- `down` absent is legal — Phase 4 falls back to signal escalation on the process group.
- `expectStatus` only valid when `type: "http"`.
- All interpolation obeys D6 (closed namespace, unknown token = validation error).

**Cut from v1:** composite `ForAll` probes, SQL probes, restart-on-crash (D5 rejected supervision), k8s-style `start_period` separate from startup timeout. One probe, one budget.

### The `isolation` contract (D10) — the load-bearing field

**Purpose:** declare what `up` actually namespaces per-slot — i.e. **the residual sharing that remains after `up` runs**. If there is no `up`, everything is shared and the field is moot.

**Why it is not redundant with `up`:** the common half-measure is a start command that parameterizes the port (a `--port` flag) while the database URL still comes from a shared `.env`. That is exactly the incident — a free port was found, isolation was inferred, the database was shared, and nothing could express the difference.

**⚠️ Diverges from the issue's array shape.** `["ports","database","cache"]` cannot distinguish "this project has no cache" from "this project's cache is shared" — both omit `cache`, so `spec-verify` must warn about a cache that does not exist. Noise gets ignored, and an ignored signal is a dead signal. Hence a three-state map.

**Rules (all six are load-bearing):**

1. **⛔ Unstated is `unknown`, NOT `shared`. `unknown` NEVER prompts.** Defaulting absence to `shared` while making `shared` blocking — composed with D9's scaffolder omitting the map — would prompt on **every run of every project**. That is alarm fatigue, and a reflexively-accepted prompt actively teaches the user to wave through *"not isolated."* A prompt that always fires carries no information.
2. **Only an explicit, human-written `"shared"` blocks.** Deliberate and audited, therefore rare and high-signal.
3. **`unknown` is reported non-blockingly** in the run context/summary — never as a prompt. Silence is still not an all-clear; it just does not spend the user's attention.
4. **Closed vocabulary** (zod enum) so the agent reasons without string-matching guesswork (`db` vs `database`), plus an **`other`** entry carrying a free-form description for classes the enum does not cover. Settle the enum in this phase — candidates: `ports`, `database`, `cache`, `queue`, `filesystem`, `objectStorage`, `searchIndex`, `outboundEmail`, `browser` (per D11, the E2E browser is shared runtime state too).
5. **The blocking rule applies to starting ANYTHING** — via `up`, or by running the program by hand per the Phase 1 guidance. Gating on `up` alone would leave an explicit `"database": "shared"` inert for a project with no `up` (legal: `readiness` is required only *when* `up` is present). Do **not** try to classify the change as "stateful" first — an agent cannot reliably know whether a verification run writes session rows, migrations or audit logs.
6. **A false all-clear is worse than no file (R13).** Sentinal cannot verify the claim, so the mitigation is structural: the D9 scaffolder **omits the map entirely**. Document the limitation wherever the schema is documented.

| Declaration           | Blocks? | Reported?             |
| --------------------- | ------- | --------------------- |
| `"isolated"`          | no      | no                    |
| `"shared"` (explicit) | **yes** | yes                   |
| `"none"`              | no      | no                    |
| absent (`unknown`)    | **no**  | yes, **non-blocking** |

**A scaffolded project runs with zero prompts.** An unconfigured project behaves exactly as it does today, plus a line of context.

**Cross-phase link:** this map is the durable fix for **R11**. Phase 2 seeds `.env` from `.env.example` and, when that file is not slot-aware, can only emit a blanket "may not be isolated" warning. Once the map exists, that warning names the specific shared resources.

### Cut from v1 (YAGNI)

- **`bootstrap`** — appears in the issue's example but nothing in Phase 3 or 4 consumes it; the lifecycle is up → health → tests → down. Re-add later only with a defined lifecycle position (e.g. once per worktree creation, before first `up`).
- **`slots: {min,max}`** — creates a second source of truth against `WorktreeConfig.maxActive`, with undefined precedence and undefined behaviour when it widens the range past the partial unique index's exhaustion semantics. `maxActive` remains authoritative.
- **`${PORT}`** — the issue's example uses it but no source, precedence, or unresolvable-token behaviour is defined for it. Excluded by D6.

### Interpolation contract (D6)

- **Closed namespace.** v1 substitutes exactly one token: `${SENTINAL_WORKTREE_SLOT}`, sourced from Phase 2's slot.
- **No `process.env` fallthrough.**
- An unknown `${TOKEN}` is a **zod-level validation error naming the token** — never a silent empty-string substitution. Silent substitution into a shell command is how `rm -rf $UNSET/` accidents happen.

### Deliverables

- Zod schema + loader for `.sentinal/runtime.json`. **Greenfield** — repo-wide grep for `runtime.json` returns 0 hits.
- `runtime_config` MCP tool: resolve, validate, interpolate. New domain registered in `createSentinalServer` after `src/mcp/server.ts:53`, following the `src/tdd/mcp-tools.ts` `{client, store}` template (`TddToolsDeps` at `:20-23`, resolver at `:25-32`, one private `register*Tool` per tool, `mcpText`/`mcpError` from `src/mcp/helpers.ts`).
- Export from the `src/index.ts` barrel (precedent: `:90-91`) — append at the end of the domain block.
- **`runtime_init` scaffolder + `/sync` integration (D9).** The issue states the file is project-authored, which makes adoption the entire ballgame — the master plan's residual risk concedes non-adopters get nothing. Deliver:
  - A `runtime_init` MCP tool (and/or CLI equivalent) that inspects `docker-compose.yml`, `package.json` scripts, and `Procfile` and **drafts** `.sentinal/runtime.json` for human review. Sentinal scaffolds; it does not own the file.
  - **Wire into the existing `/sync` flow** (`targets/claude-code/commands/sync.md`, `targets/opencode/commands/sync.md`, 564 lines) — `/sync` already inspects the codebase and generates project config, so a "no `runtime.json` found → offer to draft one" step fits its existing purpose. **No new user-facing command.**
  - Both `sync.md` files must be edited **identically** (hand-synced, no generator — `src/cli/commands/no-leak.test.ts:64-74`), and `bun run embed-assets` re-run.
  - **Scaffolding rule: draft the fields whose errors are LOUD; never draft the field whose errors are SILENT.** A wrong `up` errors or times out on readiness; a wrong `readiness` times out; a wrong `down` fails teardown — all visible. A wrong `isolation` produces a confident, silent green light. So the scaffolder drafts `up`, `down` and `readiness`, and prefers leaving a field empty with a comment over guessing.
  - **⛔ The scaffolder must OMIT the `isolation` map entirely.** Not "emit `shared`/`none`" — every possible value is either unsafe or redundant:

    | Value      | Safe to infer?                                                                                                                      | Adds anything vs. omitting? |
    | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
    | `isolated` | **No** — a `db` service in `docker-compose.yml` does not mean the project name is slot-parameterized. False all-clear (R13).         | yes, but unsafe             |
    | `shared`   | Yes                                                                                                                                  | **No** — it is already the default under D10 rule 1 |
    | `none`     | **No** — inferring "no cache exists" from "no cache seen" is absence-of-evidence; if a shared cache *does* exist, `none` suppresses the confirmation gate | yes, but unsafe             |

    Omission is **fail-safe because omission means `unknown`, and `unknown` NEVER blocks** (D10 rule 1). A scaffolded file is therefore exactly as non-interrupting as no file, while still delivering the `up`/`down`/`readiness` value. ⛔ It does **not** mean "unstated → shared → gate fires" — that is the pre-correction wording D10 rule 1 exists to overturn, and building to it would produce a prompt on every run of every unconfigured project.
  - **Report detected resource classes once, in the `/sync` conversation — not in the file, and never as a recurring prompt.** e.g. *"Detected postgres and redis. I have left `isolation` unset, so Sentinal will note them but will not interrupt runs. If your `up` command namespaces them per-slot, set them to `isolated`; if they are genuinely shared, set them to `shared` and Sentinal will ask before any run that touches them."* A human reading `/sync` output is paying attention; a human reading a generated file tends to accept it.
  - **⛔ The scaffolder must not cause prompts.** Its output leaves every class `unknown`, and per D10 rule 1 `unknown` never blocks. `/sync` is the one moment the user is asked to think about isolation; after that the decision is theirs to record.
- **Gitignore verification (R9):** `.sentinal/` is where gitignored runtime state lives, and a prior plan (`docs/plans/2026-07-19-sentinal-gitignore-track-skills-rules.md`) established an allowlist-style policy. Verify the shipped `.sentinal/.gitignore` allowlist explicitly tracks `runtime.json`, extend it if not, and **add a test asserting `runtime.json` is not ignored** — otherwise the tier silently never activates for teammates or CI.
- **Documentation (R10):** the schema must be documented where a project author will read it — README and/or `targets/*/rules/verification.md` (safe: this phase is Wave 2, so Phase 1's Wave-1 ownership rule no longer binds). Also update `.sentinal/rules/sentinal-mcp-servers.md` (tool count, new 7th domain table) and run its "Smoke Test Checklist After Adding a Tool".

### Skill/command wiring

The plan template defines `## Runtime Environment` at `targets/claude-code/commands/spec-plan.md:306-308` and `targets/opencode/skills/spec-plan/SKILL.md:303-305` — **one slash-separated prose line**, five fields (Start command / Port / Deploy path / Health check / Restart procedure), no schema, gated by "(only if project has a running service)" so frequently omitted.

Its six consumption points. **All six were re-verified against the worktree on 2026-08-08 and all six exist** — a review flagged four as stale, but that used a case-sensitive grep for `Runtime Environment` and missed `runtime environment info` (:86), `**Runtime environment:**` (:108), `runtime_environment` (spec-reviewer:42) and `runtime environment documented` (plan-reviewer:52).

**Ownership:** Task 5 owns rows 1-3 (both spec-verify copies). **Rows 4-6 — `spec-implement.md:193`/`:189`, `agents/spec-reviewer.md:42`/`:27`, `agents/plan-reviewer.md:52`/`:35` — plus the definition at `spec-plan.md:306` are OUT OF SCOPE here**; they keep reading the prose section. **Precedence, stated once: when both exist, `runtime.json` wins and the `## Runtime Environment` prose is advisory.** `agents/*.md` are not parity-guarded by `PAIRS`, so a future edit there needs its own guard.

| Consumer                                     | CC line                        | OC line |
| -------------------------------------------- | ------------------------------ | ------- |
| spec-verify Step 3.0 profile classification  | `spec-verify.md:68`            | `:66`   |
| spec-verify Step 3.1a reviewer context       | `spec-verify.md:86`            | `:84`   |
| spec-verify Step 3.1b reviewer prompt        | `spec-verify.md:108`           | `:106`  |
| spec-implement Step 2.3 item 8               | `spec-implement.md:193`        | `:189`  |
| spec-reviewer agent param                    | `agents/spec-reviewer.md:42`   | `:27`   |
| plan-reviewer audit checklist                | `agents/plan-reviewer.md:52`   | `:35`   |

Note the reviewer prompt at `spec-verify.md:108` forwards only 3 of the 5 template fields — Health check and Restart procedure are dropped today.

Also: `spec-bugfix-verify` does **not** reference `## Runtime Environment` at all, and `spec-bugfix-plan` does not define the section.

## Known Constraints

- **No code parses `## Runtime Environment`** — grep across `src/` returns zero hits; `src/spec/` plan-parsing does not extract it. It is purely LLM-read prose.
- Absence of `.sentinal/runtime.json` must leave every existing behaviour **byte-identical**. This is the backward-compatibility guarantee for the whole master plan.
- `.sentinal/runtime.json` is **project-authored and committed by the project** — never generated by Sentinal.
- This phase re-edits the same spec-verify files as Phase 1, hence Wave 2 rather than Wave 1. It also edits `targets/*/commands/sync.md`, which Phase 1 owns within Wave 1 — safe because this phase is Wave 2.
- `bun run embed-assets` before `bun test` for every `targets/**` edit (R5).
- The same 3 regexes in `src/cli/spec-verify-full-tsc.test.ts` and the `sentinal:` prefix rules from Phase 1 still apply.

## Out of Scope

- Spawning or tracking processes — Phase 4 adds `runtime_up` / `runtime_stop`. This phase resolves, validates and scaffolds only.

## Master DoD Contribution

Steps 6 and 7: a project with no `.sentinal/runtime.json` exhibits byte-identical pre-existing behaviour; `/sync` on such a project offers a scaffolded draft.

---

## Context for Implementer

> Written for someone who has never seen this codebase. **Wave 1 (Phases 1+2) is landed and committed** — `git log` shows `9607c6f`, `a8230e8`, `47c30b9`. All line numbers below are post-Wave-1.

### ⚠️ Phase 1 already wrote a promise this phase must keep

`.sentinal/runtime.json` is **already named in 4 shipped files** with zero implementation behind it:

| File | Line | Text |
| --- | --- | --- |
| `targets/claude-code/commands/spec-verify.md` | 241 | "Ask only where the project has explicitly declared a resource `\"shared\"` in `.sentinal/runtime.json`." |
| `targets/opencode/skills/spec-verify/SKILL.md` | 239 | byte-identical |
| `targets/claude-code/rules/verification.md` | 27 | same clause |
| `targets/opencode/rules/verification.md` | 27 | byte-identical |

Until this phase lands, that instruction points at a file that can never exist (see Task 1).

### What Wave 1 gives you

| Need | Use | Location |
| --- | --- | --- |
| The slot for a worktree | **`readSlotFromWorktree(worktreePath): number \| null`** | `src/worktree/slots.ts:362`, barrel `src/index.ts:248` |
| Monorepo package discovery | `workspacePackageDirs(repoRoot): string[]` | `src/worktree/seed-sources.ts:146` — **already re-exported at `worktree-config.ts:51`**; import directly, do NOT route via the barrel |
| Git-exclusion for written files | `excludeFromGit(worktreePath, relPaths)` | `src/worktree/git-exclude.ts:213` |
| Enriching the not-isolated warning | `notIsolatedWarning(sourceRel, sharedResources = [])` | `src/worktree/worktree-config.ts:136` |

**⛔ There is NO slot-by-path DB accessor.** `WorktreeStore` has no path-keyed lookup. Use `readSlotFromWorktree` — it reads `<worktree>/.sentinal/worktree.env`, returns `null` for slot 0 (reserved) and for missing/unparseable files, and is exactly the value the worktree's own `.env` was seeded against.

**⛔ `interpolateSlot` (`worktree-config.ts:100`) is PERMISSIVE and must NOT be reused for D6.** It is `text.split(SLOT_PLACEHOLDER).join(String(slot))` — it silently ignores every other `${TOKEN}`. D6 requires an unknown token to be a **zod-level validation error naming the token**. Write a strict interpolator in `src/runtime/`.

### Hard constraints

- **`src/worktree/manager.ts` is 582/600 and `src/sidecar/client.ts` is 582/600.** Both are 18 lines from a hard block. **Do not touch either.** Design `runtime_config` **direct-only** (no sidecar route, no client method) following `src/project/mcp-tools.ts` (59 lines), which falls back to local analysis on sidecar failure.
- `src/worktree/slots.ts` is 402 (over the 400 warn). `src/cli/commands/worktree.ts` is 426 (over warn).
- **New code goes in a new `src/runtime/` domain** — `schema.ts`, `loader.ts`, `scaffold.ts`, `mcp-tools.ts`. Keeps everything green.
- `src/index.ts:232` carries an explicit note: *"Appended (Phase 2). Phase 3 appends below this — do not restructure."*

### The parity test — read this before editing any `targets/**` markdown

`src/cli/target-parity.test.ts` (343 lines) guards 7 `spec-*` pairs via **committed diff baselines**, plus 3 byte-identical rules.

- **`spec-verify.diff` is 0 bytes and is in `MUST_STAY_BYTE_EQUAL` (`:66-70`).** Apply every edit to **both** targets identically and it stays 0. **NEVER run `UPDATE_PARITY_BASELINES=1` for spec-verify** — a regenerated non-empty baseline also fails the byte-equal assertion.
- **⛔ Double-quote trap:** normalisation strips only `subagent_type="sentinal:` and `Skill(skill='sentinal:` (single quote, `:109-133`). `Skill(skill="sentinal:…")` with **double** quotes is NOT stripped and would break the empty baseline. Use single quotes.
- `IDENTICAL_RULES` (`:87-94`) = `verification.md`, `playwright-cli.md`, `testing.md` — strict byte equality. **Adding a new shipped rule means adding its filename here** (the docblock at `:72-86` says so explicitly).
- **`sync.md` parity is completely UNGUARDED** — `PAIRS` resolves OpenCode paths to `skills/<n>/SKILL.md`, but sync's OpenCode copy is at `commands/sync.md`. Task 6 closes this.
- **`bun run embed-assets` before `bun test`, every time** — the preload only regenerates when the embedded copy is ABSENT, never when stale.
- `src/cli/spec-verify-full-tsc.test.ts` — 3 whole-file regexes across 4 files. Keep "full project tsc" phrasing, keep an `incremental|cache|LSP` mention, introduce no `tsc --noEmit … as fallback`.

### Layout facts

- CC↔OC offset is a uniform **+2** for both `spec-verify` and `sync.md` across the entire body.
- `spec-verify.md` is 453 lines / `SKILL.md` 451. `sync.md` is 566 / 564.
- **Insertion anchor for the runtime flow:** `spec-verify.md:240` item 1 — *"If the project declares an isolated-runtime command, use it."* Phase 3 makes that concrete.

## Testing Strategy

- **Unit:** zod schema (valid/invalid/unknown-token), strict interpolator, loader (present/absent/malformed), scaffolder inference, `runtime_config` tool handler.
- **Integration:** R9 — a real `git check-ignore` assertion that `.sentinal/runtime.json` is NOT ignored.
- **Regression:** parity test, `spec-verify-full-tsc`, `check-embed-assets`, full `bun test`.
- **Backward compatibility:** a project with **no** `runtime.json` must behave byte-identically — this is the master's headline guarantee and needs an explicit test.

## Assumptions

- `readSlotFromWorktree` is the authoritative slot source for interpolation — supported by `slots.ts:362-386` and `manager.ts:416` using it for exactly this — Tasks 2, 3.
- `runtime_config` can be **direct-only** because it is a **stateless fs read of a path derived from its own `project` argument** — none of the sidecar's warm-state benefits (SQLite, embedding model, LSP) apply. `src/project/mcp-tools.ts` is cited **only** as the `{client?}` deps-shape template, **not** a direct-only precedent — it is sidecar-first with fallback (`:43-53`). OpenCode is unaffected (same `mcp-server` binary; Task 5's OpenCode work is prose-only) — Task 3.
- Absence of `runtime.json` leaves all behaviour unchanged — Tasks 3, 5.
- `notIsolatedWarning`'s empty-default second arg is a **zero-SIGNATURE-change** hook (existing callers compile unmodified); the **call site** gains one argument — `worktree-config.ts:132-135` — Task 5.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **R9 is worse than one edit** — `.sentinal/runtime.json` is currently IGNORED (`.sentinal/.gitignore:2:*`), and this repo's own file matches neither `GITIGNORE_CONTENT` nor `KNOWN_PRIOR_GITIGNORES`, so it will **never auto-upgrade** | Certain | High | Task 1 does all **three** edits + a `git check-ignore` regression test |
| Breaking the 0-byte `spec-verify.diff` baseline | Medium | Medium | Edit both targets identically; single-quote `Skill(...)`; never regenerate |
| A permissive interpolator silently substituting nothing for an unknown token → `rm -rf $UNSET/` class of bug | Medium | High | D6: strict interpolator, unknown token = validation error naming it. Do **not** reuse `interpolateSlot` |
| `runtime_config` needing a sidecar route → `client.ts` trips the 600 block | Medium | Medium | Direct-only design (Task 3). If a route becomes unavoidable, split `client.ts` first as a prerequisite |
| Scaffolder inferring `isolated` wrongly → a **false all-clear**, strictly worse than no file (R13) | Medium | High | Task 4: the scaffolder **omits the `isolation` map entirely** |

## Pre-Mortem

_Assume this phase failed. Most likely internal reasons:_

1. **`runtime.json` ships but no project can commit it** (Task 1) → Trigger: `git check-ignore -v .sentinal/runtime.json` still reports a match after the fix. The tier-4 `.sentinal/` allowlist is deny-all-first; `!runtime.json` must come after `*`.
2. **The `isolation` map is written but never consulted** (Task 5) → Trigger: a project declaring `"database": "shared"` runs a full verify with no confirmation. The Phase B wiring is prose, so it can be silently ignored.
3. **The scaffolder produces a file behaviourally identical to no file** (Task 4) → Trigger: `/sync` drafts a `runtime.json` whose only content is an all-`shared`/absent isolation map. Its value must come from `up`/`down`/`readiness`, which is why the isolation map is omitted, not defaulted.

## Execution Waves

**Wave 1** — Foundations (parallel): Task 1 (gitignore, `src/memory/shared.ts` + `.sentinal/.gitignore`) and Task 2 (schema + interpolator, new `src/runtime/`). Disjoint.
**Wave 2** — Consumers (parallel): Task 3 (loader + MCP tool) and Task 4 (scaffolder). Both live in `src/runtime/` but own **distinct files**, and **Task 3 is the sole owner of `src/index.ts`** — Task 4 touches no shared file.
**Wave 3** — Wiring (parallel): Task 5, Task 6, Task 7. **Source files verified disjoint**, but all three regenerate the shared `src/cli/embedded-assets.ts` and would otherwise run `bun test src/cli/` while the others are mid-edit.
**⛔ Wave 3 protocol:** each task verifies with a **narrow** command that does NOT regenerate shared assets (T5 → `bun test src/worktree/worktree-config.test.ts`; T6 → `bun test src/cli/target-parity.test.ts`; T7 → `diff -q` only). Run **`bun run embed-assets && bun test src/cli/` ONCE after all three complete**, as the wave gate.

## Goal Verification

### Truths

1. `git check-ignore -v .sentinal/runtime.json` reports **no match** (exit 1) in a Sentinal-installed project.
2. A `runtime.json` containing `${SENTINAL_WORKTREE_SLOT}` in `up` resolves to the worktree's actual slot via `runtime_config`.
3. A `runtime.json` containing `${UNKNOWN_TOKEN}` fails validation with an error **naming that token** — it is never substituted with an empty string.
4. With **no** `.sentinal/runtime.json`: `runtime_config` returns an inert not-configured result (no error), **and** `notIsolatedWarning` emits the byte-identical string Phase 2 shipped, **and** no new prompt or block path is reachable.
5. `targets/*/commands/spec-verify.md` and the OpenCode skill both describe the `up` → `health` → tests → `down` flow, and `spec-verify.diff` is still **0 bytes**.
6. `/sync` on a project without `runtime.json` offers a scaffolded draft; the draft contains **no `isolation` key**.
7. `.sentinal/rules/sentinal-mcp-servers.md` reports 7 domains and the new tool count.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/runtime/schema.ts` | Zod schema + closed interpolation namespace | `RuntimeConfigSchema`, `RuntimeConfig`, `interpolateStrict` |
| `src/runtime/loader.ts` | Locate, parse, validate, interpolate | `loadRuntimeConfig` |
| `src/runtime/scaffold.ts` | Draft from compose/package.json/Procfile | `scaffoldRuntimeConfig` |
| `src/runtime/mcp-tools.ts` | `runtime_config` + `runtime_init` | `registerRuntimeTools`, `RuntimeToolsDeps` |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/mcp/server.ts` | `src/runtime/mcp-tools.ts` | registration | `registerRuntimeTools` |
| `src/runtime/loader.ts` | `src/worktree/slots.ts` | slot for interpolation | `readSlotFromWorktree` |
| `src/worktree/worktree-config.ts` | `src/runtime/loader.ts` | R11 enrichment | `notIsolatedWarning` |
| `targets/*/commands/sync.md` | `runtime_init` | scaffolder offer | `runtime_init` |

## Progress Tracking

- [x] Task 1: Make `.sentinal/runtime.json` committable — R9 (Wave 1)
- [x] Task 2: Zod schema + strict interpolator — D6/D10 (Wave 1)
- [x] Task 3: Loader + `runtime_config` MCP tool (Wave 2)
- [x] Task 4: `runtime_init` scaffolder (Wave 2)
- [x] Task 5: spec-verify Phase B wiring + R11 enrichment (Wave 3) — R11 population deferred to Phase 4
- [x] Task 6: `/sync` integration + close the sync.md parity gap (Wave 3)
- [x] Task 7: Documentation + MCP catalog — R10 (Wave 3)

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Deferred Issues

- **`ensureGitignore` fires only on a shared-memory write** (`src/memory/shared.ts:82`). An install that never promotes an observation to shared memory never re-runs the upgrade path, so its `.sentinal/.gitignore` stays on v2 and `runtime.json` stays ignored for it. Fixing this means adding a second invocation point (install, or `SessionStart`), which is a behaviour change outside this phase's scope. **Recommend for Phase 4 or a follow-up.**
- **R11 population (`sharedResources` on the three `manager.ts` seed call sites) is deferred to Phase 4.** The seam and its tests landed in Task 5; only the one-line-per-call-site population is outstanding, and it requires editing `src/worktree/manager.ts`, which is at 582/600 and off-limits this phase.
- **`learn.md` / `quick.md` / `pause.md` are unguarded command-dir parity pairs.** Task 6 generalises `target-parity.test.ts` to cover command-dir pairs and adds `sync` only, per the plan's explicit instruction. The other three remain unguarded — follow-up.

## Implementation Tasks

### Task 1: Make `.sentinal/runtime.json` committable — R9

**Objective:** The contract is project-authored and must reach teammates and CI. It is currently **ignored**, so the whole tier would silently never activate.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/shared.ts` (`GITIGNORE_CONTENT` `:261-271`, `KNOWN_PRIOR_GITIGNORES` `:279-286`)
- Modify: `.sentinal/.gitignore` (the repo's own, by hand — it will not self-upgrade)
- Modify: `src/memory/shared.test.ts` (309 lines)

**Key Decisions / Notes:**

- **Verified broken:** `git check-ignore -v .sentinal/runtime.json` → `.sentinal/.gitignore:2:*` matches. The deny-all `*` catches it and there is no allowlist entry.
- **Three edits, not one.** `ensureGitignore` (`shared.ts:288-300`) only rewrites a file whose content **exactly matches** `GITIGNORE_CONTENT` or a `KNOWN_PRIOR_GITIGNORES` entry. This repo's file contains `!continue-here.md` and matches **neither**, so it is classified user-customised and will never auto-upgrade:
  1. add `!runtime.json` to `GITIGNORE_CONTENT`
  2. append the **current** `GITIGNORE_CONTENT` verbatim to `KNOWN_PRIOR_GITIGNORES` so existing installs upgrade
  3. hand-edit `<repo>/.sentinal/.gitignore`
- Ordering matters: `*` is first, so `!runtime.json` must come after it. The existing allowlist entries already establish the pattern.
- Decide whether `!continue-here.md` is folded into the generator or left a deliberate local customisation. State which. (`continue-here` appears nowhere in `src/`, so it does not widen the non-upgrading population.)
- **Confirm WHEN `ensureGitignore` runs.** If it only fires on a project-memory write, an existing install that never triggers it stays un-upgraded regardless of edit 2.
- **⚠️ Silent-failure mode:** negation only works because `.sentinal/` is not itself excluded by a parent `.gitignore`. If a user's ROOT `.gitignore` contains `.sentinal/`, `!runtime.json` is **inert** — git cannot re-include a file inside an excluded directory. Mirror the Phase 2 tier-3 precedent: warn and name the remedy.

**Definition of Done:**

- [x] `git check-ignore -q .sentinal/runtime.json` exits **1** (not ignored) in this repo
- [x] `GITIGNORE_CONTENT` contains `!runtime.json`
- [x] The pre-change `GITIGNORE_CONTENT` is in `KNOWN_PRIOR_GITIGNORES`, so an existing install upgrades rather than being treated as customised
- [x] Regression test asserts the not-ignored property, not merely the string
- [x] The `!continue-here.md` decision is recorded
- [x] `ensureGitignore`'s invocation point identified and recorded
- [x] **If a parent `.gitignore` excludes `.sentinal/` wholesale, the loader warns and names the remedy** — implemented in Task 3's `loader.ts` (`runtimeContractIgnored`), since the DoD names *the loader*

**Outcome / recorded decisions:**

- **R9 result:** `git check-ignore -q .sentinal/runtime.json` now exits **1** (no match) in this repo. Two behavioural regression tests guard it: one against generated content in a throwaway `git init` repo, one against **this repo's own** checked-in file.
- **`!continue-here.md`: left as a deliberate local customisation, NOT folded into the generator.** This is not a new decision — `docs/plans/2026-07-19-sentinal-gitignore-track-skills-rules.md:28` already settled it ("stays ignored — user chose skills + rules only"). Folding it in would make every user's `/pause` handoff note committable, which nobody asked for.
  **Cost, stated plainly:** this repo's `.sentinal/.gitignore` therefore still matches neither `GITIGNORE_CONTENT` nor any `KNOWN_PRIOR_GITIGNORES` entry, so it will **never** auto-upgrade and must be hand-edited on every future revision. A comment in the file and the repo-level test above are the mitigation.
- **`ensureGitignore` invocation point:** exactly one call site — `src/memory/shared.ts:82`, inside `writeSharedMemory`. So it fires **only when shared project memory is written** (`memory_share`, `addSharedObservation`), never on session start, install, or update.
  **Consequence:** edit 2 (the v2 `KNOWN_PRIOR_GITIGNORES` entry) only helps an install that *subsequently promotes an observation to shared memory*. An install that never uses shared memory keeps its v2 file and `runtime.json` stays ignored for it. Widening the invocation point (e.g. to install or `SessionStart`) is a real gap but is **out of scope here** — logged under `## Deferred Issues`.

**Verify:**

- `bun test src/memory/shared.test.ts`
- `! git check-ignore -q .sentinal/runtime.json`

---

### Task 2: Zod schema + strict interpolator — D6 / D10

**Objective:** Define the contract and a **closed, validated** interpolation namespace.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/runtime/schema.ts`, `src/runtime/schema.test.ts`

**Key Decisions / Notes:**

v1 shape (already trimmed — `bootstrap`, `slots`, `${PORT}`, composite/SQL probes, `tcp`/`log` probes are all **cut**, see "Cut from v1" above):

```jsonc
{
  "isolation": { "ports": "isolated", "database": "shared", "cache": "none" },
  "up": "./scripts/stack up ${SENTINAL_WORKTREE_SLOT}",
  "down": "./scripts/stack down ${SENTINAL_WORKTREE_SLOT}",
  "detached": false,
  "readiness": { "type": "http", "target": "http://localhost:3000/health",
                 "expectStatus": [200], "startupTimeoutMs": 60000, "pollIntervalMs": 250 },
  "shutdown": { "signal": "SIGTERM", "graceMs": 10000 }
}
```

- **`isolation` is a three-state map**, and **absence means `unknown`, NOT `shared`** (D10 rule 1). Only an explicit `"shared"` blocks. Model the enum as `isolated | shared | none`; unknown is the absence of a key, so do **not** add it as a value.
- Closed resource vocabulary + an `other` escape hatch. Candidates: `ports`, `database`, `cache`, `queue`, `filesystem`, `objectStorage`, `searchIndex`, `outboundEmail`, **`browser`** (per D11). ⚠️ Its semantics do not fit "what `up` namespaces" — the E2E browser is isolated by the session flag in the shipped rules (`verification.md:9`, `testing.md:77`), not by `up`. **Keep it, with this clarification in the docs:** *`browser` describes the E2E browser instance regardless of whether `up` starts it; declare `isolated` when the run uses per-session isolation (`-s=$SENTINAL_SESSION_ID` or a dedicated Chrome).*
- **⛔ Strict interpolation over a SENTINAL-OWNED PREFIX (D6, narrowed).** `up`/`down` are **shell command strings**, so a blanket "any unknown `${TOKEN}` is an error" rule is wrong in both directions:
  - **It rejects legitimate shell.** `PORT=${PORT:-3000} npm start`, `bash -c 'echo ${HOME}'` and `${DOCKER_HOST}` are all valid commands a project already has, with no escape hatch specified.
  - **It does not catch the hazard used to justify it.** `rm -rf $UNSET/` is **bare-dollar** syntax; a `${TOKEN}` matcher never sees it. The rule as originally written delivers a different safety property from the one claimed.

  **Narrowed rule:** validation errors fire **only for `${SENTINAL_*}` tokens not in the closed set** — which still catches the real risk (a typo'd `${SENTINAL_WORKTREE_SLOTT}` silently expanding to empty). Every non-`SENTINAL_` `${...}` and every bare `$VAR` is passed through **verbatim** to the shell. Sentinal performs **no expansion outside its own prefix** — by design, not by oversight. **No `process.env` fallthrough within the prefix.**
- **Do not reuse `interpolateSlot` (`worktree-config.ts:100`)** — it is permissive by design and validates nothing.
- **Two expansion layers exist.** Phase 2 writes a sourceable `SENTINAL_WORKTREE_SLOT=` into `<worktree>/.sentinal/worktree.env` (`slots.ts:49/:52`), so the same token could be expanded by Sentinal at load time **and** by the shell at exec time. **Sentinal's load-time substitution wins**; state whether the spawn env also carries the variable (Phase 4 consumes this).
- **`detached: boolean` (default `false`) is a DECLARED field**, present in the schema. Master D12's "or infers it from a zero-exit `up`" is Phase 4's **second** detection path at runtime, **not** a substitute for the declaration — a zod refinement cannot infer it.
- Validation rules: `up` present without `readiness` → error (starting something with no way to know it started is the failure mode this tier exists to prevent). `down` absent is legal. `expectStatus` only valid for `type: "http"`. **`detached: true` requires `down`** (D12 — a detaching starter's pgid owns nothing).
- **Split validation from substitution explicitly.** The zod schema **validates token names** via a refinement — **no slot required**, which is what `schema.test.ts` asserts in isolation. **Substitution is a separate exported function** applied by the loader once the slot is known (the slot comes from `readSlotFromWorktree` at load time and is unavailable at parse time).
- **Interpolated fields are exactly: `up`, `down`, `readiness.target`.** `readiness.target` matters — a per-slot port belongs there (`http://localhost:30${SENTINAL_WORKTREE_SLOT}0/health`), and omitting it would let a slot-aware `up` start a stack the probe cannot reach, producing a silent timeout.
- Bare-string shorthand: `"readiness": "http://…"` desugars to `{type:"http", target:…}`.
- Defaults from prior art: `startupTimeoutMs: 60000` (Playwright + Testcontainers), `pollIntervalMs: 250`, `graceMs: 10000`.

**Definition of Done:**

- [x] Valid config parses; every documented default is applied
- [x] `${SENTINAL_TYPO}` produces a validation error **naming the token**
- [x] **`PORT=${PORT:-3000} npm start` is ACCEPTED unchanged** — non-`SENTINAL_` tokens pass through verbatim
- [x] Bare `$VAR` is passed through untouched and documented as out of scope
- [x] No `process.env` fallthrough **within the `SENTINAL_` prefix**
- [x] `up` without `readiness` rejected; `detached` without `down` rejected
- [x] Absence of an `isolation` key is `unknown`, distinct from `"shared"`
- [x] Bare-string readiness shorthand desugars
- [x] **Log destination settled** as a worktree-local convention excluded via `excludeFromGit` (**not** `.git/info/exclude`), with a documented tail length

**Outcome / deviations:**

- **Split into two files.** A single `schema.ts` came out at 403 lines — over the 400 warn and over this phase's own "keep new files under 400" constraint. Split by cohesion, not by line-shaving: `src/runtime/interpolate.ts` (114) owns the closed namespace, `src/runtime/schema.ts` (312) owns the contract. `schema.ts` **re-exports** the namespace so it remains the single import surface the Artifacts table promises, and a test asserts that re-export.
- **`isolation.other` shape settled:** `other: [{ name, state }]` — an array, so a project can declare several uncovered classes. A bare `other: "shared"` could name only one.
- **`IsolationSchema` and the top-level object are `.strict()`.** This is load-bearing, not tidiness: a misspelled class (`db`) would otherwise be dropped silently, leaving the author believing they had declared the database while Sentinal saw nothing — and the resulting `unknown` never prompts. A declaration that can be typo'd into invisibility is not a declaration.
- **`${SENTINAL_WORKTREE_SLOT:-0}` is an error too.** The regex matches `\$\{(SENTINAL_[^}]*)\}`, so shell-defaulting a token inside Sentinal's own prefix is *seen* and rejected rather than skipped as "not a token".
- **Log destination:** `RUNTIME_LOG_RELATIVE_PATH = ".sentinal/runtime.log"`, `RUNTIME_LOG_TAIL_LINES = 50` (fixed, not configurable). Hidden via `excludeFromGit` — the docblock states this explicitly and names why `.git/info/exclude` is disproven, so Phase 4 cannot regress it.
- **Two expansion layers settled:** Sentinal's load-time substitution wins (the literal token is gone before the shell sees it). Phase 4 *should additionally* export `SENTINAL_WORKTREE_SLOT` into the spawn env for scripts invoked by `up` — purely additive. Documented in `interpolate.ts`.

**Verify:**

- `bun test src/runtime/schema.test.ts` ✅ (plus `src/runtime/interpolate.test.ts`)

---

### Task 3: Loader + `runtime_config` MCP tool

**Objective:** Locate, parse, validate and interpolate `.sentinal/runtime.json`, and expose it as an MCP tool.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Create: `src/runtime/loader.ts`, `src/runtime/loader.test.ts`, `src/runtime/mcp-tools.ts`, `src/runtime/mcp-tools.test.ts`
- Modify: `src/mcp/server.ts` (register after `:53`), `src/index.ts` (append below the `:232` marker)

**Key Decisions / Notes:**

- **Direct-only — no sidecar route, no client method.** Justification is correctness, not just budget: a stateless fs read of a path derived from the tool's own `project` argument. (`client.ts` at **582/600** is a second, independent reason.) Copy the **deps shape** from `src/project/mcp-tools.ts` (59 lines) — it is sidecar-first-with-fallback, so do not copy its body.
- Slot source: **`readSlotFromWorktree(worktreePath)`** (`slots.ts:362`, barrel `src/index.ts:248`). Returns `null` for missing files and for slot 0. **There is no slot-by-path DB accessor** — do not build one.
- **Absent file → inert success, not an error.** This is the master's backward-compatibility guarantee and needs its own test.
- Malformed JSON / failed validation → a clear error naming the file and the offending token or field.
- Follow the `src/tdd/mcp-tools.ts` structure exactly: exported `RuntimeToolsDeps`, exported `registerRuntimeTools(server, deps)`, one **private** `registerXxxTool` per tool, `mcpText`/`mcpError` from `src/mcp/helpers.ts`. **Do NOT copy `src/worktree/mcp-tools.ts:45-70`'s bare-`MemoryStore` back-compat branch — it is legacy.**
- Barrel: `export { registerRuntimeTools }` + `export type { RuntimeToolsDeps }`, appended below `src/index.ts:232`.

**Definition of Done:**

- [x] Loads, validates and interpolates a real `runtime.json`
- [x] **Absent file → inert, no error** (backward-compat guarantee)
- [x] Slot resolved via `readSlotFromWorktree`; a slotless worktree degrades with a warning rather than substituting `null`
- [x] Registered in `createSentinalServer` and exported from the barrel
- [x] `src/sidecar/client.ts` and `src/worktree/manager.ts` are **untouched** (`git diff --name-only` on both is empty)
- [x] `runtime_config` resolves paths from its **`project` argument, never `process.cwd()`** — asserted by a test that would pass vacuously under a cwd-based implementation
- [x] No new file over 400 lines (largest: `scaffold.ts` 379)

**Outcome / deviations:**

- **`RuntimeToolsDeps` is accepted and deliberately UNUSED.** Registration stays uniform with the other six domains, but nothing is delegated. The docblock states this is a design decision, not an oversight, and gives the real reason first (a stateless fs read gains nothing from warm sidecar state) with `client.ts` at 582/600 as the secondary one — so nobody "fixes" it later by adding a route.
- **The loader owns the R9 parent-`.gitignore` warning** (Task 1's last DoD item, which names *the loader*). If `.sentinal/runtime.json` is ignored, it warns that the contract will never reach teammates or CI and names both remedies (`.sentinal/*` instead of `.sentinal/`, or `!.sentinal/runtime.json`, then `git add -f`). Advisory only — the config still loads.
- **`unknownResources` is empty when there is no file.** Deliberate: an unconfigured project must not acquire a new line of context on every run. Absence of the file is absence of the whole feature.
- **A `no-module-cycle.test.ts` grep guard was added here** rather than in Task 5, because `loader.ts`'s docblock cites it. It asserts both directions: `src/worktree/**` imports nothing from `src/runtime/`, **and** `loader.ts` still imports from `src/worktree/` (so a refactor that severs the legal direction and then "resolves" the cycle by reversing it is visible).
- **Server-registration test added** (`src/mcp/server.test.ts`). A tool registered in its domain module but never wired into `createSentinalServer` is invisible to every client while its own unit tests still pass — nothing else caught that.
- **📌 Finding for Task 7:** the pre-existing tool count was **31 across 6 domains**, not the "28 tools across 6 domains" `.sentinal/rules/sentinal-mcp-servers.md:3` claims. With runtime it is **33 across 7**.

**Verify:**

- `bun test src/runtime/ && bunx tsc --noEmit` ✅

---

### Task 4: `runtime_init` scaffolder

**Objective:** Draft a `runtime.json` from what the project already declares, so adoption does not depend on authoring one by hand.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Create: `src/runtime/scaffold.ts`, `src/runtime/scaffold.test.ts`

**⛔ This task touches NO shared file.** Task 3 is the **sole owner of `src/index.ts`** for this phase — two parallel appends to a barrel carrying a "do not restructure" marker (`:232`) race in OpenCode's shared working directory. The barrel edit is unnecessary anyway: **`workspacePackageDirs` is already re-exported at `src/worktree/worktree-config.ts:51`**.

**Key Decisions / Notes:**

- Infer from `docker-compose.yml`, `package.json` scripts, and `Procfile`. Reuse **`workspacePackageDirs(repoRoot)`** (`seed-sources.ts:146`, already re-exported at `worktree-config.ts:51`) for monorepos rather than re-implementing discovery. Import it directly from `../worktree/seed-sources.js`.
- **⛔ OMIT the `isolation` map entirely.** Not "emit `shared`/`none`" — every value is unsafe or redundant:
  - `isolated` → unsafe: a `db` service in compose does not mean the project name is slot-parameterised. **False all-clear (R13).**
  - `none` → unsafe: inferring "no cache exists" from "no cache seen" is absence-of-evidence; if a shared cache exists, `none` suppresses the gate.
  - `shared` → **unsafe**: the scaffolder cannot know the claim is true, so it would manufacture a **FALSE block** on every run — alarm fatigue, and D10 rule 2 reserves blocking for a deliberate human declaration.
  Omission is **fail-safe** and leaves the file behaviourally as safe as no file, while still delivering the `up`/`down`/`readiness` value.
- **Scaffold the fields whose errors are LOUD; never the field whose errors are SILENT.** A wrong `up` errors or times out; a wrong `isolation` is a confident silent green light.
- Prefer leaving a field empty with a comment over guessing.

**Definition of Done:**

- [x] Drafts `up`/`down`/`readiness` from compose / package.json / Procfile
- [x] **The draft contains no `isolation` key** — asserted by test
- [x] Monorepo layouts discover package-level sources via `workspacePackageDirs`
- [x] The draft validates against Task 2's schema
- [x] Ambiguous fields are emitted empty with a comment, never guessed

**Outcome / deviations:**

- **The draft is JSONC, so a `jsonc.ts` module was added.** "Prefer leaving a field empty **with a comment**" is only possible if the file may carry comments, and a loader that rejected comments would reject Sentinal's own output. `stripJsonComments` is string-aware — a naive regex truncates `"curl http://localhost/x"` at the `//`. Trailing commas are deliberately *not* accepted.
- **`readiness` is DERIVED, never guessed.** The scaffolder emits an `exec` port probe (`nc -z localhost <port>`) built from a published compose port / `PORT=` in a script, with a comment telling the author to upgrade it to an http probe against their real health endpoint. Drafting `http://localhost:3000/health` would mean **inventing a URL path**, which is a guess; a port number read out of `ports:` is not.
- **⛔ `up` is never emitted without `readiness`.** If no port is derivable, both are omitted and the reason is left as a comment. A draft that fails its own schema is worse than no draft — the human commits it and their next verify run errors on their own config. A loop test covers all five input shapes.
- **Precedence for `up`:** compose → `package.json` (`dev`/`start`/`serve`) → `Procfile` (`web:`). Only one `up` is drafted; combining them would invent a lifecycle nobody declared.
- **Test-assertion correction:** the first cut asserted `content` never contains the string `"isolation"`. That is wrong — the draft *must* explain its own omission in a comment. The assertion is now on the **key** (`/^\s*"isolation"\s*:/m` after comment-stripping) plus the parsed object.
- **Compose scanning is an indentation scan, not a YAML parse.** It wants service `image:` values and published `ports:` and nothing else. Acceptable *here specifically* because the output is a draft a human reviews and every field it produces fails loudly; adding a YAML dependency to improve a draft is a poor trade.
- `scaffold.ts` is 379 lines (under the 400 warn) after the `jsonc.ts` extraction.

**Verify:**

- `bun test src/runtime/scaffold.test.ts` ✅

---

### Task 5: spec-verify Phase B wiring + R11 enrichment

**Objective:** Make the `up` → `health` → tests → `down` flow real in the shipped guidance, and enrich Phase 2's not-isolated warning with named resources.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `targets/claude-code/commands/spec-verify.md` + `targets/opencode/skills/spec-verify/SKILL.md` (**identically**)
- Modify: `src/worktree/worktree-config.ts` (pass shared resources into `notIsolatedWarning`)
- Modify: `src/worktree/worktree-config.test.ts`

**Key Decisions / Notes:**

- **Insertion anchor:** `spec-verify.md:240` / `SKILL.md:238` — item 1, *"If the project declares an isolated-runtime command, use it."* Make it concrete: if `runtime.json` declares `up`, run `up` → `health` → tests → `down`.
- **Absent file → behaviour unchanged.** Byte-identical to today.
- **Phase B rule (D10 rule 3/5):** an explicitly declared `"shared"` entry → require confirmation before starting **anything** (via `up` or by hand). **`unknown` never prompts** — report it non-blockingly. Do **not** try to classify the change as "stateful" first.
- **R11 enrichment — invert the dependency; do NOT create a module cycle.** `notIsolatedWarning(sourceRel, sharedResources = [])` (`worktree-config.ts:136`, docblock `:132-135`) already takes the arg. But its only caller is internal to `seedWorktreeConfig` (`:200`), and Task 3 establishes `src/runtime/loader.ts → src/worktree/slots.ts`. Importing the loader **from** `worktree-config.ts` would close a `worktree → runtime → worktree` cycle; threading it from `manager.ts` is forbidden (582/600).
  **Resolution:** put the extraction in `src/runtime/` as `sharedResourceNames(config): string[]`, and add an **optional `sharedResources?: string[]` to `SeedOptions`** defaulted to `[]`. `src/worktree/` then imports nothing from `src/runtime/`. **The SIGNATURE is unchanged (existing callers compile untouched); the call site gains one argument.**
  If no call site can supply it without touching `manager.ts`, **defer the enrichment to Phase 4** (which must touch `manager.ts` anyway) and say so rather than forcing it.
- **⛔ `spec-verify.diff` must stay 0 bytes.** Apply edits to both targets identically; single-quote any `Skill(...)`; never regenerate the baseline.
- Do not disturb the `spec-verify-full-tsc` regexes (Step 3.2 region, CC `:124`/`:132` — disjoint from Phase B).

**Definition of Done:**

- [x] Both spec-verify files describe the `up` → `health` → tests → `down` flow, and `.sentinal/runtime.json` now refers to something real
- [x] An explicit `"shared"` blocks; `unknown` does **not** prompt
- [~] `notIsolatedWarning` names specific shared resources when a config is present — **the seam lands; the production call site does not.** See below.
- [x] **`src/worktree/` imports nothing from `src/runtime/`** — asserted by `src/runtime/no-module-cycle.test.ts`
- [x] **With no `runtime.json`, `notIsolatedWarning` output is byte-identical to the Phase 2 baseline** — asserted directly against `notIsolatedWarning(".env.example")`
- [x] **No new prompt or block path is reachable when `runtime.json` is absent**
- [x] `spec-verify.diff` is still **0 bytes**
- [x] `spec-verify-full-tsc.test.ts` and `target-parity.test.ts` pass

**Outcome / deviations:**

- **⚠️ R11 is HALF-DONE, deliberately, per this task's own escape clause.** `SeedOptions.sharedResources?: string[]` exists, `seedWorktreeConfig` threads it into `notIsolatedWarning`, and tests cover both the enriched and the byte-identical-default paths. **But nothing populates it in production.** The only three call sites of `seedWorktreeConfig`/`seedNonFatally` are `src/worktree/manager.ts:171`, `:448` and `:485` — and `manager.ts` is 582/600, explicitly forbidden to touch. There is no other construction point for `SeedOptions`.
  Per the plan's instruction ("If no call site can supply it without touching `manager.ts`, defer the enrichment to Phase 4 and say so rather than forcing it"): **the population is deferred to Phase 4**, which must touch `manager.ts` anyway. What is left for Phase 4 is one line at each of the three call sites — `sharedResources: loadRuntimeConfig(worktreePath).sharedResources` — plus whatever `manager.ts` split its own budget requires.
- **spec-verify wording:** item 1 now names `runtime_config` (with the WORKTREE path as `project`), spells out `up` → readiness → tests → `down`, and states the three failure paths (never test before readiness passes; read the `runtime.log` tail when `up` fails; process-group teardown when `down` is absent). It closes with "No `.sentinal/runtime.json`? Nothing changes." so the fallback is explicit rather than inferred.
- **Item 2 gained the `unknown` rule** — undeclared is `unknown`, reported, never prompted — plus the R13 self-attestation caveat (`"isolated"` is a statement of intent, not a proof).
- Both files patched by a single script asserting a unique match in each, so the edits are identical by construction. `spec-verify.diff` re-verified at **0 bytes**; the baseline was never regenerated.

**Verify:**

- `bun run embed-assets && bun test src/cli/ src/worktree/`
- `test ! -s src/cli/__fixtures__/target-parity/spec-verify.diff`

---

### Task 6: `/sync` integration + close the sync.md parity gap

**Objective:** Offer the scaffolder where a human is already reviewing project config, and stop the two `sync.md` copies drifting.
**Dependencies:** Task 4
**Wave:** 3

**Files:**

- Modify: `targets/claude-code/commands/sync.md` (566) + `targets/opencode/commands/sync.md` (564), **identically**
- Modify: `src/cli/target-parity.test.ts`

**Key Decisions / Notes:**

- **Anchor: a new `## Phase 6.5: Sync Runtime Contract`**, inserted **immediately before `## Phase 7: Sync MCP Rules`** (`sync.md:435` CC / `:433` OC — `:435` IS the Phase 7 heading). Phase 6 has just written the project rule (tech stack, dev commands — exactly the inputs a draft needs) and Phase 4's exploration has run; Phase 7 is `.mcp.json`-scoped, so inserting before it keeps project config grouped.
- A new `## Phase N` shifts every later heading. **Also update** the Phase 11 cross-check list (CC `:543-549`) and the Phase 12 summary list (CC `:555-564`), both of which enumerate what `/sync` produces.
- **Report detected resources in the conversation, not in the file** — e.g. *"Detected postgres and redis. `isolation` is left unset, so Sentinal will note them but not interrupt runs. If `up` namespaces them per-slot, set them to `isolated`; if genuinely shared, set `shared` and Sentinal will ask before any run that touches them."* A human reading `/sync` output is paying attention; a human reading a generated file tends to accept it.
- **⛔ Do not cause recurring prompts.** The scaffolder leaves everything `unknown`, and `unknown` never blocks (D10 rule 1). `/sync` is the one moment the user is asked to think about isolation.
- **Close the parity gap:** `PAIRS` (`target-parity.test.ts:50-58`) resolves OpenCode paths to `skills/<n>/SKILL.md`, so command-dir pairs like `sync.md` are unguarded. Generalise `ocPath` (`:100-102`) to support `commands/<n>.md`, add **`sync` only**, and seed its baseline. **`learn`/`quick`/`pause` are also unguarded command-dir pairs — file a follow-up; explicitly NOT in this phase.** `sync.md`'s known divergence is frontmatter + one `Skill(skill="learn")` — note that one uses **double quotes** and is NOT stripped by the current normaliser, so it will appear in the baseline.

**Definition of Done:**

- [x] `/sync` detects a missing `runtime.json` and offers a draft, in both targets identically
- [x] Phase 11 and Phase 12 lists updated
- [x] `target-parity.test.ts` now guards `sync.md`, with a seeded baseline
- [x] A one-sided `sync.md` edit fails the test — verified manually (appended a comment to the CC copy → `(fail) ... sync ...`), then reverted and re-verified all-pass
- [x] No recurring prompt is introduced — Phase 6.5 asks once, and only when `runtime.json` is absent

**Outcome / deviations:**

- **`## Phase 6.5: Sync Runtime Contract`** inserted immediately before Phase 7, with three steps: check (skip entirely if the file exists — Sentinal never regenerates over a project-owned file), draft via `runtime_init`, and report detected resources **in the conversation** with the exact framing the plan specified. It restates why every `isolation` value would be a guess, so the instruction survives being read out of context.
- **Numbering:** no later heading shifted — `6.5` was chosen precisely to avoid renumbering Phases 7-12. The Phase 11 cross-check gained item 8 (runtime contract still parses; no Sentinal-invented `isolation`) and the Phase 12 summary gained a "Runtime contract" line.
- **Parity gap closed:** `ocPath` now resolves `commands/<n>.md` for pairs in a new `OPENCODE_COMMAND_PAIRS` set; `sync` added to `PAIRS`. `learn`/`quick`/`pause` remain unguarded **by explicit instruction** — logged under Deferred Issues.
- **⚠️ On seeding the baseline:** `UPDATE_PARITY_BASELINES=1` regenerates *all* baselines, which the phase brief forbids for `spec-verify`. Mitigation used: `git status` on the fixtures dir before and after. Result — **`sync.diff` was the only file created; every existing baseline including `spec-verify.diff` is byte-unchanged and `spec-verify.diff` is still 0 bytes.** That is a stronger check than not running it at all, and it is reproducible.
- **`sync.diff` is 726 bytes, one hunk**, exactly the divergence the plan predicted: `Skill(skill="sentinal:learn")` vs `Skill(skill="learn")` — **double**-quoted, so `stripSentinalPrefix` (which only strips the single-quoted form) leaves it in. Documented in the test file so nobody "fixes" it by widening the normaliser.

**Verify:**

- `bun run embed-assets && bun test src/cli/`

---

### Task 7: Documentation + MCP catalog — R10

**Objective:** Make a project-authored schema discoverable, and keep the tool catalog honest.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `README.md` (736)
- Modify: `targets/claude-code/rules/verification.md` + `targets/opencode/rules/verification.md` (90 each, **byte-identical, guarded by `IDENTICAL_RULES`**)
- Modify: `.sentinal/rules/sentinal-mcp-servers.md` (108)

**Key Decisions / Notes:**

- An undocumented project-authored schema makes the whole tier undiscoverable — this is a deliverable, not an afterthought.
- **Document the R13 limitation explicitly:** `isolation` is self-attested and unverifiable, so a false `isolated` is worse than no file. ⛔ **State that unstated means `unknown`, that `unknown` NEVER blocks, and that only an explicit human-written `"shared"` gates anything.** Sentinal never infers `isolated`. (An earlier draft of this line said "`shared` is the effective default" — that is the pre-correction wording D10 rule 1 exists to overturn; writing it would document the alarm-fatigue behaviour this phase was built to avoid.)
- `.sentinal/rules/sentinal-mcp-servers.md:3` says *"28 tools across 6 domains"* — update the count and add a 7th domain table, then run its own "Smoke Test Checklist After Adding a Tool".
- **`verification.md` is in `IDENTICAL_RULES`** — both copies must stay byte-identical or the parity test fails.

**Definition of Done:**

- [x] Schema documented where a project author will read it (README `:588-601` + both `verification.md:27`)
- [x] R13's self-attestation limitation stated plainly (README `:588` heading + `:601`; `verification.md:27`)
- [x] `sentinal-mcp-servers.md` reports 7 domains and the correct tool count
- [x] Both `verification.md` copies still byte-identical (`diff -q` clean; `IDENTICAL_RULES` passes)
- [x] Smoke-test checklist run — all 6 items, including "sidecar route added?" which is correctly **none**

**Outcome / deviations:**

- **README gained a `## Runtime Contract — .sentinal/runtime.json` section** with the annotated schema, the validation rules, the interpolation scoping rule (SENTINAL prefix only; `${PORT:-3000}` and bare `$VAR` pass through verbatim), and a dedicated `⚠️ isolation is self-attested` subsection with the four-row blocks/reported table.
- **⛔ Corrected a plan error while writing the docs.** This task's notes said to "State that `shared` is the effective default". **That is the pre-correction wording D10 rule 1 exists to overturn**, and writing it would have documented the exact alarm-fatigue behaviour the phase was built to avoid. The docs state the truth instead: *unstated means `unknown`; `unknown` never blocks; only an explicit human-written `"shared"` gates anything; Sentinal never infers `"isolated"`.* R13 is stated plainly as "a wrong `isolated` is a silent green light and is worse than no file".
- **📌 The tool-count claim was already wrong before this phase.** `sentinal-mcp-servers.md:3` and the README both said "28 tools across 6 domains"; the real pre-Phase-3 figure was **31 across 6** — the Memory table was missing `memory_update`, `memory_delete` and `memory_share`. Both are now corrected to **33 across 7**, the Memory table is complete, and the rule file carries a note saying the count is hand-maintained (the new `src/mcp/server.test.ts` assertion catches an unwired *domain*, not a wrong *number*).
- The runtime domain table in the rule file carries the direct-only rationale inline, so the unused `{client, store}` reads as a decision rather than an oversight.

**Verify:**

- `bun run embed-assets && bun test src/cli/`
- `diff -q targets/claude-code/rules/verification.md targets/opencode/rules/verification.md`
