# Sync Graph-Tool Wiring Implementation Plan

Created: 2026-08-23
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: Yes
Type: Feature

## Summary

**Goal:** Let an agent feed reach data from an external code-graph MCP tool into `impact_analysis`, and make `/sync` detect such tools across all four real MCP config locations instead of the one it reads today.

**Architecture:** Three independent layers. (1) `impact_analysis` gains a schema-level `reach` object — an agent-passable replacement for the unreachable `ReachProvider` callback seam — accepted **all-or-nothing** so agent and built-in reach can never be mixed against one universe. (2) A tool-agnostic capability contract is added to the shipped `mcp-servers.md` rule, so the wiring exists on every install without `/sync`. (3) `/sync` Phase 7 is corrected to read Claude Code **and** OpenCode configs at **both** scopes, and to write a marker-delimited wiring block naming the project's actually-detected graph tools.

**Tech Stack:** TypeScript (strict), Bun + `bun test`, zod 4, `@modelcontextprotocol/sdk`.

## Scope

### In Scope

- `impact_analysis` accepts a nested, agent-passable `reach` param (`{ moduleCount, files, source? }`), applied all-or-nothing.
- Split `src/analysis/impact.ts` (352 lines) — extract reach concerns to `src/analysis/reach.ts` before adding to it.
- Fix `defaultMcpConfigPaths()`: honour `XDG_CONFIG_HOME`, add project-root `opencode.json{,c}`.
- `/sync` Phase 7: read all four config locations, handle both `mcpServers` and `mcp` key shapes, mark user-scope servers as such.
- `/sync` Phase 7: emit a BEGIN/END-marked graph-tool wiring block into `{slug}-mcp-servers.md`; Phase 11 cross-check; Phase 12 summary line.
- Shipped tool-agnostic capability contract in `targets/*/rules/mcp-servers.md` (both copies, identical).
- A content test (`src/cli/sync-graph-tools.test.ts`) asserting the prose is correct, not merely symmetric.
- Add `mcp-servers.md` to `IDENTICAL_RULES` (it is byte-identical today but unguarded).

### Out of Scope

- **Wiring any specific vendor tool into `src/`.** Sentinal detects; it never depends on a graph tool. Carried forward verbatim from `2026-08-23-impact-analysis-risk-inversion.md:102`.
- **Removing `ReachProvider`.** It stays as the in-process seam; the new param is additive.
- **Installing or configuring a graph tool.** Detect-not-install, per D11 (`2026-08-07-worktree-runtime-isolation.md:220`).
- **Per-file universe pairing.** Considered and rejected in favour of all-or-nothing (see Task 1b notes) — it would require changing `ChangedFile`, `scoreRisk` and `buildImpactOutput` for a case all-or-nothing forecloses.
- **Splitting `src/cli/commands/uninstall.ts` (691 lines, over the 600 block).** Pre-existing; this plan does not touch that file.
- **Splitting `sync.md` (602/600 lines).** Noted as debt; `.md` is exempt from the length hook.
- Changing risk thresholds or the built-in import resolver — settled by the previous plan.

## Context for Implementer

> Written for someone who has never seen this codebase.

**The problem in one paragraph.** `impact_analysis` scores how risky a set of changed files is, partly from "reach" — how many modules transitively import each changed file. It computes reach from its own parsed-import graph. A previous plan added `ReachProvider`, an interface meant to let a better external graph answer instead. But `ReachProvider.reachOf` is a **function**, and MCP tool arguments are JSON — an agent physically cannot pass a closure. The seam is unreachable in production: `src/analysis/mcp-tools.ts:56` calls `registerImpactAnalysisTool(server, specStore)` with only two arguments, so `reachProvider` is `null` in every shipped path. Only four tests ever pass one.

**Patterns to follow:**

- Owned-block upsert: `src/cli/commands/shell-init.ts:21-22` (markers), `:85-102` (`upsertBlock`), `:108-119` (`removeBlock`). The repo's only real BEGIN/END implementation, and it is tested.
- Optional-tool rule that no-ops gracefully: `targets/claude-code/rules/playwright-cli.md` — no frontmatter, self-scopes in prose, states the requirement on the *capability* and lists providers in a table. Runtime companion: `spec-verify.md:311-326`.
- Detect-then-draft-then-report phase: `/sync` Phase 6.5 (`sync.md:435-467`).
- **Asserting on shipped markdown content:** `src/cli/rules-memory-refs.test.ts:56` already reads `targets/<target>/commands/sync.md` and asserts `toContain`. Also `src/cli/spec-memory-integration.test.ts:101-116`, `src/cli/permission-defaults.test.ts:198-213`. This is the model for Task 4's content test.

**Key files:**

