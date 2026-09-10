# Runtime-Isolation Guidance + Permission Defaults

Created: 2026-08-07
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-08-07-worktree-runtime-isolation
Wave: 1

## Summary

**Goal:** Replace the port-centric warnings in the shipped verify/implement guidance with a shared-state decision point, so an agent reasons about what a run **shares** (database, cache, queue, processes) rather than merely finding a free port — never copies the repo-root `.env`, and never terminates a process by name or pattern. Additionally ship **opt-out permission defaults** so users who want enforcement get it from their platform's native mechanism.

**Context:** See master plan at `docs/plans/2026-08-07-worktree-runtime-isolation.md` (Phase 1, Wave 1). Resolves Tier 1 of GitHub issue #2, and absorbs the useful residue of the rejected Tier 4a guard as **configuration** (D4/D4a).

## Scope

Rewrite, applied **identically to both targets**. **⚠️ Offsets differ per file** — spec-verify and spec-bugfix-verify are OC = CC − 2, but spec-implement is OC = CC − **4**. **The per-row line numbers below are authoritative**; do not apply a blanket offset.

| File                                                    | Lines     | What                                                     |
| ------------------------------------------------------- | --------- | -------------------------------------------------------- |
| `targets/claude-code/commands/spec-verify.md`           | 219-221   | Step 3.6b — `ps aux \| grep` before restarting services  |
| `targets/claude-code/commands/spec-verify.md`           | 232-244   | Step 3.7 — parallel-spec warning / `lsof -i :<port>`     |
| `targets/opencode/skills/spec-verify/SKILL.md`          | 217-219   | same as 3.6b                                              |
| `targets/opencode/skills/spec-verify/SKILL.md`          | 230-242   | same as 3.7                                               |
| `targets/claude-code/commands/spec-bugfix-verify.md`    | 64-68     | Step 3.5 — `stop service` with no mechanism              |
| `targets/opencode/skills/spec-bugfix-verify/SKILL.md`   | 62-66     | same                                                      |
| `targets/claude-code/commands/spec-implement.md`        | 193       | "Run actual program … Check port: `lsof -i :<port>`"     |
| `targets/opencode/skills/spec-implement/SKILL.md`       | 189       | same                                                      |
| `targets/claude-code/rules/verification.md`             | (70 ln)   | Add the "worktree isolates code, not runtime" principle  |
| `targets/opencode/rules/verification.md`                | (70 ln)   | byte-identical copy                                       |
| `targets/claude-code/commands/spec-verify.md`           | 299       | Step 3.9a "Resolve Playwright Session" → tool selection (D11) |
| `targets/opencode/skills/spec-verify/SKILL.md`          | 297       | same                                                      |
| `targets/claude-code/rules/playwright-cli.md`           | 3, 24, 32 | Exclusivity language, machine-specific Chrome claim, isolation for both tools (D11) |
| `targets/opencode/rules/playwright-cli.md`              | 3, 24, 32 | byte-identical copy (verified `diff -q` → identical)      |
| `src/cli/commands/install.ts`                           | 87-119    | Chrome DevTools MCP soft check beside the playwright-cli one — **detect only** |

Secondary Playwright references to sweep for consistency once the above land: `targets/*/rules/{mcp-servers,testing,research-tools}.md`, `targets/*/{commands,skills}/spec-implement*`, `targets/opencode/AGENTS.md`, `README.md`.