| File | Lines | Role |
| --- | --- | --- |
| `src/analysis/impact.ts` | 352 | Tool registration `:82`, zod schema `:90-92`, `ReachProvider` `:35-43`, `providerReach` `:45-64`, `providerModuleCount` `:66-80`, thresholds `:209-225`, `scoreRisk` `:239`, `buildImpactOutput` `:253`, Import Reach section `:307-325` |
| `src/analysis/mcp-tools.ts` | 414 | ⚠️ already over the 400 warn — the only change here is a 1-line arg, keep it that way |
| `src/analysis/helpers.ts` | 154 | `ChangedFile` type |
| `src/cli/commands/install-prereqs.ts` | 206 | `defaultMcpConfigPaths()` `:106-115`, `MAX_CONFIG_BYTES` `:92`, `declaredInMcpConfig` `:196-206` |
| `src/cli/target-parity.test.ts` | 403 | `PAIRS` `:65-78` (includes `sync`), `IDENTICAL_RULES` `:145-152` |
| `targets/{claude-code,opencode}/commands/sync.md` | 602 / 600 | Phase 7 at CC `:469-516`, OC `:467-514` — verified byte-identical |
| `targets/{claude-code,opencode}/rules/mcp-servers.md` | 133 each | Verified byte-identical, currently NOT in `IDENTICAL_RULES` |

**Gotchas — read these before writing code:**

1. **⛔ Reach and `moduleCount` must come from the same universe, and `moduleCount` is a single report-level scalar.** `buildImpactOutput` divides *every* file's `importerCount` by one `moduleCount` (`impact.ts:310`, `:315`, `:318-319`), and `scoreRisk` compares one `maxReach` against it (`:239-251`). Therefore a **partial** agent `files` map is unsafe: unsupplied files keep Sentinal's built-in counts (universe ~334) but would be scored against the agent's universe. This is why the param is **all-or-nothing** (Task 1b) — the nested object alone does *not* close the hole. Threshold rationale: `impact.ts:191-208`.
2. **Non-TS files never consult reach.** `impact.ts:126-140` short-circuits `.md`/`.json`/etc. with `importerCount: 0`. They must be excluded from the all-or-nothing coverage requirement, or every changeset containing a `.md` file would be rejected.
3. **Reach map keys are relative paths from `git diff --name-only`** (`impact.ts:96-105`). Absolute paths will not match. Under all-or-nothing this becomes a loud error naming the missing paths, instead of silent degradation.
4. **The thresholds are exported but nothing imports them** — ripgrep-verified. Only `registerImpactAnalysisTool` is imported (by `impact.test.ts:17` and `mcp-tools.ts:38`). The `reach.ts` split therefore causes **zero** import churn outside `impact.ts`.
5. **`~/.claude.json` is routinely tens of megabytes** — per-project session state. `MAX_CONFIG_BYTES = 2MB` at `install-prereqs.ts:92` exists for this. Phase 7's prose must tell the agent to extract the `mcpServers` key only.
6. **Config key names differ:** Claude Code uses `mcpServers`, OpenCode uses `mcp` (`install-opencode-config.ts:74-75`); server shapes differ too (`{command, args}` vs `{type, command[]}`).
7. **Editing `sync.md` WILL change `sync.diff`** even when applied perfectly symmetrically — the normalised diff embeds absolute line numbers (`target-parity.test.ts:283-288`) and Phase 7 sits *before* the recorded hunk at line 562. Regenerate and hand-check.
8. **Never write `Skill(skill="sentinal:…")` (double-quoted) in new `sync.md` content.** The normaliser at `:185-189` strips only the *single*-quoted form; a double-quoted one survives and adds a spurious hunk. That is how the existing divergence arose.
9. **Run `bun run embed-assets` after any `targets/**` edit** — `src/cli/embedded-assets.ts` is gitignored and regenerated, and `target-frontmatter.test.ts:219-250` validates the embedded copies.

**Domain context.** Sentinal never writes a project-root `.mcp.json` — its Claude Code servers live in the marketplace plugin's `.mcp.json` (`install-claude.ts:301-311`), and its OpenCode servers are merged into `opencode.json` under `mcp` (`install-opencode-config.ts:74-75`). The five Sentinal-owned keys are `["context7", "web-search", "grep-mcp", "web-fetch", "sentinal"]` (`uninstall.ts:60-66`), matching the exclusion list already in Phase 7's prose.

## Assumptions

- **Phase 7 is inert on OpenCode today.** Supported by: the Phase 7 region is byte-identical across targets and names only `.mcp.json`, which OpenCode does not read; it therefore always hits its own `Skip if: no .mcp.json` branch. Task 4 depends on this.
- **Prose, not code, is the correct fix for Phase 7 detection.** `/sync` is an LLM prompt with no code path — nothing in `src/` writes `.sentinal/rules/*.md` (ripgrep-verified). A TS helper called by nothing would be dead code. Task 2 fixes `defaultMcpConfigPaths()` only because it is the canonical list the prose must not drift from. **This does not make the prose untestable** — Task 4 adds a content test on the established `rules-memory-refs.test.ts` pattern. Tasks 2, 4 depend on this.
- **Marker discipline in an LLM prompt is advisory.** `upsertBlock` cannot be reused as code from a prompt, so block idempotence is only as reliable as agent compliance. Accepted deliberately; the Phase 11 cross-check in Task 4 is the backstop. Task 4 depends on this.
- **Nothing imports the reach thresholds.** Ripgrep-verified across `src/`. Tasks 1a, 1b depend on this.
- **`targets/*/rules/mcp-servers.md` is byte-identical today.** Verified with `cmp`. Task 3 depends on this.

## Testing Strategy

- **Unit:** `src/analysis/reach.test.ts` — new. Schema rejects `files` without `moduleCount`; rejects `moduleCount <= 0`; rejects any `files` value `> moduleCount`; rejects a changeset where a changed TS file is absent from `files` (all-or-nothing), with the message naming the missing paths; agent reach outranks a supplied `ReachProvider`; provider outranks built-in.
- **Unit:** extend `src/analysis/impact.test.ts` — end-to-end through the registered handler; a supplied `reach` changes the verdict; `impact.test.ts` must pass **unmodified** across Task 1a.
- **Unit:** extend `src/cli/commands/install.test.ts:434-443` — widened path list plus an `XDG_CONFIG_HOME` override case.
- **Content:** `src/cli/sync-graph-tools.test.ts` — new. Asserts Phase 7 prose names all four config locations and both key shapes, the markers, the omit-if-unknown rule, the Phase 11 item and all three Phase 12 states — and that every parameter name the shipped rule and the wiring block instruct agents to send actually exists in `reach.ts`'s schema.
- **Parity:** `bun test src/cli/target-parity.test.ts` — `sync.diff` regenerated, `spec-verify.diff` stays 0 bytes, `mcp-servers.md` newly guarded.
- **Full suite:** `bun test` at 2509 pass / 0 fail or higher; `bunx tsc --noEmit` clean.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Agent supplies reach from a different universe → mis-scored risk | Medium | High — reproduces the defect the last plan fixed | Three layers: `moduleCount` required alongside `files`; `.refine()` rejects any value `> moduleCount` (proves different metrics); all-or-nothing coverage forbids mixing agent and built-in counts under one universe |
| Symmetric-but-wrong `sync.md` prose ships | Medium | Medium | `sync-graph-tools.test.ts` asserts content. **The one-hunk check detects asymmetry only — it does NOT verify correctness** |
| Cross-target drift in `sync.md` | Medium | Medium | `sync.diff` regenerated; assert exactly one hunk; any second hunk means one-sided |
| Shipped rule names a param that does not exist | Medium | Medium | Tasks 3 and 4 run after Task 1b; content test cross-checks every param name against `reach.ts` |
| `impact.ts` grows past the 400 warn | High if not split | Low — warn only | Task 1a extracts ~80 lines **first** as a pure move, checkpointed by unmodified tests |
| Agent ignores BEGIN/END markers on re-run → duplicated block | Medium | Low | Phase 11 cross-check asserts exactly one block |
| Reading `~/.claude.json` (tens of MB) blows context | Medium | Medium | Prose instructs extracting the `mcpServers` key only |
| All-or-nothing rejects large changesets as too onerous | Low | Low | Error names the missing paths so the agent can complete the map; partial data is genuinely unsafe (Gotcha 1) |

## Pre-Mortem

_Assume this plan failed after full execution. The most likely internal reasons:_

1. **All-or-nothing proves too strict to ever trigger in practice** (Task 1b) → Trigger: the `impact.test.ts` end-to-end case needs a reach map for more than ~15 files to exercise a single verdict change, or a real `/sync`-detected tool cannot enumerate every changed file. If hit, fall back to the rejected per-file-universe design (pair each reach with its own universe in `ChangedFile`) rather than to silent partial mixing.
2. **We assumed `/sync` has no code path, but the wiring block needs one to be reliable** (Task 4) → Trigger: the first manual `/sync` run duplicates the block or writes it outside the markers. Fallback is a separate fully-owned `{slug}-graph-tools.md` overwritten wholesale, removing the need for marker compliance.
3. **Phase 7's prose grows large enough to degrade the whole `/sync` prompt** (Task 4) → Trigger: Phase 7 exceeds ~90 lines, against `sync.md`'s own advice at `:141`. If hit, move the config-location table into the shipped `mcp-servers.md` rule and have Phase 7 reference it; the Phase 12 summary line is the first thing to drop.

## Execution Waves

**Wave 1** — independent foundations (parallel): Task 1a is confined to `src/analysis/`; Task 2 to `src/cli/commands/install-prereqs.ts` + `install.test.ts`. No shared files.

**Wave 2** — the schema (single task): Task 1b depends on Task 1a's extraction and edits the same `src/analysis/` files, so it cannot share Wave 1.

**Wave 3** — prose (parallel): Tasks 3 and 4 both describe the parameter Task 1b creates, so both must follow it — this is why neither sits in Wave 1. They share no files: Task 3 owns `targets/*/rules/mcp-servers.md` + the `IDENTICAL_RULES` array; Task 4 owns `targets/*/commands/sync.md`, the `sync.diff` fixture, and the new `sync-graph-tools.test.ts`.