The replacement guidance (issue #2 Tier 1, **extended with point 2's `.env` clause** per D8 — the incident's database exposure came from copying the repo-root `.env`, which the issue's own wording does not cover):

> **⚠️ A worktree isolates code, not runtime.** Ports, databases, caches and processes are shared with the developer's checkout and other worktrees. Before starting anything:
>
> 1. If the project declares an isolated-runtime command, use it.
> 2. Otherwise determine what this run **shares**. **Do not copy the repo-root `.env` into the worktree** — it points at the developer's live state. **State plainly what is shared and proceed** — do not stop to ask on every run (D10 rule 1: a confirmation that always fires gets rubber-stamped, and teaches the user to accept "not isolated"). Ask only where the project has explicitly declared a resource `"shared"` in `.sentinal/runtime.json`.
> 3. Record the PID you start. **Never terminate by name or pattern** (`pkill -f`, `killall`) — kill only PIDs you captured; a pattern will match the developer's processes.
> 4. **If the port you need is occupied, stop and ask. Never switch to a different port.** A second stack on a spare port still writes to the same shared database — a free port proves nothing.

**⛔ Point 4 requires DELETING the old line, not just adding a new one (R15).** `spec-verify.md:236` currently says *"check port availability: `lsof -i :<port>`"*, which implicitly authorises exactly the improvisation that caused the incident. Leaving a contradicting instruction in place is worse than either instruction alone. The same applies to `spec-implement.md:193` / OC `:189`. Phase 4 then makes the rule structural rather than advisory — `runtime_up` **fails** on an unexplained port conflict instead of offering an alternative.

### Tool-agnostic E2E (D11)

**Chrome DevTools MCP is equally viable for E2E when installed, and appears nowhere in the repo today.** Three things block expressing that:

| Problem                                                                                                                                    | Location                                                                            | Fix                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| "**MANDATORY** for E2E testing of any app with a UI" names one tool as the only option                                                     | `targets/*/rules/playwright-cli.md:3`                                                | E2E via *a* browser-automation tool is mandatory for UI changes; playwright-cli **or** Chrome DevTools MCP satisfies it |
| "Use Firefox or Brave — NOT Chrome. **Chrome is not installed on this machine.**" — a claim about one laptop, shipped to every user        | `targets/*/rules/playwright-cli.md:24`                                               | Replace with a capability check, not a statement of fact. Also directly blocks the Chrome DevTools MCP path       |
| Step 3.9a is titled "Resolve Playwright Session" — the tool choice is not expressible                                                       | `spec-verify.md:299` / `spec-verify/SKILL.md:297`                                    | Retitle to a tool-selection step; keep the session/instance resolution beneath it                                |

**Isolation applies to both tools — this is the part that ties D11 to the master plan.** `playwright-cli.md:32` already states it for Playwright ("Without session isolation, parallel agents share the default browser instance and overwrite each other's state") and solves it with `-s=$SENTINAL_SESSION_ID`. Chrome DevTools MCP has a sharper version: it can attach to a Chrome the developer is actively using — their profile, cookies, logged-in sessions — and two worktrees driving it concurrently collide on one browser instance / debug port. **State the isolation requirement once, for whichever tool is selected**, rather than duplicating it per tool.

**Scope guard: detect, do not install.** `src/cli/commands/install.ts:104-121` already performs a soft optional-dependency check for `playwright-cli` (with the `@playwright/cli` vs deprecated-stub warning at `:95-119`). Add the equivalent recognition for Chrome DevTools MCP. **Do not add it to `mcpServers` / `opencode.json`** — this phase is documentation plus one detection branch.

**File rename decision (R14) — settle this explicitly. The two installers differ; verify before assuming.**

| Target      | Update behaviour                                                                                                            | Stale file after rename?                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude Code | `install.ts:346-348` `rmSync(MARKETPLACE_DIR, {recursive, force})` **before** recreating `pluginDir` → `rules/` rebuilt fresh | **No.** Safe.                                          |
| OpenCode    | `install.ts:687-707` `mkdirp(dest)` + per-file `writeFileSync`/`copyFileSync`. **No wipe, no manifest reconciliation.**       | **Yes.** Removed files persist indefinitely.           |

OpenCode target resolves at `install.ts:620` — `~/.config/opencode/rules/` (global) or `<project>/.opencode/rules/` (`--local`). Additional trap: the migration at `:967-981` copies `.opencode/rules/` → `.sentinal/rules/` **only when the destination does not already exist**, then `rmSync`s the source — so a stale rule can be permanently transplanted into `.sentinal/rules/`. OpenCode's `instructions` glob then loads both contradictory rules, and per `.sentinal/rules/sentinal-opencode-rules.md` there is **no `paths:` scoping on that platform** to mitigate it.

**DECIDED — option (a): keep the filename `playwright-cli.md` and broaden its contents.** Zero migration, zero risk. The name is slightly off once it documents two tools; add a one-line note at the top of the file explaining that it covers browser automation generally.

**Do NOT rename in this phase.** The underlying installer defect is tracked as **issue #3** — Sentinal has no install manifest, so `uninstall` leaves 17 files behind on OpenCode (18 rules shipped vs 5 in `RULE_FILES`, 7 skills vs 5, 5 commands vs 3) and updates never remove assets Sentinal stopped shipping. Once #3 lands a generated manifest, renaming is free and can be a trivial follow-up.

**`uninstall.ts`'s `RULE_FILES` (`:51-57`) is NOT part of the update path** — it applies only to `sentinal uninstall`. Out of scope here; see #3.

### Permission defaults (D4a)

Sentinal builds **no destructive-command guard** (D4 — shell safety is user configuration, not Sentinal's remit). Instead ship opt-out defaults using each platform's native mechanism:

| Target      | File                                   | Current state                                                                    | Change                                                            |
| ----------- | -------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OpenCode    | `targets/opencode/opencode.json:6-17`  | `permission` has `skill` and `edit` — **no `bash` key at all**                    | Add `permission.bash` with `pkill*` / `killall*` → `"ask"`        |
| Claude Code | `targets/claude-code/settings.json`    | `permissions.allow` includes `Bash(rm:*)`; `permissions.deny` is `[]` (line ~75)  | Add the equivalent — **verify CC's `ask` support at implementation** |

OpenCode's `"ask"` is a **native confirmation prompt** — warn-with-agency delivered by the platform, which a `tool.execute.before` hook could not provide (it can only `throw`, `targets/opencode/plugins/sentinal.ts:464`).

**Document the one-line removal at the point of installation** (R12), and verify the installer's merge semantics do not silently re-add the entry after a user deletes it.

**Also in scope:** add the missing cross-target content-parity test (see R6) **before** the rewrite, so the rewrite is guarded.

## Known Constraints

- `src/cli/spec-verify-full-tsc.test.ts` asserts 3 regexes across all 4 verify files — must keep `/full\s+(project\s+)?tsc/i` and `/incremental|cache|LSP/i` matching, and must NOT introduce `/(tsc --noEmit|bunx tsc|npx tsc)…as fallback/i`.
- `src/cli/target-assets.test.ts:325-329` — CC `spec-verify.md` must retain `subagent_type="sentinal:spec-reviewer"`.
- `src/cli/target-assets.test.ts:59-113` — no `sentinal:` prefix may appear in any OpenCode `.md`.
- `src/cli/commands/no-leak.test.ts:26-38` — 9 forbidden template-path substrings.
- **Run `bun run embed-assets` before `bun test`.** `src/cli/embed-assets-preload.ts:28` regenerates only when the file is *missing*, never when stale.
- CI freshness check `scripts/check-embed-assets.mjs:52-61` currently spot-checks only `spec-master-plan`/`spec-master-execute` — extend it to the verify files.

## Out of Scope

- Any change to `src/` runtime code **except** the D11 optional-dependency detection branch in `src/cli/commands/install.ts:104-121`. **Also in scope:** the new parity test and the `scripts/check-embed-assets.mjs` spot-check extension (build tooling, not a test).
- **Installing or configuring Chrome DevTools MCP.** Detection and documentation only — no `mcpServers` / `opencode.json` entry (D11 scope guard).
- **Installer manifest / uninstall completeness — tracked as issue #3.** Do not touch `uninstall.ts` or the OpenCode install-cleanup path in this phase. R14 is resolved by simply not renaming.
- `.sentinal/runtime.json` consumption — that is Phase 4, which re-edits these same files.

## Wave-1 Conflict Notes

- This phase owns `targets/*/rules/*.md` **within Wave 1**. Phase 3 (Wave 2) may edit them safely.
- This phase also owns `targets/claude-code/settings.json`, `targets/opencode/opencode.json`, `targets/*/rules/playwright-cli.md`, `src/cli/commands/install.ts` and `scripts/check-embed-assets.mjs`.
- `src/cli/embedded-assets.ts` is **generated and not committed** (`scripts/check-embed-assets.mjs:5`), so parallel regeneration by the other Wave-1 phase is safe.
- Phase 2 (the only other Wave-1 phase) touches `src/worktree/`, `src/memory/migrations.ts`, `src/cli/commands/worktree.ts` and `src/index.ts` — **zero overlap**.

---

## Context for Implementer

> Written for someone who has never seen this codebase.

- **Dual-target, hand-synced.** `targets/claude-code/commands/*.md` and `targets/opencode/skills/*/SKILL.md` are *both* canonical. There is **no generator** — `src/cli/commands/no-leak.test.ts:64-74` asserts the old one stays deleted. **Every content edit must be applied twice, identically.**
- **The only permitted divergences** between a CC command and its OC skill are: frontmatter, and `sentinal:`-prefixed `subagent_type=` / `Skill(skill=…)` references. `src/cli/target-assets.test.ts:59-113` forbids the two literal strings `sentinal:plan-reviewer` and `sentinal:spec-reviewer` in any OpenCode `.md` (NOT `sentinal:` generally); `:325-329` requires `subagent_type="sentinal:spec-reviewer"` to remain in the CC `spec-verify.md`.
- **⚠️ Line offsets differ per file.** spec-verify and spec-bugfix-verify are OC = CC − 2; spec-implement is OC = CC − **4**. Never apply a blanket offset — re-grep before editing.
- **⛔ `bun run embed-assets` before `bun test`, every time.** `src/cli/embed-assets-preload.ts:28` regenerates the embedded copy only when it is **absent**, never when stale — so editing `targets/**` and running `bun test` silently validates the *old* content.
- **Test runner is `bun test` (bun:test), not jest.** Import from `"bun:test"`.
- **Existing test patterns to copy:** `src/cli/spec-verify-full-tsc.test.ts` (describe.each over the 4 verify files), `src/cli/target-assets.test.ts` (per-file `it()` over a directory), `src/cli/commands/no-leak.test.ts:26-38` (forbidden-substring scanning).
- **Prettier/ESLint are not repo-configured**; OpenCode's built-in formatter handles it. Do not add configs.

## Testing Strategy

- **Unit:** new parity test (Task 1) + extended `check-embed-assets.mjs` guard (Task 3), both run under `bun test` / `bun scripts/check-embed-assets.mjs`.
- **Regression:** `src/cli/spec-verify-full-tsc.test.ts`, `src/cli/target-assets.test.ts`, `src/cli/commands/no-leak.test.ts` must stay green after every markdown edit.
- **Manual:** Task 2's permission-semantics spike is empirical — record findings in this file before Task 6 acts on them.

## Assumptions

- **⚠️ CORRECTED — "differ only by frontmatter + `sentinal:` prefixes" is TRUE ONLY for `spec-verify`.** Measured 2026-08-07 (strip frontmatter, strip `sentinal:`, then unified-diff):

  | Pair                  | Hunks after normalisation | Status                          |
  | --------------------- | ------------------------- | ------------------------------- |
  | `spec-verify`         | **0**                     | byte-equal                      |
  | `spec-bugfix-verify`  | **0**                     | byte-equal                      |
  | `spec-master-plan`    | **0**                     | byte-equal                      |
  | `spec-plan`           | 1                         | known divergence → baseline     |
  | `spec-bugfix-plan`    | 1                         | known divergence → baseline     |
  | `spec-master-execute` | 4                         | known divergence → baseline     |
  | `spec-implement`      | **5**                     | known divergence → baseline     |

  `spec-implement`'s divergence is a genuine platform capability difference — CC uses `Agent(isolation="worktree")`, OC uses `Task(subagent_type="general")` and carries an OpenCode-only safety paragraph — which is also why its offset shifts −2 → −4 at Step 2.3. **Tasks 1 and 4 depend on this corrected table, not on the old blanket claim.**
- `targets/*/rules/verification.md` and `targets/*/rules/playwright-cli.md` are **byte-identical** across targets — verified `diff -q` — Tasks 1, 4, 7 depend on this.
- `targets/*/rules/playwright-cli.md` is byte-identical across targets — verified `diff -q` → identical — Task 7 depends on this.
- OpenCode's `permission.bash` accepts `"ask"` — **asserted from docs, NOT verified** — Task 2 must confirm; Task 6 depends on it.
- CC `permissions.ask` exists and its precedence vs the bare `"Bash"` allow at `settings.json:11` is unknown — Task 2 must confirm; Task 6 branches on it (see Decision below).

## Decisions

- **D-P1-a — CC permission fallback (user-approved).** If Task 2 finds `ask` does **not** take precedence over the bare `"Bash"` allow (`settings.json:11`), **drop the Claude Code default entirely** and document the manual opt-in snippet instead. Do **not** narrow the bare `"Bash"` entry — that is a far larger behavioural change than D4a claims (every unlisted command would start prompting). Record the outcome in Residual Risk: only OpenCode gets a native prompt.
- **D-P1-b — R14 resolved: do NOT rename `playwright-cli.md`.** Keep the filename, broaden the contents. Renaming orphans a stale copy on OpenCode (`install.ts:687-707` is additive, no manifest) — tracked as issue #3.

## Spike Findings

_Task 2's spike is recorded in full at `docs/plans/2026-08-07-worktree-runtime-isolation-phase-1-spike.md`. Inlined below is the conclusion plus the follow-up measurement that closed the one gap the spike left open._

### Summary (Task 2)

| Platform    | Verdict                | Action taken                                                                       |
| ----------- | ---------------------- | ---------------------------------------------------------------------------------- |
| OpenCode    | Viable, top-level only | `permission.bash` with `pkill*` / `killall*` → `ask`. Per-agent duplication NOT needed — R16 resolved as **MERGE**. |
| Claude Code | Not deliverable        | D-P1-a fallback: CC default dropped, manual snippet documented. `ask` *does* beat a bare `Bash` allow, but Claude Code reads only `agent` / `subagentStatusLine` from a plugin-root `settings.json`, so the entry would be inert. |

### ⚠️ Follow-up measurement — the SHIPPED `permission.bash` shape (added 2026-08-08)

**The gap:** the spike's empirical `GET /agent` run used `"bash": { "*": "allow", "pkill*": "ask", "killall*": "ask" }`. The config that actually ships has **no `"*"` key**. The claim that this is safe rested on the parenthetical inference at spike:69, which was never re-measured. This mattered because OpenCode's `Permission.evaluate` falls back to `{action:"ask"}` when **no** rule matches — if a wildcard-less bash map meant benign commands matched nothing, **every bash command would prompt for every OpenCode user on upgrade.**

**Method:** identical to the original spike — isolated `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME`, `opencode serve`, `GET /agent` (which returns the fully resolved `Agent.permission`), run against a byte-for-byte copy of the shipped `targets/opencode/opencode.json`. OpenCode **1.18.15**.

**Result — the shipped wildcard-less map is SAFE. No change was needed.**

| Agent                            | `ls -la`, `git status`, `bun test`, `rm -rf node_modules` | `pkill -f foo`, `killall node`, bare `pkill`, bare `killall` |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `build`, `plan`, `general`, `explore` | **allow**                                                   | **ask**                                                        |
| `compaction`, `summary`, `title` | deny *(OpenCode's own built-in restriction on its internal agents — not ours)* | ask                                     |

The built-in `{"permission":"*","pattern":"*","action":"allow"}` sits at **index 0** of every resolved ruleset and catches everything the two guarded patterns do not, so the ask-by-default fallback is never reached. Confirmed against the resolver transcribed verbatim from the shipped binary:

```js
// Permission.evaluate  (minified symbol `c`)
(permission, value, ...rulesets) =>
  rulesets.flat().findLast(r => match(permission, r.permission) && match(value, r.pattern))
    ?? { action: "ask", permission, pattern: "*" };
```

`findLast` is the last-match-wins rule the spike inferred from the built-in `read`/`*.env.example` defaults — now confirmed directly in code rather than by consistency argument.

**The alternative fix would have been a regression.** Adding `"*": "allow"` as the first key (the review's option b, and spike:69's original suggestion) was measured too: it changes **nothing** for the four user-facing agents, but flips `compaction`, `summary` and `title` from OpenCode's built-in **`deny` to `allow`** — handing shell access to internal agents the platform deliberately denies. It would also override a narrower bash policy a user set in a parent config. **Option (a) — keep the config as-is — was taken.**

**Now pinned by tests**, so this cannot silently regress:

- `tests/e2e/permission-defaults.e2e.ts` — installs into the isolated sandbox, starts the **real** `opencode serve`, reads the **resolved** `Agent.permission` from `GET /agent`, and asserts `allow` for benign commands / `ask` for the guarded ones across all four user-facing agents. Verified to fail when `pkill*` is flipped to `allow`.
- `src/cli/permission-defaults.test.ts` — fast guard on the input: asserts `permission.bash` declares **no** `"*"` key (with the measurement above recorded as the reason) and that every value is `ask`, never `allow`/`deny`.

## Risks and Mitigations

| Risk                                                                     | Likelihood | Impact | Mitigation                                                                                              |
| ------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------- |
| Edit applied to one target only → silent behavioural split               | High       | High   | Task 1 lands the parity test **first**; every later task re-runs it                                     |
| Stale `embedded-assets.ts` masks a broken edit                           | High       | Medium | `bun run embed-assets` in every task's Verify; Task 3 extends the CI guard to the verify files           |
| Rewriting Step 3.7 breaks `spec-verify-full-tsc.test.ts` regexes         | Medium     | Medium | Those regexes live at CC:124/132 — a different section from 3.6b/3.7. Re-run the test in Task 4's Verify |
| Task 2 finds neither platform supports a usable `ask` → D4a is dead      | Low        | High   | D-P1-a covers the CC half; if OC also fails, Task 6 becomes documentation-only and DoD item 9 is amended |

## Residual Risk

_Recorded after Task 2's spike and Task 6's implementation. State plainly, do not gloss._

1. **Only OpenCode gets a native prompt from the shipped defaults.** Per D-P1-a the Claude Code half was **dropped**. The reason is not the one D-P1-a anticipated: `ask` *does* beat a bare `"Bash"` allow on Claude Code. The blocker is the delivery channel — Sentinal's only CC settings surface is a plugin-root `settings.json`, and Claude Code reads **only** the `agent` and `subagentStatusLine` keys from it. A `permissions.ask` entry there would be **inert**: green on a presence test, dead at runtime. Claude Code users get a documented manual snippet for their own `~/.claude/settings.json` and nothing automatic. **Master DoD item 9 has been amended to match** (`2026-08-07-worktree-runtime-isolation.md:364`).

2. **A user's *deletion* of the OpenCode default is not durable.** The installer's `deepMergeAdditive` re-adds any absent key on the next update. Only *changing the value* survives. This is documented in `verification.md` and pinned by a test, but it remains a genuinely surprising behaviour: a user who deletes the line will see it come back and may reasonably conclude Sentinal is overriding them. The real fix is an install manifest — **issue #3**.

3. **The `pkill`/`killall` pattern coverage is narrower on OpenCode than on Claude Code.** OpenCode matches the glob against the **whole command string**, so `foo && pkill -f x`, `sh -c "pkill …"` and `xargs pkill` do **not** prompt. Claude Code matches each subcommand of a compound command independently and strips bare `xargs`, so it would catch the first and third — but Claude Code has no shipped default (risk 1), so that better matching only helps users who add the snippet manually. Net: **the prompt is a backstop for the simplest form only.** The primary control remains the Phase 1 prose ("never terminate by name or pattern"), and the structural fix remains Phase 4's `runtime_stop`.

4. **R15 is not closed by this phase.** The `lsof` lines are deleted and the replacement forbids improvising a port, but this is still prose against a long-standing habit, and the failure mode is silent. Phase 4 makes it structural (`runtime_up` **fails** on an unexplained port conflict). Until then, Phase 1 is advisory only.

5. **Two pre-existing defects were found and deliberately left alone.** (a) The whole `permissions.allow` list and the `env` block in `targets/claude-code/settings.json` are inert for the same reason as risk 1 — this is a real bug with real scope, but fixing it is not this phase's job. (b) `claude plugin validate ./targets/claude-code --strict` fails on malformed YAML frontmatter in `commands/spec.md` ("At runtime this command loads with empty metadata"). Both should be filed separately.

## Pre-Mortem

_Assume this phase failed. Most likely internal reasons:_

1. **The parity test is too strict and blocks legitimate divergence** (Task 1) → Trigger: the test fails on the very first run against unmodified `targets/`, before any rewrite. Fix by normalising frontmatter + `sentinal:` prefixes before comparing, not by loosening to uselessness.
2. **We deleted the `lsof` line but the agent still improvises a port** (Task 4) → Trigger: a manual spec-verify dry-run still reasons "port busy, try another". The structural fix lives in Phase 4 (`runtime_up` fails); Phase 1 prose alone may be insufficient — R15.
3. **`permission.bash` is real but per-agent blocks shadow it** (Tasks 2, 6) → Trigger: the `ask` prompt fires in a bare session but not under `/spec`. `opencode.json:19-51` defines `agent.build.permission` and `build` runs `/spec` — R16.

## Execution Waves

**Wave 1** — Guards and facts (parallel): the parity test, the CI freshness guard, and the permission spike touch three disjoint files and depend on nothing. The parity test must land here so every later edit is guarded (R6).
**Wave 2** — Content and code (parallel): the guidance rewrite (Task 4, owns **all** `targets/*/rules/verification.md` edits), the install-time detection branch (Task 5), and the permission defaults (Task 6, **config files only**). Verified disjoint. Task 6's dependency on Task 2 is **soft** — see Task 2's unblock rule.
**Wave 3** — D11 E2E: must follow Task 4 because both edit `spec-verify.md`.

## Goal Verification

### Truths

1. **No** `lsof` occurrence in any of the four verify/implement files across both targets (8 files): `spec-verify`, `spec-bugfix-verify`, `spec-implement`, plus `rules/verification.md`.
2. All four verify/implement files (both targets) contain `never terminate by name or pattern` (case-insensitive).
3. All four verify/implement files (both targets) contain a `.env` clause forbidding copying the repo-root `.env`.
4. `targets/*/rules/playwright-cli.md` contains **no** occurrence of `Chrome is not installed on this machine`.
5. `targets/*/rules/playwright-cli.md` mentions Chrome DevTools MCP as a viable alternative.
6. `bun test src/cli/` passes, including the new parity test.
7. `bun scripts/check-embed-assets.mjs` exits 0 and its content check now covers `spec-verify`.

### Artifacts

| Artifact                                          | Provides                                 | Exports                    |
| ------------------------------------------------- | ---------------------------------------- | -------------------------- |
| `src/cli/target-parity.test.ts`                   | Cross-target content-parity guard        | bun:test suite             |
| `targets/*/commands+skills/spec-verify.*`         | Shared-state decision point, PID rule    | shipped guidance           |
| `targets/*/rules/verification.md`                 | "worktree isolates code, not runtime"    | shipped rule               |
| `targets/*/rules/playwright-cli.md`               | Tool-agnostic E2E + browser isolation    | shipped rule               |
| `targets/opencode/opencode.json`                  | `permission.bash` opt-out default        | shipped config             |
| `src/cli/commands/install.ts`                     | Chrome DevTools MCP soft detection       | install-time status line   |

### Key Links

| From                              | To                                        | Via                    | Pattern                          |
| --------------------------------- | ----------------------------------------- | ---------------------- | -------------------------------- |
| `src/cli/target-parity.test.ts`   | `targets/claude-code/commands/spec-verify.md` | parity assertion   | `spec-verify`                    |
| `scripts/check-embed-assets.mjs`  | generated `embedded-assets.ts`            | freshness spot-check   | `spec-verify`                    |
| `src/cli/commands/install.ts`     | Chrome DevTools MCP                       | optional-dep detection | `chrome-devtools\|checkChrome`   |
| `targets/opencode/opencode.json`  | OpenCode permission engine                | `permission.bash`      | `"bash"\s*:`                     |

## Progress Tracking

- [x] Task 1: Cross-target parity test (Wave 1)
- [x] Task 2: Permission-semantics spike — R16/R12/L3 (Wave 1)
- [x] Task 3: Extend embed-assets CI freshness guard (Wave 1)
- [x] Task 4: Runtime-isolation guidance rewrite (Wave 2)
- [x] Task 5: Chrome DevTools MCP soft detection in install.ts (Wave 2)
- [x] Task 6: Opt-out permission defaults (Wave 2)
- [x] Task 7: Tool-agnostic E2E rule + 3.9a retitle (Wave 3)

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: Cross-target parity test

**Objective:** Land a test asserting each spec-\* CC command and its OC skill differ only by frontmatter and `sentinal:` prefixes — **before** any content is rewritten, so every later task is guarded (R6).
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/cli/target-parity.test.ts`

**Key Decisions / Notes:**

- Pairs to cover: `spec-plan`, `spec-implement`, `spec-verify`, `spec-bugfix-plan`, `spec-bugfix-verify`, `spec-master-plan`, `spec-master-execute` → `targets/claude-code/commands/<n>.md` vs `targets/opencode/skills/<n>/SKILL.md`.
- **⛔ DO NOT assert byte-equality after normalisation.** That premise is false for 4 of the 7 pairs (see the corrected Assumptions table). `spec-implement` legitimately differs — CC `Agent(isolation="worktree")` vs OC `Task(subagent_type="general")`, plus an OpenCode-only safety paragraph — because OpenCode has no worktree-isolated agents. Byte-equality would fail on the first run, which is this plan's own Pre-Mortem #1.
- **Use a committed diff baseline instead**, which still satisfies R6 (catch one-sided edits) without asserting a false premise:
  1. Normalise: strip YAML frontmatter; strip `sentinal:` from `subagent_type="sentinal:X"` **and** from `Skill(skill='sentinal:X'` (the CC files contain both forms).
  2. Compute a unified diff of the normalised bodies per pair.
  3. Assert the diff **equals** a committed baseline at `src/cli/__fixtures__/target-parity/<pair>.diff`. A one-sided edit changes the diff → the test fails with a readable delta. Intentional new divergence requires an explicit, reviewable baseline update.
  4. Seed the baselines by running once against unmodified `targets/` — this makes DoD item 1 achievable by construction. Three baselines will be empty (`spec-verify`, `spec-bugfix-verify`, `spec-master-plan`); an empty baseline is the strongest possible assertion and should stay empty.
- **Second block: rules byte-identity.** `targets/*/rules/verification.md` and `targets/*/rules/playwright-cli.md` are byte-identical today (verified) and must stay so. No normalisation needed — no frontmatter, no `sentinal:` prefixes. This converts two prose DoD claims (Tasks 4 and 7) into enforced invariants.
  - **Amended post-review:** `testing.md` was **added** to `IDENTICAL_RULES`. Task 7's consistency sweep edited it in both targets but left it outside the guard, so the two copies could have drifted silently — the exact failure R6 exists to prevent, in a file this phase touched. Verified byte-identical before adding, and verified the guard fails on a one-sided edit. **The allowlist must be extended whenever a rule is edited in both targets.**
  - **Amended post-review:** a **missing** baseline is now a hard failure. `readBaseline()` previously returned `""` for an absent file, so `rm <pair>.diff` satisfied both the parity assertion and the must-stay-empty guard vacuously. It now throws, and a separate `existsSync` assertion reports the deletion as "the artefact is gone" rather than "the diff changed". Verified: deleting `spec-verify.diff` fails 3 assertions.
- Follow the `describe.each` shape in `src/cli/spec-verify-full-tsc.test.ts:31-49` (the `describe.each` call itself is at `:52`).
- On failure, print the diff delta — a bare "not equal" is useless for a 400-line file.

**Definition of Done:**

- [x] Test passes against **unmodified** `targets/` (achieved by seeding baselines, not by loosening the assertion)
- [x] Test **fails** when a line is added to one target only (verify manually, then revert)
- [x] All 7 spec-\* pairs covered; `spec-verify` / `spec-bugfix-verify` / `spec-master-plan` baselines are **empty**
- [x] `spec-implement`'s baseline records the Agent-vs-Task / worktree-isolation divergence — this is **intentional** and must not be normalised away
- [x] Rules-parity block asserts byte-identity for `verification.md`, `playwright-cli.md` **and `testing.md`** across both targets
- [x] A **deleted** baseline is a hard failure, distinct from a legitimately empty one
- [x] No diagnostics errors

**Verify:**

- `bun test src/cli/target-parity.test.ts`

---

### Task 2: Permission-semantics spike (R16 / R12 / L3)

**Objective:** Establish, empirically, whether the D4a permission defaults can actually work on each platform. Task 6 is blocked on the answer.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `docs/plans/2026-08-07-worktree-runtime-isolation-phase-1-spike.md`

**⚠️ Write findings to the scratch file above, NOT into this plan.** The shipped guidance this phase edits (`targets/opencode/skills/spec-implement/SKILL.md:148,158`) states that parallel agents must not touch the plan file — the orchestrator owns it. Task 6 or the orchestrator inlines the findings into `## Spike Findings` after Wave 1 closes.

**Key Decisions / Notes:**

Three questions, all currently unverified:

1. **R16 — shadowing.** `targets/opencode/opencode.json:19-51` declares `agent.build.permission` and `agent.plan.permission` (each with `task` + `edit`, no `bash`). Does a per-agent `permission` block **merge with** or **replace** the top-level `permission`? `build` is the agent that runs `/spec`, so if it replaces, a top-level `permission.bash` is inert exactly where it matters.
2. **L3 — precedence.** `targets/claude-code/settings.json:11` opens `permissions.allow` with a bare `"Bash"`. Does an `ask` rule take precedence over a blanket `allow`?
3. **R12 — revert.** Does the shipped CC `settings.json` land under `MARKETPLACE_DIR`? If so, `install.ts:346-347` `rmSync`s it on every update and a user's deletion is **guaranteed** to revert.

Use `.opencode/skills/sentinal-opencode-api-source/SKILL.md` for the authoritative OpenCode API/changelog source (repo is `anomalyco/opencode`, not `sst`). Prefer reading the installed OpenCode source over docs.

**⛔ Unblock rule — Q1 must never stall Wave 2.** If merge-vs-replace cannot be determined conclusively, **default to duplicating `permission.bash` into the top-level `permission` AND into `agent.build.permission` and `agent.plan.permission`.** That is correct under *both* semantics — required under "replace", a harmless exact duplicate under "merge". The spike therefore only determines whether the duplication is redundant, so Task 6's dependency on this task is **soft**.

**Q3 is a plain code read, not a spike** — `install.ts` determines deterministically whether the shipped `settings.json` lands under `MARKETPLACE_DIR`. Answer it independently of Q1/Q2; it feeds R12 documentation in Task 6 either way.

**Definition of Done:**

- [x] Each of the three questions answered with evidence (file:line, or a reproducible observation)
- [x] Findings written to the scratch spike file (not this plan)
- [x] Task 6's branch chosen and recorded per **D-P1-a** — **fallback branch taken: the Claude Code default is dropped.** Reason differs from the one D-P1-a anticipated: `ask` *does* beat a bare `Bash` allow (Q2), but Sentinal's only CC settings channel is a plugin-root `settings.json`, and Claude Code reads **only** the `agent` and `subagentStatusLine` keys from it — `permissions` there is inert (Q3b). See the spike file.

**Verify:**

- `test -f docs/plans/2026-08-07-worktree-runtime-isolation-phase-1-spike.md`

---

### Task 3: Extend embed-assets CI freshness guard

**Objective:** Make CI catch a stale embedded copy of the files this phase edits. The guard currently spot-checks only `spec-master-plan` / `spec-master-execute` (R5).
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `scripts/check-embed-assets.mjs` (content-freshness loop at `:52-61`)

**Key Decisions / Notes:**

- Extend the `for (const name of [...])` list to include `spec-verify` and `spec-bugfix-verify`.
- The existing check greps for `name: <skill>` frontmatter in the generated output — that shape works unchanged for these skills.
- Do **not** convert this into a full manifest check; that is issue #3's job.

**Definition of Done:**

- [x] Guard covers `spec-verify` and `spec-bugfix-verify`
- [x] `bun scripts/check-embed-assets.mjs` exits 0 on a clean tree
- [x] Guard **fails** if `targets/opencode/skills/spec-verify/` is temporarily **removed** (verified: exit 1, "missing 'name: spec-verify'"). **Correction:** a *rename in place* does NOT trip it — the guard greps the generated output for the skill's `name:` frontmatter, which is independent of the directory name. Renaming the dir still emits `name: spec-verify`. Moving the directory out of `targets/` is the correct negative test.

**Verify:**

- `bun scripts/check-embed-assets.mjs`

---

### Task 4: Runtime-isolation guidance rewrite

**Objective:** Replace the port-centric warnings with a shared-state decision point across the shipped verify/implement guidance, on both targets identically.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `targets/claude-code/commands/spec-verify.md` (Step 3.6b `:219-221`, Step 3.7 `:232-244`)
- Modify: `targets/opencode/skills/spec-verify/SKILL.md` (same, offset −2)
- Modify: `targets/claude-code/commands/spec-bugfix-verify.md` (`:64-68`) + `targets/opencode/skills/spec-bugfix-verify/SKILL.md` (`:62-66`)
- Modify: `targets/claude-code/commands/spec-implement.md` (`:193`) + `targets/opencode/skills/spec-implement/SKILL.md` (`:189`, offset −4)
- Modify: `targets/claude-code/rules/verification.md` + `targets/opencode/rules/verification.md` — **this task owns BOTH files exclusively within Wave 2**, including the D4a permission opt-out documentation that Task 6's config work refers to

**Key Decisions / Notes:**

- Replacement text is the 4-point block in the Scope section above. **Point 2 states what is shared and proceeds — it does NOT prompt** (D10 rule 1: a confirmation that always fires gets rubber-stamped and teaches the user to accept "not isolated"). Only an explicit `"shared"` in `.sentinal/runtime.json` blocks, and that file does not exist until Phase 3.
- **⛔ DELETE the `lsof` lines — do not merely add a contradicting instruction (R15).** A stale instruction left beside its replacement is worse than either alone.
- Re-grep line numbers before editing; the offsets differ per file.
- Do not touch Step 3.9a here — that is Task 7 (same file, later wave).

**Definition of Done:**

- [x] Zero `lsof` occurrences in all four verify/implement files, both targets
- [x] All four files contain the "never terminate by name or pattern" rule (verified: 8/8 files)
- [x] All four contain the "do not copy the repo-root `.env`" clause (verified: 8/8 files)
- [x] `verification.md` (both targets) carries the "a worktree isolates code, not runtime" principle, the D4a opt-out documentation, and **remains byte-identical across targets** (enforced by Task 1's rules-parity block)
- [x] Parity test still passes
- [x] `spec-verify-full-tsc.test.ts` still passes. **Why it is safe:** its 3 regexes are whole-file (`:60/:69/:76`, applied to `readFileSync` at `:53`), and the matching text lives in `Step 3.2: Automated Checks` (spec-verify.md:119-141, i.e. :124/:132) and `Step 3.3: Quality Checks` (spec-bugfix-verify.md:44-60) — both **disjoint** from the rewritten 3.6b/3.7/3.5 regions. The replacement text introduces no `tsc` token, so the negative-fallback regex is unaffected.

**Verify:**

- `bun run embed-assets && bun test src/cli/`
- `! rg -q 'lsof' targets/claude-code/commands/spec-verify.md targets/opencode/skills/spec-verify/SKILL.md targets/claude-code/commands/spec-implement.md targets/opencode/skills/spec-implement/SKILL.md`
- `diff -q targets/claude-code/rules/verification.md targets/opencode/rules/verification.md`

---

### Task 5: Chrome DevTools MCP soft detection

**Objective:** Recognise Chrome DevTools MCP at install time alongside the existing `playwright-cli` check. **Detect only — never install or configure it.**
**Dependencies:** None
**Wave:** 2

**Files:**

- Modify: `src/cli/commands/install.ts` (beside `checkPlaywrightCli` at `:104-121`, JSDoc `:86-103`; call sites `:320`, `:613`)

**Key Decisions / Notes:**

- Mirror the existing soft-check shape (`checkPlaywrightCli`, `src/cli/commands/install.ts:104-121`, JSDoc `:86-103`): print a status line, and on absence print a hint. Never fail the install.
- **Do not add an entry to `mcpServers` / `opencode.json`** — D11's scope guard.
- **⚠️ Specify the predicate — `commandExists('chrome-devtools-mcp')` alone would be always-false.** Unlike `@playwright/cli`, Chrome DevTools MCP has no global binary; it is conventionally launched via `npx`. A naive PATH check prints a hint on every install for a tool nobody installs globally — noise, not signal. Use a **two-part** check:
  1. **Browser capability** — is a Chrome/Chromium binary present (`google-chrome`, `chromium`, or `/Applications/Google Chrome.app` on darwin)? Chrome DevTools MCP requires Chrome, so this gates the path at all. This is also the check that should replace the hard-coded claim at `playwright-cli.md:24` in Task 7.
  2. **MCP availability** — is `chrome-devtools-mcp` resolvable on `$PATH` or already present in the user's MCP config?
- **Print the hint only when (1) is true**, so users without Chrome get no noise.

**Definition of Done:**

- [x] Install output reports Chrome DevTools MCP presence/absence
- [x] **Absence of Chrome produces no install-time hint** (no noise for non-Chrome users)
- [x] **Detection result is written to no config file** — asserted by a test that byte-compares the config before/after across every branch
- [x] No `mcpServers` or `opencode.json` mutation introduced
- [x] `bun test src/cli/commands/install.test.ts` passes (25 pass)
- [x] No diagnostics errors

**⚠️ Deviation from the plan's Files list.** The detection logic lives in a **new module `src/cli/commands/install-prereqs.ts`**, not inline in `install.ts`. `install.ts` is **1052 lines** — already far past Sentinal's own 600-line block threshold, and not in `PATH_EXEMPTIONS` — so growing it further was not defensible. `install.ts` still owns the wiring: the import and the two call sites.

**Amended post-review.** The re-export block has been **removed** from `install.ts`, and `install.test.ts` now imports `checkChromeDevToolsMcp` from `./install-prereqs.js` directly. Adding 6 lines to `install.ts` purely for test ergonomics pushed it further past the threshold the split-out was justified by. `install.ts` is now 1057 lines and holds only the import + two call sites.

**Also amended post-review — `declaredInMcpConfig` hygiene:**

- **Size guard.** It substring-scans `~/.claude.json`, which routinely reaches tens of megabytes for active Claude Code users (per-project session state). Files over **2 MB** are now skipped without being read — the result only decides `[OK]` versus a hint, so a false negative costs one extra line of output while the old behaviour cost a multi-megabyte synchronous read on every install.
- **Project-local paths.** `defaultMcpConfigPaths()` now also covers `<cwd>/.opencode/opencode.json`, `<cwd>/.mcp.json` and `~/.claude/settings.json`. A user who configured Chrome DevTools MCP project-locally was previously told it was "not configured". The function is exported so the path list is asserted directly rather than inferred from probe output.
- Still **detect-only**: no writes, no `process.exit`, both pinned by existing tests.

**Verify:**

- `bun test src/cli/commands/install.test.ts`

---

### Task 6: Opt-out permission defaults

**Objective:** Ship `pkill` / `killall` → `ask` as an opt-out default using each platform's native permission engine (D4a), branching on Task 2's findings.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Modify: `targets/opencode/opencode.json` (add `permission.bash`; and per R16, possibly `agent.build.permission.bash` + `agent.plan.permission.bash`)
- Modify: `targets/claude-code/settings.json` — **only if** Task 2 shows `ask` beats the bare `"Bash"` allow
- Create/Modify: a `target-assets`-style test asserting the bash policy is present in every required location

**⚠️ This task owns CONFIG ONLY.** The user-facing opt-out documentation lives in `targets/*/rules/verification.md`, which **Task 4 owns** — both files, both targets. Wave 2 would otherwise have two tasks writing the same file, and OpenCode runs parallel tasks in a **shared working directory with no worktree isolation** (`targets/opencode/skills/spec-implement/SKILL.md:160`), so they would corrupt each other.

**Key Decisions / Notes:**

- **D-P1-a applies:** if `ask` does not take precedence on CC, **drop the CC default** and ship a documented manual snippet instead. Do **not** narrow the bare `"Bash"` entry.
- If R16 shows per-agent blocks *replace* the top level, duplicate `permission.bash` into `agent.build.permission` and `agent.plan.permission`.
- Document the one-line removal at the point of installation, and note R12 if the CC path is retained.

**Definition of Done:**

- [x] `pkill` / `killall` → `ask` present wherever Task 2's findings require — **top-level `permission.bash` in `targets/opencode/opencode.json` only.** R16 resolved as **MERGE** (verified against OpenCode 1.18.15 via `GET /agent`: `build`, `plan` and `general` all resolve `bash pkill*→ask` from the top-level block alone), so the plan's "duplicate into `agent.build`/`agent.plan`" fallback is **not needed** and was not applied.
- [x] Removal instructions documented in a user-facing rule (`targets/*/rules/verification.md`, written by Task 4)
- [x] A `target-assets`-style test asserts the bash policy is present in every required location — `src/cli/permission-defaults.test.ts` (also guards the last-match-wins key ordering, and fails if a future per-agent `bash` block shadows the default)
- [x] Residual Risk updated — see `## Residual Risk` below
- [x] **DONE — the CC half was dropped and master DoD item 9 has been AMENDED** (`2026-08-07-worktree-runtime-isolation.md:364`), with the reason stated inline. Original obligation: **If the CC half is dropped per D-P1-a, AMEND master DoD item 9** (`2026-08-07-worktree-runtime-isolation.md`) to read: *"on **OpenCode**, `pkill -f <pattern>` triggers the native confirmation prompt with the shipped default config; on Claude Code a documented manual opt-in snippet is provided (Phase 1 D-P1-a)."* Master item 9 currently says "on each platform … if this cannot pass, revisit D4 rather than softening this item" — dropping the CC half **is** softening it, so the master must be amended explicitly rather than silently diverged from.
- [x] **Round-trip verified (R12)** via the isolated harness — `tests/e2e/permission-defaults.e2e.ts`, 3 pass, real `~/.claude` / `~/.config/opencode` asserted byte-unchanged. Findings: lands at **`<XDG_CONFIG_HOME>/opencode/opencode.json`** (global) or `<cwd>/opencode.json` (`--local`, `install.ts:786`). **Deleting the entry is NOT durable — the next update re-adds it** (`deepMergeAdditive` copies keys absent from the target). **Changing the value to `"allow"` IS durable** (key present + scalar ⇒ target wins).
- [x] The documented instruction **says so**: `verification.md` reads *"Change the value to `"allow"`. Do not delete the line."* — and `src/cli/permission-defaults.test.ts` asserts that exact wording in both targets, so it cannot silently regress to "delete the line".
- [x] `bun test src/cli/` passes

**Verify:**

- `bun run embed-assets && bun test src/cli/`

---

### Task 7: Tool-agnostic E2E rule + Step 3.9a retitle

**Objective:** Make E2E guidance tool-agnostic (playwright-cli **or** Chrome DevTools MCP), fix the machine-specific Chrome claim, and state browser isolation once for both tools (D11).
**Dependencies:** Task 4
**Wave:** 3

**Files:**

- Modify: `targets/claude-code/rules/playwright-cli.md` + `targets/opencode/rules/playwright-cli.md` (lines 3, 24, 32)
- Modify: `targets/claude-code/commands/spec-verify.md` (`:299`) + `targets/opencode/skills/spec-verify/SKILL.md` (`:297`)

**Key Decisions / Notes:**

- **D-P1-b: keep the filename `playwright-cli.md`.** Add a one-line note at the top that it covers browser automation generally. Renaming orphans a stale copy on OpenCode — issue #3.
- `:3` — soften "MANDATORY … playwright-cli" to "E2E via *a* browser-automation tool is mandatory for UI changes; playwright-cli **or** Chrome DevTools MCP satisfies it".
- `:24` — delete "Chrome is not installed on this machine"; replace with a capability check.
- `:32` — generalise the session-isolation rule to cover both tools. Chrome DevTools MCP can attach to a Chrome the developer is actively using (their profile, cookies, logged-in sessions), and two worktrees collide on one instance / debug port.
- `:299` — retitle "Resolve Playwright Session" → a tool-selection step, keeping session/instance resolution beneath it.
- Sweep for consistency afterwards: `targets/*/rules/{mcp-servers,testing,research-tools}.md`, `targets/*/{commands,skills}/spec-implement*`, `targets/opencode/AGENTS.md`, `README.md`.

**Definition of Done:**

- [x] Zero occurrences of "Chrome is not installed on this machine" in either target — replaced with a runnable capability check
- [x] Both `playwright-cli.md` files name Chrome DevTools MCP as viable (4 mentions each) and remain byte-identical to each other
- [x] Step 3.9a is tool-neutral in both targets — retitled "Select Browser Tool and Isolate the Instance"
- [x] Browser-isolation requirement stated once, covering both tools — one "Browser Instance Isolation" table with a row per tool
- [x] Parity test passes; `target-assets.test.ts` passes
- [x] **Consistency sweep done:** `rules/testing.md` and `rules/verification.md` (both targets) softened from "use playwright-cli" to "use a browser-automation tool with instance isolation". `rules/{mcp-servers,research-tools}.md`, `spec-implement*`, `targets/opencode/AGENTS.md` and `README.md` were checked and contain **no** playwright/E2E exclusivity language, so they needed no change.
- [x] **Amended post-review — `testing.md` added to the parity guard.** The sweep edited it in both targets but the guard's `IDENTICAL_RULES` allowlist was not extended, leaving the pair free to drift. See Task 1.

---

### Post-review amendment: D10 framing restored to the condensed blocks

The full 4-point block landed in `spec-verify` and `rules/verification.md` (both targets), but the **condensed** variants in `spec-bugfix-verify` and `spec-implement` kept the `.env` clause, the PID rule and the port rule while dropping point 2's *shared-state determination* — the framing that is the entire point of this phase. Not an inversion (nothing anywhere told the agent to prompt on every run), but an agent reading only `spec-implement` never got it.

Added identically to all four files (`spec-bugfix-verify` + `spec-implement`, both targets):

> Otherwise **determine what this run shares** — database, cache, queue, running processes. **State plainly what is shared and proceed**; do not stop to ask on every run.

Parity baselines are **unchanged** (the edit is byte-identical on both sides), and `bun test src/cli/` stays green.

**Verify:**

- `bun run embed-assets && bun test src/cli/`
- `! rg -q 'Chrome is not installed' targets/`