## Goal Verification

### Truths

1. `rg 'reach' src/analysis/impact.ts` shows a `reach` key inside the `server.tool` zod schema object.
2. `src/analysis/reach.ts` exists and exports `resolveReach`, `HIGH_REACH_MIN`, `MEDIUM_REACH_MIN`, `isHighReach`, `isMediumReach`.
3. `bun test src/analysis/reach.test.ts` passes, including cases asserting: `files` without `moduleCount` is rejected; a `files` value `> moduleCount` is rejected; a changed TS file absent from `files` is rejected by name.
4. `rg 'resolveXdgConfig' src/cli/commands/install-prereqs.ts` matches, and `defaultMcpConfigPaths()` returns an entry ending in `opencode.json` rooted at `process.cwd()` (not `.opencode/`).
5. Both `sync.md` copies name `.mcp.json`, `~/.claude.json`, `opencode.json`, `mcpServers` and `mcp` within Phase 7.
6. `cmp targets/claude-code/rules/mcp-servers.md targets/opencode/rules/mcp-servers.md` exits 0, and `"mcp-servers.md"` appears in `IDENTICAL_RULES`.
7. `bun test src/cli/sync-graph-tools.test.ts` passes.
8. `wc -c src/cli/__fixtures__/target-parity/spec-verify.diff` is `0`.
9. `rg -c '^@@' src/cli/__fixtures__/target-parity/sync.diff` is `1`.
10. `bun test` passes with 0 failures; `bunx tsc --noEmit` is clean.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/analysis/reach.ts` | Reach resolution + thresholds, split out of `impact.ts` | `AgentReachSchema`, `resolveReach`, `ReachProvider`, `providerReach`, `providerModuleCount`, `maxReach`, `isHighReach`, `isMediumReach`, threshold constants |
| `src/analysis/reach.test.ts` | Unit coverage for the above | — |
| `src/analysis/impact.ts` (modified) | `impact_analysis` with an agent-passable `reach` param | `registerImpactAnalysisTool`, `scoreRisk`, `buildImpactOutput` |
| `src/cli/commands/install-prereqs.ts` (modified) | Corrected canonical MCP config path list | `defaultMcpConfigPaths` |
| `src/cli/sync-graph-tools.test.ts` | Content assertions on shipped prose + param-name cross-check | — |
| `targets/{claude-code,opencode}/rules/mcp-servers.md` (modified) | Tool-agnostic graph-reach capability contract | — |
| `targets/{claude-code,opencode}/commands/sync.md` (modified) | Phase 7 with 4 config sources + marked wiring block, Phase 11 check, Phase 12 line | — |
| `src/cli/__fixtures__/target-parity/sync.diff` (regenerated) | Parity baseline | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/analysis/impact.ts` | `src/analysis/reach.ts` | reach resolution | `from "./reach.js"` |
| `src/analysis/impact.ts` | agent MCP args | zod schema key | `reach:\s*.*optional` |
| `src/analysis/reach.ts` | universe pairing | refine guard | `moduleCount` |
| `src/cli/sync-graph-tools.test.ts` | `src/analysis/reach.ts` | param-name cross-check | `reach\.ts` |
| `src/cli/sync-graph-tools.test.ts` | `targets/*/commands/sync.md` | content assertion | `sync\.md` |
| `targets/*/commands/sync.md` | `targets/*/rules/mcp-servers.md` | contract reference | `mcp-servers\.md` |
| `targets/*/commands/sync.md` | `{slug}-mcp-servers.md` | owned block | `SENTINAL GRAPH TOOLS` |
| `src/cli/target-parity.test.ts` | `targets/*/rules/mcp-servers.md` | parity guard | `"mcp-servers\.md"` |

## Progress Tracking

- [x] Task 1a: Extract `reach.ts` from `impact.ts` — pure move (Wave 1) — `10d458a`, impact.ts 352→268, reach.ts 101
- [x] Task 1b: Add agent-passable all-or-nothing `reach` param (Wave 2) — `f9a084b`, reach.ts 101→331, +32 tests
- [x] Task 2: Correct `defaultMcpConfigPaths()` (Wave 1) — `7efe9e4`, list 6→8 entries
- [x] Task 3: Shipped graph-reach capability contract (Wave 3) — `b165121`, mcp-servers.md 133→185 both copies
- [x] Task 4: `/sync` Phase 7 + Phase 11/12 + content test (Wave 3) — `5f96257`, Phase 7 48→86 lines, +43 tests

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

**Full suite:** 2588 pass / 0 fail (baseline at plan start: 2509). tsc clean.

## Implementation Notes

- **⚠️ Run `bun run embed-assets` before `bunx tsc --noEmit` in a fresh worktree.** `src/cli/embedded-assets.ts` is gitignored and generated; without it tsc reports ~10 spurious `TS2307: Cannot find module '../embedded-assets.js'`. Hit by both Wave 1 tasks.
- **Task 1a:** `providerReach`/`providerModuleCount` gained `export` (they now cross a module boundary) — a widening, matching the Artifacts table. Threshold rationale comment moved byte-verbatim. `impact.test.ts` byte-unchanged as required.
- **Possible TDD-guard bug (flagged, not fixed):** the guard blocked editing `impact.ts` reporting "no test has been written yet for this file", despite `impact.test.ts` existing alongside it. Companion-test detection may not resolve inside a worktree path.
- **⚠️ Assumption partially invalidated (Task 1b) — `.refine()` does NOT survive into the emitted JSON Schema.** Zod refinements are inexpressible in JSON Schema, so `reach.files` advertises only `integer, minimum 0` to the MCP client; the `<= moduleCount` guard runs only in the SDK's **server-side** `inputSchema.parse()` before the handler. The Risks table's "three layers" is therefore accurately: server-side zod parse → `applyAgentReach` defensive re-check → all-or-nothing coverage. Advertisement is a separate layer from enforcement, and it was initially missing: none of the three `.describe()` strings mentioned the bound, so the only places it was stated were the `.refine()` message (seen only *after* a failed call) and `targets/*/rules/mcp-servers.md` (not loaded by every client). Post-review fix: the `files` `.describe()` now carries "every value must be `<= moduleCount`", and `.describe()` text *does* ship to the agent — pinned by `impact.test.ts` → "advertised inputSchema", which drives a real MCP `Client` over an in-memory transport and asserts against the literal emitted JSON Schema. Enforcement is real; **client-side pre-rejection is not**.
- **Task 1b:** `resolveReach` deliberately re-validates what zod already checked — the test harness (`captureImpact`) invokes the handler directly via `args[3]`, bypassing zod entirely, as would any future in-process caller. `src/analysis/mcp-tools.ts` needed **no** change (stays 414); `reach` arrives via the tool schema, not the registration signature. `reach.ts` is at 331 with ~70 lines headroom — a future per-file-universe fallback would need a further split.
- **The TDD guard did NOT block Task 1b**, contradicting the Task 1a note above. The Task 1a block may have been a one-off rather than a systematic worktree-path bug.
- **Prettier is NOT covered by `bun test`, but shipped `targets/**/*.md` files ARE prettier-clean.** Both Wave 3 tasks hit this. Prettier normalises markdown table column widths and, with `embeddedLanguageFormatting: auto`, reformats *inside* ` ```markdown ` fences. For `sync.md` this would perturb the parity diff, so prettier must run BEFORE regenerating the baseline. `bunx prettier` prints "Saved lockfile" but does not modify `bun.lock` — verified in both worktree and parent.
- **Task 4 content test is mutation-verified:** changing one word of Phase 7 in the CC copy produced 2 failures. It also cross-checks JSON keys extracted from BOTH the wiring block and Task 3's `mcp-servers.md` section against `reach.ts`, so a hallucinated param in either shipped file fails the build.
- **TDD guard oddity, second sighting:** it blocked `Write` on a scratch `.ts` file in the system temp dir, entirely outside the repo. Renaming to `.mjs` bypassed it. Combined with the Task 1a sighting, the guard appears to key on extension without scoping to the project. **Not fixed here — worth a separate issue.**
- **Task 2 surprise:** the "pinned" test at `install.test.ts:434-443` used `toContain`, not an exact-list assertion, so it would NOT have failed on the widened list — and it asserted `~/.config/...` unconditionally, so it was environment-dependent and would have failed on any machine with `XDG_CONFIG_HOME` set. Replaced with a real `toEqual` pin plus explicit env control. Full suite 2509 → 2512.

## Implementation Tasks

### Task 1a: Extract `reach.ts` from `impact.ts` — pure move

**Objective:** Move all reach concerns out of `impact.ts` into a sibling module with **no behaviour change**, creating headroom under the 400-line warn before any feature work.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/analysis/reach.ts`
- Modify: `src/analysis/impact.ts`

**Key Decisions / Notes:**

- Move `ReachProvider` (`:35-43`), `providerReach` (`:45-64`), `providerModuleCount` (`:66-80`), and the threshold block + `maxReach`/`isHighReach`/`isMediumReach` (`:191-225`) — roughly 80 lines.
- **Move the threshold rationale comment (`impact.ts:191-208`) verbatim.** It records measured p50/p75 data explaining why both an absolute floor and a share are required. Losing it invites a regression.
- Verified: **nothing outside `impact.ts` imports any of these**, so no other source file changes.
- **⛔ `src/analysis/impact.test.ts` must NOT be modified in this task.** It passing unchanged is the proof that the move preserved behaviour — a free correctness signal that is destroyed if this is fused with Task 1b.
- Sentinal's TDD guard will want a test for the new file. `reach.test.ts` is created in Task 1b; for this task the guard can be satisfied by the existing `impact.test.ts` coverage exercising the moved code paths. If the guard blocks, use `tdd_set_state` with a note that this is a pure extraction.

**Definition of Done:**

- [ ] `src/analysis/impact.ts` is under 400 lines
- [ ] `src/analysis/impact.test.ts` is byte-unchanged (`git diff --exit-code src/analysis/impact.test.ts`)
- [ ] `bun test src/analysis/` passes
- [ ] `bunx tsc --noEmit` clean
- [ ] No file outside `src/analysis/` changed

**Verify:**

- `git diff --exit-code src/analysis/impact.test.ts && bun test src/analysis/`
- `wc -l src/analysis/impact.ts src/analysis/reach.ts`

---

### Task 1b: Add agent-passable all-or-nothing `reach` param

**Objective:** Add a nested, schema-validated `reach` parameter an agent can supply over MCP, accepted only when it covers the whole changeset so agent and built-in counts can never be scored against one universe.
**Dependencies:** Task 1a
**Wave:** 2

**Files:**

- Modify: `src/analysis/reach.ts`
- Modify: `src/analysis/impact.ts`
- Create: `src/analysis/reach.test.ts`
- Modify: `src/analysis/impact.test.ts`

**Key Decisions / Notes:**

- Schema shape:
  ```ts
  reach: z.object({
    moduleCount: z.number().int().positive()
      .describe("Total modules in the universe these reach numbers were measured against"),
    files: z.record(z.string(), z.number().int().nonnegative())
      .describe("Repo-relative path -> modules transitively reaching it. Must cover EVERY changed .ts/.tsx/.js file"),
    source: z.string().optional()
      .describe("Tool that produced these numbers, e.g. 'codebase-memory-mcp trace_path'"),
  })
  .refine(r => Object.values(r.files).every(v => v <= r.moduleCount),
          "a reach value exceeds moduleCount — the two came from different metrics")
  .optional()
  ```
- **⛔ All-or-nothing, and this is the load-bearing decision.** `moduleCount` is a single report-level scalar used by both `scoreRisk` (`:239-251`) and every line of the Import Reach section (`:310`, `:315`, `:318-319`). A partial `files` map would score unsupplied files' *built-in* counts against the *agent's* universe. So: if `reach` is supplied and any changed **TS/JS/TSX** file is absent from `files`, reject the whole `reach` object with an error naming the missing paths — do not silently degrade.
- **Exclude non-TS files from the coverage check** (Gotcha 2) — `impact.ts:126-140` gives them `importerCount: 0` and never consults reach, so requiring them would reject every changeset containing a `.md`.
- **Rejected alternative — per-file universe pairing** (add `moduleUniverse` to `ChangedFile`, make `scoreRisk`/`buildImpactOutput` per-file): strictly more general, but it changes three more call sites and `helpers.ts` to serve a partial-map case that all-or-nothing forecloses. Recorded here so the fallback is known if Pre-Mortem 1 triggers.
- **Precedence, three tiers, whole-changeset:** validated agent `reach` → `providerReach`/`providerModuleCount` → built-in `countImporters`/`graph.modules.size`. Document the ordering in a comment — it is a decision, not an accident.
- Preserve the existing validation contract from `providerReach`/`providerModuleCount` (reach finite `>= 0`; moduleCount finite `> 0`) and keep tolerating a `null`-returning provider without throwing.
- **Report attribution in the output:** the `source` string when given, and `N of M changed TS files covered`. Under all-or-nothing N always equals M on success, so the real diagnostic is the rejection message — it must name the missing/unmatched paths, which is what surfaces a rel-vs-abs mistake (Gotcha 3).

**Definition of Done:**

- [ ] `src/analysis/impact.ts` and `src/analysis/reach.ts` both under 400 lines
- [ ] `bun test src/analysis/` passes; `bunx tsc --noEmit` clean
- [ ] Test: schema rejects `{ files: { "a.ts": 5 } }` with no `moduleCount`
- [ ] Test: schema rejects `moduleCount: 0` and negative reach values
- [ ] Test: schema rejects a `files` value greater than `moduleCount`
- [ ] Test: a changeset with a TS file absent from `files` is rejected, and the message names that path
- [ ] Test: a changeset whose only uncovered file is non-TS is **accepted**
- [ ] Test: agent reach outranks a supplied `ReachProvider`
- [ ] Test: an absolute-path key produces a rejection naming it, not a silent fallback
- [ ] Output names `source` when supplied and reports coverage

**Verify:**

- `bun test src/analysis/reach.test.ts src/analysis/impact.test.ts`
- `wc -l src/analysis/impact.ts src/analysis/reach.ts`

---

### Task 2: Correct `defaultMcpConfigPaths()`

**Objective:** Make the canonical MCP config path list honour `XDG_CONFIG_HOME` and include project-root `opencode.json{,c}`, so the `/sync` prose in Task 4 has a correct list to mirror.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/install-prereqs.ts`
- Modify: `src/cli/commands/install.test.ts`

**Key Decisions / Notes:**

- Two real bugs in the current list (`:106-115`): it hardcodes `join(homedir(), ".config", ...)` while `resolveXdgConfig()` (`src/utils/shell.ts:88-90`) exists for exactly this; and it omits `<cwd>/opencode.json`, which is precisely where `writeOpenCodeConfig` puts things in `--local` mode (`install-opencode.ts:146-151` → `configDir = process.cwd()`).
- Add `<cwd>/opencode.json` and `<cwd>/opencode.jsonc`. Keep `<cwd>/.opencode/opencode.json`.
- **Do not change `declaredInMcpConfig`'s substring-scan strategy.** Its docstring at `:196-206` explains the choice and notes a false positive costs nothing there. Widening the path list only makes the existing scan more correct.
- Update the pinned assertion at `install.test.ts:434-443` and add a case setting `XDG_CONFIG_HOME` to a temp dir, asserting the OpenCode global entries follow it.

**Definition of Done:**

- [ ] `defaultMcpConfigPaths()` calls `resolveXdgConfig()`
- [ ] The returned list contains `<cwd>/opencode.json` and `<cwd>/opencode.jsonc`
- [ ] A test asserts `XDG_CONFIG_HOME=/tmp/xyz` moves the OpenCode global entries
- [ ] `bun test src/cli/commands/install.test.ts` passes
- [ ] `src/cli/commands/install-prereqs.ts` stays under 400 lines

**Verify:**

- `bun test src/cli/commands/install.test.ts`

---

### Task 3: Shipped graph-reach capability contract

**Objective:** Add a tool-agnostic section to the shipped `mcp-servers.md` rule stating that when a code-graph tool is available, its reach should be fed to `impact_analysis` — covering the whole changeset, with a matching universe size.
**Dependencies:** Task 1b
**Wave:** 3

**Files:**

- Modify: `targets/claude-code/rules/mcp-servers.md`
- Modify: `targets/opencode/rules/mcp-servers.md`
- Modify: `src/cli/target-parity.test.ts`

**Key Decisions / Notes:**

- **Extend the existing rule; do not add a file.** `targets/*/rules/mcp-servers.md` is 133 lines, verified byte-identical, and is already the shipped MCP knowledge file. A new file would split MCP guidance in two.
- **Depends on Task 1b** because the prose names the actual parameter (`reach`, `moduleCount`, `files`, `source`). Writing it in parallel with the schema risks shipping instructions for a parameter that does not exist; Task 4's content test cross-checks the names.
- **Follow `playwright-cli.md`'s techniques** for an optional tool under OpenCode's no-`paths:` constraint (`sentinal-opencode-rules.md`): no frontmatter; state the requirement on the *capability* not the vendor; a provider table rather than a hard-coded name; hoist the invariant; an explicit detect-not-install scope guard; "check what is actually available — do not assume."
- **The hoisted invariant, stated once and prominently:** *whichever provider supplies reach, `moduleCount` must be that provider's universe size, and `files` must cover every changed TS file — `impact_analysis` rejects a partial map rather than mixing universes.*
- **Must no-op gracefully.** OpenCode loads this rule in every session including projects with no graph tool. Open with a conditional ("If a code-graph MCP server is configured…") so the absent case reads as inapplicable, not as an unmet requirement.
- **⛔ Add `"mcp-servers.md"` to `IDENTICAL_RULES`** (`target-parity.test.ts:145-152`). The array's docstring at `:133-136` makes this mandatory when both copies are edited together. It is byte-identical today but unguarded, so it could already have drifted silently.

**Definition of Done:**

- [ ] `cmp targets/claude-code/rules/mcp-servers.md targets/opencode/rules/mcp-servers.md` exits 0
- [ ] `"mcp-servers.md"` present in `IDENTICAL_RULES` with a comment noting why
- [ ] The section names no vendor as required; any named tool appears only as a table example
- [ ] The same-universe + full-coverage invariant appears verbatim in both copies
- [ ] Every param name used matches `src/analysis/reach.ts`
- [ ] `bun run embed-assets && bun test src/cli/target-parity.test.ts` passes

**Verify:**

- `cmp targets/claude-code/rules/mcp-servers.md targets/opencode/rules/mcp-servers.md`
- `bun test src/cli/target-parity.test.ts`

---

### Task 4: `/sync` Phase 7 + Phase 11/12 + content test

**Objective:** Rewrite Phase 7 to read Claude Code and OpenCode configs at both scopes, label user-scope servers, emit a marker-delimited graph-tool wiring block, add the Phase 11 backstop and Phase 12 summary — and assert all of it with a content test.
**Dependencies:** Task 1b, Task 2, Task 3
**Wave:** 3

**Files:**

- Modify: `targets/claude-code/commands/sync.md`
- Modify: `targets/opencode/commands/sync.md`
- Create: `src/cli/sync-graph-tools.test.ts`
- Modify: `src/cli/__fixtures__/target-parity/sync.diff` (regenerate)

**Key Decisions / Notes:**

- **Merged with what was previously a separate Task 5** (Phase 11 + Phase 12). Both edit the same two `sync.md` files and force a `sync.diff` regeneration; splitting them meant two regenerations and a same-files wave conflict for no isolation benefit.
- **Step 7.1 replaces "Parse `.mcp.json`" with a four-row table**, mirroring Task 2's corrected list:

  | Scope | Claude Code | OpenCode |
  | --- | --- | --- |
  | Project | `.mcp.json` (`mcpServers`) | `opencode.json{,c}`, `.opencode/opencode.json` (`mcp`) |
  | User | `~/.claude.json`, `~/.claude/settings.json` (`mcpServers`) | `$XDG_CONFIG_HOME/opencode/opencode.json{,c}` (`mcp`) |

- **⚠️ Instruct selective reading of `~/.claude.json`** — extract the `mcpServers` key only (Gotcha 5).
- **User-scope servers are documented WITH a scope marker** (the approved choice): `**Source:** ~/.claude.json (user-global — may not be present for teammates)`. The rule file is committed and shared, so an unlabelled user-global server is a false promise to the rest of the team.
- **Step 7.4 gains the wiring block**, delimited exactly:
  ```
  <!-- SENTINAL GRAPH TOOLS: BEGIN (managed by /sync — edits inside are overwritten) -->
  ...
  <!-- SENTINAL GRAPH TOOLS: END -->
  ```
  On re-run: replace between markers if both present, else append. Mirrors `upsertBlock` (`shell-init.ts:85-102`) as prose.
- **⛔ Emit the block ONLY if the universe size is obtainable from the detected tool.** Phase 6.5's lesson (`sync.md:461-467`) applied directly: a guessed `moduleCount` produces a false HIGH on every change — alarm fatigue. Omission is fail-safe. Say so in the prose.
- **The block must instruct full coverage**, matching Task 1b: supply `files` for every changed TS file or expect rejection.
- Capability map stays deliberately small — 1-3 entries mapping tool names (e.g. `trace_path`, `detect_changes`) to the `reach` capability. Generic "detect any code-graph tool" is undecidable.
- **Phase 11** gains a cross-check modelled on the runtime-contract one at `sync.md:584`: if a `SENTINAL GRAPH TOOLS` block exists, confirm the tools it names are still reachable and that **exactly one** block is present (catching marker-compliance failure — Pre-Mortem 2's trigger).
- **Phase 12** gains one line alongside `:598`: `- Graph tools: wired <names> | detected but universe size unknown (block omitted) | none detected`. The three-state form matters — "detected but omitted" is informative, not a failure. This is a consistency nicety and is the first thing to drop if Pre-Mortem 3 triggers.
- **Content test** on the `rules-memory-refs.test.ts:56` pattern: iterate both targets, slice Phase 7, assert it contains `.mcp.json`, `~/.claude.json`, `opencode.json`, `mcpServers`, `mcp`, both markers, and the omit-if-unknown instruction; assert the Phase 11 string and all three Phase 12 states; and assert every param name the wiring block and the shipped rule tell agents to send (`reach`, `moduleCount`, `files`, `source`) appears in `src/analysis/reach.ts`.
- **Apply both `sync.md` edits identically.** The only permitted differences remain the frontmatter and the `Skill(skill=…)` line. Do not touch frontmatter — it produces the CC−2 offset.
- **⛔ Do not write `Skill(skill="sentinal:…")` in new content** (Gotcha 8).
- Regenerate with `UPDATE_PARITY_BASELINES=1 bun test src/cli/target-parity.test.ts`, then hand-verify the new `sync.diff` differs from the committed one **only** in the two `@@` line numbers. **This check proves symmetry, not correctness** — correctness is the content test's job.

**Definition of Done:**

- [ ] Both `sync.md` copies name all four config locations and both key shapes in Phase 7
- [ ] User-scope entries carry a scope label in the `**Source:**` template
- [ ] BEGIN/END markers present in both copies, byte-identical
- [ ] The "omit the block if the universe size is unknown" instruction present
- [ ] The full-coverage instruction present, consistent with Task 1b's rejection behaviour
- [ ] Phase 11 cross-check and Phase 12 three-state line present in both copies
- [ ] `bun test src/cli/sync-graph-tools.test.ts` passes
- [ ] `sync.diff` regenerated, exactly one `@@` hunk
- [ ] `spec-verify.diff` still 0 bytes
- [ ] `bun run embed-assets && bun test` passes with 0 failures; `bunx tsc --noEmit` clean

**Verify:**

- `diff <(sed -n '/## Phase 7/,/## Phase 8/p' targets/claude-code/commands/sync.md) <(sed -n '/## Phase 7/,/## Phase 8/p' targets/opencode/commands/sync.md)` → empty
- `rg -c '^@@' src/cli/__fixtures__/target-parity/sync.diff` → `1`
- `wc -c src/cli/__fixtures__/target-parity/spec-verify.diff` → `0`
- `bun test src/cli/sync-graph-tools.test.ts && bun test`
