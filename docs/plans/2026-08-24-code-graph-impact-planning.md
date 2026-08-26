# Code-Graph Impact & Planning Implementation Plan

Created: 2026-08-24
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: Yes
Type: Feature

## Summary

**Goal:** Make Sentinal's impact analysis work in production, let it accept richer tool-agnostic data (multi-source reach and call sites), add a prospective `plan_impact` tool that analyses a plan before implementation, teach `/sync` to catalogue whatever code-exploration servers a project actually has, and join the two in `spec-plan` and `spec-implement`.

**Architecture:** Three layers. **Sentinal tools** own the data shape, validation and scoring, and stay vendor-generic. The **`/sync`-generated project rule** carries the tool-specific recipe — it may name a vendor because it is generated per-project from real smoke-testing and is never shipped. **Workflow prose** says "call `plan_impact`" and "consult the catalogue", never "call CBM".

**Tech Stack:** TypeScript (strict), Bun + `bun test`, zod 4, `@modelcontextprotocol/sdk`.

## Scope

### In Scope

- **Bug:** `impact_analysis` receives no `SpecStore` in production, so its entire spec-compliance half is inert.
- **Bug:** `extractSpecFiles` ignores `Test:` and does not strip backticks.
- **Bug:** `spec-implement` and `lsp-tools.md` tell OpenCode agents to call an `lsp` tool that target lacks.
- Pre-requisite splits: `src/spec/mcp-tools.ts` (681 — over the block), `src/sidecar/client.ts` (582).
- Per-task plan parser: Files + Wave + verb + on-disk existence.
- Multi-source injection surface with **single-primary scoring**, plus optional call sites.
- New `plan_impact` tool: same-wave overlap detection (deterministic) + prospective reach (advisory).
- `/sync`: capability catalogue, and an emitted recipe that matches the new schema.
- Wire the catalogue into **both** `spec-plan` and `spec-implement`.
- Threshold measurement — gated, may end with zero production change.

### Out of Scope

- **Implementing LSP call hierarchy inside Sentinal** (D3). Call sites arrive through the injection surface.
- **Multi-source *scoring*.** Multiple sources are accepted for reporting; exactly one scores. See D1.
- **Naming any vendor as required** in shipped `src/` or `targets/*/rules/`. Illustrative `e.g.` is permitted only where Task 5 explicitly keeps it.
- **Depending on cross-repo linking** — unverified (see Assumptions).
- Persisting per-task files to SQLite (`SpecTask`/`SpecTaskSchema` untouched).

## Key Decisions

**D1 — Exactly one source scores; the rest are reporting-only.** *This reverses the multi-source-scoring design of iteration 0.* Per-source universes make a reach and its universe travel together, which fixes **pairing** — but it does not make shares from different granularity models commensurable. Concretely: a module source (89/334 = 26.6%) says HIGH while a symbol source (200/8440 = 2.4%) says LOW for the *same file*, both internally valid. Max-of-shares means adding a server can only raise the verdict; min only lower it; declaration order is arbitrary. In every variant the risk verdict for identical code becomes a function of which servers happen to be installed. The 25% cutoff was derived in `ec642c6` from this repo's **module-level** distribution (p50 = 10/334, p75 = 82/334); nothing establishes it means anything in a symbol universe — which is exactly what the shipped rule already argues at `mcp-servers.md:177`. So: one source carries `primary: true` (or, absent that, the first) and produces the verdict; all others are accepted for attribution and call sites and are **explicitly rendered as unscored**. This also removes the ordering problem where Task 11's measurement would have arrived two waves after the scoring it was meant to justify.

**D2 — The new `reach` shape is additive, not a replacement.** The existing single-object form stays valid and is normalised internally to a one-element source list. Without this, every agent following the currently-shipped `mcp-servers.md` breaks the moment Task 5 lands.

**D3 — No LSP implementation in Sentinal.** Adding `prepareCallHierarchy`/`incomingCalls` needs a public generic `request()`, a capabilities declaration, and symbol→position resolution (~130 lines) on a file already at 502, forcing a split. And it would duplicate a capability Claude Code already exposes natively. Since call sites can be *injected*, Sentinal does not need to compute them. The tool stays generic and the platform does the work it is already good at.

**D4 — `plan_impact`'s two halves have different epistemic standing, and the output must say so.** Overlap detection asks whether the plan is internally consistent with its own stated rule (`spec-plan.md:220`) — a property of the plan text, true or false regardless of what implementation later touches, and it needs **no** injected source or graph tool. Prospective reach is bounded by the accuracy of the `Files:` prediction. They must not be presented with equal confidence.

## Context for Implementer

> Written for someone who has never seen this codebase.

### The two production bugs, precisely

**Bug 1 — no spec context under the sidecar.** Verified chain:

```
src/mcp/server.ts:43   const store = client ? null : (opts.store ?? new MemoryStore());
                       └─ production always has a client (server.ts:114) → store = null
src/analysis/mcp-tools.ts:52  effectiveStore = store ?? (client ? null : new MemoryStore())  → null
src/analysis/mcp-tools.ts:53  specStore = effectiveStore ? new SpecStore(...) : null          → null
src/analysis/impact.ts:68     specStore?.getCurrentSpec(project) ?? null                      → null
src/analysis/impact.ts:69-70  specFiles = new Set()   (empty, ALWAYS)
```

`scoreRisk` gates on `hasUnexpected = specFiles.size > 0 && ...`, permanently false. One of only two HIGH triggers is dead; unexpected-file warnings never render; `_Active spec:_` never prints. Correct behaviour occurs **only** when there is no sidecar — the fallback path, which is also the only path the tests exercise. That is why no test caught it.

`SidecarClient.getCurrentSpec()` exists (`src/sidecar/client.ts:497`); the tool never receives the client. The handler is already `async`.

**Bug 2 — `Test:` invisible, backticks unstripped.** `helpers.ts:84` matches `(?:Modify|Create|Delete|Rename|Add|Update)`; the template emits `- Test: \`path\`` (`spec-plan.md:192`). `helpers.ts:88` takes `.split(" ")[0]` and strips only `./` — **backticks survive on every verb, not just `Test:`**. Currently masked by Bug 1. Fixing Bug 1 **activates** Bug 2, and TDD guarantees each task touches its own test file, so a false "unexpected change" warning is certain, not merely likely. They must ship together.

### Key files

| File | Lines | Note |
| --- | ---: | --- |
| `src/spec/mcp-tools.ts` | **681** | 🔴 **OVER THE 600 BLOCK — edits blocked until split** |
| `src/sidecar/client.ts` | **582** | 🔴 18 lines headroom |
| `src/sidecar/lsp-client.ts` | 502 | Not touched (D3) |
| `src/analysis/mcp-tools.ts` | 414 | Over warn — registration edits only |
| `src/spec/parser.ts` | 386 | 14 from warn — do NOT add a Files branch; use a standalone parser |
| `src/analysis/reach.ts` | 331 | The injection surface |
| `src/analysis/impact.ts` | 283 | |
| `src/analysis/helpers.ts` | 154 | `ChangedFile`, `extractSpecFiles` |

### Gotchas

1. **`.refine()` is dropped by the zod→JSON-Schema converter** (pinned at `impact.test.ts:506-515`). Every constraint must ALSO be in `.describe()` or the agent never sees it.
2. **`spec_plan_parse` exposes neither per-task Files nor per-task Wave.** `SpecTask` has no `files`. `parser.ts`'s `wave` is plan-level master-plan front-matter, **not** the per-task `**Wave:**` at `spec-plan.md:186` — nothing parses that.
3. **The same-wave overlap rule is prose only.** `spec-plan.md:220` states it as a hard requirement; nothing enforces it. On OpenCode parallel tasks share one working directory, so a violation corrupts work.
4. **⛔ `UPDATE_PARITY_BASELINES=1` rewrites EVERY fixture in `src/cli/__fixtures__/target-parity/`,** not just the one you edited (`target-parity.test.ts:47` gates the whole suite). Two tasks regenerating concurrently in a shared working directory each bake in the other's half-finished edits, and "hunk count unchanged" then passes against a poisoned baseline. **Only one task per wave may regenerate.**
5. **`bun run embed-assets` before `bunx tsc --noEmit`** in a fresh worktree, or ~10 spurious `TS2307`.
6. **Never run `bunx prettier --write` project-wide or call `quality_report`.** Repo is not prettier-clean at HEAD; project-wide write reformats ~85 unrelated files. Shipped `targets/**/*.md` ARE prettier-clean — run prettier on them BEFORE regenerating baselines.
7. **Adding an MCP tool triggers a mandatory checklist** (`.sentinal/rules/sentinal-mcp-servers.md`): domain table AND header figure in **both** that file and `README.md` (they drift independently), plus a registration assertion in `src/mcp/server.test.ts`. Current figures: **35 tools across 7 domains**, Analysis domain **3 tools** (`.sentinal/rules/sentinal-mcp-servers.md:3,74`; `README.md:59,666`).

## Assumptions

- **Claude Code ships a native `LSP` tool; OpenCode does not.** Supported by `targets/claude-code/settings.json:5` (`ENABLE_LSP_TOOL: "true"` — Sentinal enabling a platform feature) and direct observation that no `lsp` tool is exposed in an OpenCode session. Task 9 depends on this. **If Claude Code ships none either, Task 9 becomes "delete `lsp-tools.md` from both targets" rather than "differentiate".** Verify before editing.
- **Cross-repo linking is unverified.** One project indexed; `mode: "cross_service"` returned output byte-identical to `calls` with no empty-result marker; this repo's `Route`/`HTTP_CALLS` extraction is dominated by misparsed path literals from test fixtures. Nothing may **score** from it; the catalogue may **record** it, marked unverified. Tasks 6, 7 depend on this.
- **A plan's `Files:` list is a prediction.** Implementation routinely touches files the plan never named. Bounds the reach half of `plan_impact` only — not overlap detection (D4). Tasks 7, 10 depend on this.
- **`Create:` targets have zero reach by construction** — they do not exist, so `countImporters`/`buildImportGraph` have no node. Reach is meaningful only for `Modify:`. Tasks 4, 7 depend on this.

## Testing Strategy

- **Regression tests for both bugs first**, each failing before its fix. Bug 1's test must exercise the **client** path with `store: null` — precisely what no existing test covers.
- Unit tests per new module: plan parser, source normalisation, overlap detection.
- **Contract test:** the example payload in the shipped rule AND in `/sync`'s emitted recipe must parse against the real imported `AgentReachSchema`. This is the cheap machine-checkable guard that would have caught the drift this plan's first iteration introduced.
- **Integration test:** `plan_impact` on a fixture plan, run twice — built-in vs injected source — asserting a different, attributed verdict.
- Content tests for shipped prose, bound to schema shape not raw source text.
- Full suite ≥ 2588 pass / 0 fail; `bunx tsc --noEmit` clean.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Fixing Bug 1 activates Bug 2 → every plan's test files flagged unexpected | **Certain** if split | High | Both in Task 1, with a table-driven verb test |
| Fixing Bug 1 turns `hasUnexpected` back on → previously-LOW runs go HIGH | High | Medium — looks like a regression | Intended behaviour restored; Task 11 quantifies the new rate |
| Schema change breaks agents following the shipped rule | **Certain** without D2 | High | D2 keeps the single-object form valid; Task 5 updates both `mcp-servers.md` copies in the same task |
| `/sync` emits a payload the schema rejects | Medium | High | Contract test parses the emitted example against the imported schema |
| Two tasks regenerate parity baselines concurrently → poisoned fixture | Medium | High | Gotcha 4; at most one regenerating task per wave |
| Cross-model share thresholds are uncalibrated | **Was certain** in iteration 0 | High | D1 — only one source scores, so no uncalibrated cross-model scoring ships |
| Overlap detection produces false positives | Medium | Low | Validate against this repo's VERIFIED plans; advisory, never blocking |
| Splitting a 681-line file causes import churn | Medium | Medium | Pure move, existing tests unmodified as checkpoint |

## Pre-Mortem

1. **The plan parser is defeated by real formatting** (Task 4) → Trigger: parsing this repo's `docs/plans/*.md` corpus yields <90% of the files a human would identify. Fallback: fail loudly and require a stricter template rather than silently under-reporting.
2. **Overlap detection flags waves that shipped fine** (Task 7) → Trigger: running over VERIFIED plans produces any false positive. Fallback: downgrade to advisory wording and report confidence.
3. **`plan_impact` is too slow to be worth calling** (Task 7) → Trigger: >2s on a 12-task plan. Fallback: compute reach only above a size/importer pre-filter; overlap detection alone is nearly free.
4. **Claude Code has no LSP tool either** (Task 9) → Trigger: verification in Task 9 finds none. Fallback: delete `lsp-tools.md` from both targets rather than differentiate.

## Execution Waves

**Wave 1** — bugs and blockers. Tasks 1, 2, 3 touch disjoint files. Task 1 fixes production; 2 and 3 clear file-length blockers. No parity regeneration.

**Wave 2** — primitives. Tasks 4 and 5 are disjoint (new parser module vs `reach.ts` + the two `mcp-servers.md` rule copies). Task 5 regenerates parity baselines; Task 4 does not.

**Wave 3** — tools and catalogue. Tasks 6, 7, 8 all depend on Task 5. Disjoint: Task 6 owns `sync.md` + the fixture directory, Task 7 owns `plan-impact.ts` + docs/counts, Task 8 owns `impact.ts`. **Only Task 6 regenerates baselines.**

**Wave 4** — workflow prose (single task). Task 9 owns both `spec-plan` copies, both `spec-implement` copies, `lsp-tools.md`, and the fixture directory. It is one task precisely because splitting it would put two baseline regenerations in one wave (Gotcha 4).

**Wave 5** — verification and measurement. Task 10 (content + contract tests) must follow all prose. Task 11 (measurement) needs Tasks 1 and 5. Disjoint: `src/cli/*.test.ts` vs `scripts/` + possibly `reach.ts`.

## Goal Verification

### Truths

1. A test constructs `impact_analysis` with `{client, store: null}` — the production shape — and asserts `_Active spec:_` renders and an unexpected-file warning can fire. Fails before Task 1.
2. `extractSpecFiles` returns paths for every verb the shipped template emits, with backticks stripped — table-driven, verb list derived from `spec-plan.md`.
3. `wc -l src/spec/mcp-tools.ts` < 400 and `wc -l src/sidecar/client.ts` < 400.
4. `src/analysis/plan-files.ts` returns per-task `{ task, wave, files: [{path, verb, exists}] }`.
5. `plan_impact` appears in the emitted `inputSchema` via a real `Client` over `InMemoryTransport` (precedent: `impact.test.ts:433-516`), and `src/mcp/server.test.ts` asserts its registration.
6. **Contract:** the example payload extracted from both `sync.md` copies and both `mcp-servers.md` copies parses successfully against the **imported** `AgentReachSchema`.
7. **Integration:** `plan_impact` on a fixture plan returns a different, attributed verdict with an injected source than without.
8. **Single-primary:** a test supplies two sources whose shares disagree (26.6% vs 2.4% on the same file) and asserts the verdict equals the primary's alone and does not move when the second is added or removed.
9. `plan_impact` detects a same-wave overlap in a fixture plan **with zero injected sources**, and reports none for this plan.
10. Both `spec-plan` copies instruct consulting the catalogue and injecting; both `spec-implement` copies state the caller-finding ordering (LSP → catalogued capability → grep) naming no vendor.
11. No shipped file under `src/` or `targets/*/rules/` names a vendor **as required**; the only permitted occurrence is an illustrative `e.g.` explicitly retained by Task 5. (Note: `reach.ts:137` currently names `codebase-memory-mcp trace_path` — Task 5 decides its fate.)
12. MCP counts read **36 tools across 7 domains** and Analysis **4 tools** in BOTH `README.md` and `.sentinal/rules/sentinal-mcp-servers.md`.
13. `bun test` 0 failures; `bunx tsc --noEmit` clean; every parity fixture's hunk count unchanged; `spec-verify.diff` still 0 bytes.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/analysis/plan-files.ts` | Per-task Files/Wave/verb parser | `parsePlanFiles`, `PlanTaskFiles` |
| `src/analysis/plan-impact.ts` | `plan_impact` tool | `registerPlanImpactTool` |
| `src/analysis/reach.ts` (mod) | Multi-source surface, single-primary scoring, call sites | `AgentReachSchema`, `resolveReach`, `CallSite` |
| `src/analysis/helpers.ts` (mod) | All-verb + backtick-safe extraction | `extractSpecFiles` |
| `src/analysis/mcp-tools.ts` (mod) | Client threaded to `impact_analysis`; `plan_impact` registered | `registerAnalysisTools` |
| `targets/*/rules/mcp-servers.md` (mod) | Agent-facing contract, updated | — |
| `targets/*/commands/sync.md` (mod) | Capability catalogue + correct emitted recipe | — |
| `targets/*/commands/spec-plan.md`, `spec-implement.md` (mod) | Catalogue consumption | — |
| `scripts/measure-reach-thresholds.ts` | Threshold evidence | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/analysis/mcp-tools.ts` | `SidecarClient` | spec-context fix | `registerImpactAnalysisTool\(server, .*client` |
| `src/analysis/plan-impact.ts` | `src/analysis/plan-files.ts` | parser | `from "./plan-files.js"` |
| `src/analysis/plan-impact.ts` | `src/analysis/reach.ts` | shared scoring | `from "./reach.js"` |
| `src/cli/*.test.ts` | `AgentReachSchema` | contract test | `from ".*reach.js"` |
| `targets/*/commands/spec-plan.md` | `plan_impact` | prose wiring | `plan_impact` |
| `targets/*/commands/spec-implement.md` | catalogue | marker reference | `SENTINAL GRAPH TOOLS` |

## Progress Tracking

- [x] Task 1: Fix spec context under sidecar + all-verb/backtick extraction (Wave 1) — impact.ts 283→320, helpers.ts 154→189, +13 tests
- [x] Task 2: Split `src/spec/mcp-tools.ts` (681 → <400) (Wave 1) — `43262f3`, 681→292/231/240
- [x] Task 3: Split `src/sidecar/client.ts` (582 → <400) (Wave 1) — `70f97d4`, 582→281/323
- [x] Task 4: Per-task plan parser (Wave 2) — `91388bb`, 316 lines, 99.7% corpus agreement over 110 plans / 530 tasks / 1191 files
- [x] Task 5: Multi-source surface + call sites + shipped rule update (Wave 2) — `0c0f31b`, reach.ts 354 + reach-sources.ts 354, +40 tests
- [x] Task 6: `/sync` capability catalogue + corrected emitted recipe (Wave 3) — `446798d`, Phase 7 86→97 lines, +16 tests
- [x] Task 7: `plan_impact` tool + overlap detection + MCP catalogue counts (Wave 3) — `817ea32`, 284+234 lines, +29 tests
- [x] Task 8: Call-site reporting in `impact_analysis` output (Wave 3) — `b70f415`, impact.ts 333 + call-sites.ts 99, +14 tests
- [x] Task 9: Wire catalogue into `spec-plan` + `spec-implement`, fix LSP prose (Wave 4) — `230c2d8`, 11 files, +2 tests
- [x] Task 10: Content + contract tests for all shipped prose (Wave 5) — 33 mutations verified, +45 tests, `plan-impact-prose.test.ts` 384 lines
- [x] Task 11: Threshold measurement — gated (Wave 5) — cutoffs **UNCHANGED**; `scripts/measure-reach-thresholds.ts` 399 lines, comment-only edit to `reach.ts`. See Threshold Measurement Verdict.

**Total Tasks:** 11 | **Completed:** 11 | **Remaining:** 0

**Full suite:** 2781 pass / 0 fail (baseline at plan start: 2588). tsc clean.

### ⛔ Wave 5 finding — follow-up required, deliberately NOT actioned here

**`hasUnexpected` now DOMINATES `scoreRisk`.** Task 11 measured 50 real changesets recovered from git, each paired with its plan as read at that SHA: restoring `hasUnexpected` (Task 1) moves the HIGH rate from **18.0% → 90.0%** on work files, or **20.5% → 45.5%** on source files excluding generated ones. Firing on 45-100% of real changesets makes the reach thresholds largely **unreachable as a differentiator** — HIGH is decided by plan compliance before reach is ever consulted. No reach cutoff can fix this: loosening does not reduce it, tightening makes it worse. The lever is in `impact.ts`. **This is a real consequence of fixing a real bug, not a regression — but it needs its own spec.**

Two more recorded but not actioned: `AgentReachSchema` silently strips unknown top-level keys, so an agent that mis-nests `primary` gets a silent wrong answer rather than an error (`.strict()` would be better). And `lsp-tools.md` has a **second** licensed divergence beyond tool-name casing — the per-target availability note (`ENABLE_LSP_TOOL`/`vtsls` vs `typescript-language-server`) — so the comment at `target-parity.test.ts:157` is now slightly understated.

### ⛔ Wave 4: ASSUMPTION 1 WAS FALSE — recorded so nobody "fixes" it back

**Both platforms ship an LSP tool.** Verified by `strings(1)` against the installed binaries, not documentation:

- **Claude Code 2.1.205** — tool constant `var HKt="LSP"`, all 9 operations (`goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls`).
- **OpenCode 1.18.23** — registered as `j("lsp", …)` with the same helper as `bash`/`grep`/`read`/`skill`, byte-for-byte the same description opener and the same 9 operations, gated on `t.ask({permission:"lsp"})`.

**So the "bug" this plan listed in Scope — *"spec-implement and lsp-tools.md tell OpenCode agents to call an `lsp` tool that target lacks"* — DOES NOT EXIST.** The `LSP` vs `lsp` casing divergence in `lsp-tools.md` was **correct all along**, and is now the only licensed divergence (comment recorded at `src/cli/target-parity.test.ts:157`). Neither Pre-Mortem 4 branch applied.

**A real bug was found instead, affecting BOTH targets:** the rules documented the path parameter as `file:` when both runtimes require **`filePath:`**, and documented `documentSymbol`/`workspaceSymbol` without the `line`/`character` both schemas require. Every example in `lsp-tools.md` plus `spec-implement.md:175` would have been rejected before reaching a language server. Fixed in all four files.

**⚠️ Research failure worth remembering:** `docs/plans/2026-03-12-lsp-integration.md:47` **already recorded** "Claude Code exposes a single `LSP` tool (uppercase). OpenCode exposes a single `lsp` tool (lowercase)." That was accurate. This plan's Assumption 1 contradicted a prior VERIFIED plan without citing it, because the exploration reported "not verifiable from this repo" and that was accepted rather than checked against `docs/plans/`. **Check prior plans before asserting a platform capability does not exist.**

**`IDENTICAL_RULES`:** added `development-practices.md` and `code-review-reception.md` (byte-identical, unguarded, and containing only LSP *operation* names which are identical across platforms). Deliberately NOT added `lsp-tools.md` — forcing byte-identity there would ship a tool name one platform does not answer to.

### Wave 3 outcomes

- **⚠️ Pre-Mortem 2 FIRED.** Overlap detection flags **3 of 89 (3.4%)** VERIFIED plans. All three are literally true against `spec-plan.md:220`; they split three ways: `2026-04-02-opencode-v1.3-parity.md` is a **false positive in effect** (its wave narrative consciously resolved the conflict in prose the per-task `**Wave:**` field cannot express); `2026-04-20-...-phase-1.md` is a **genuine undetected violation** — its own narrative asserts "there is no file overlap" and is wrong, which is the case justifying the tool; `2026-07-17` is unknown. Per the Pre-Mortem, **wording was downgraded rather than the assertion tuned**: the output now names the sequential-wave escape hatch, states the measured 3/89 rate inline, and says a flag is "a statement about the plan text, not evidence of harm." The corpus test asserts a **bound (<10%)**, not the exact count.
- **`plan_impact` runs in 29-37ms** on an 11-task plan — ~50× under the 2s budget. Pre-Mortem 3 not triggered; no pre-filter needed.
- **Three buckets, not two.** Scored + not-on-disk silently lost 13 of 33 files. A third bucket — **exists but is not `.ts`/`.tsx`/`.js`** — was required; a test asserts the three sum to the total.
- **`buildImportGraph` only scans `src/`.** A real `.ts` under `targets/` scores 0 importers for a reason unrelated to coupling, so the output footnotes it: *"absence of reach there is absence of evidence, not evidence of absence."*
- **Requirement to key on `exists` not `verb` was load-bearing**, as predicted: on this plan 5 of 33 files don't exist; keying on `verb` would have scored them 0 and dragged the verdict to LOW. Keying on `exists` gives HIGH, driven by `helpers.ts` at 27% of 347 — the correct read of Task 1's blast radius.
- **Call sites use TWO caps, not one** (`CALL_SITES_PER_TARGET=5`, `CALL_SITE_TARGETS=8`). A global cap alone lets one hot file starve every other out of the section; a per-file cap alone is unbounded in file count.
- **Three more files created beyond declared lists**, all to stay under 400 and all following the `reach.ts`→`reach-sources.ts` precedent: `plan-impact-report.ts` (234), `call-sites.ts` (99), `call-sites.test.ts`.
- **`resolution.callSites` already existed and was being silently dropped** — Task 5 wired it through `ReachResolution` but `impact.ts` never passed it on. Task 8's change was 13 lines.

### Wave 2 outcomes that change later tasks

- **⚠️ The plan's assumed `Files:` format covers only ONE of two real corpus formats.** The template's `**Files:**` + verb bullets is what this plan describes, but every bugfix plan uses an inline `**Files:** \`a.ts\`, new \`b.ts\`` on the marker line with **no verb**. Parsing only the documented form returns **0 files for whole plans**. `plan-files.ts` handles both; inline entries default to `verb: "modify"`. **Task 7 must therefore key its "reach only on Modify:" rule on `exists`, not on `verb`** — `exists` is the load-bearing signal.
- **`extractSpecFiles` is not a clean oracle.** Its flat `gim` scan also swallows `- Add: \`migrateV6()\``, `- Modify: \`countImporters\`` from Key-Decisions blocks — symbol names, not files. Raw agreement was 75.4% purely from false positives on *its* side.
- **`callSites` lives INSIDE the `reach` object**, not as a sibling tool param — a sibling would require editing `impact.ts:58`, which is Task 8's file.
- **⚠️ Task 5 had to edit two files outside its declared list**, both by design: `impact.test.ts:639` and `sync-graph-tools.test.ts:212` each pinned `AgentReachSchema`'s exact key set, and D2 forces `moduleCount`/`files` to become optional so `required` is now `[]`. `sync-graph-tools.test.ts`'s own failure message says "must be updated in the same commit". Both were updated schema-bound (derived from `ReachSourceSchema.shape`/`CallSiteSchema.shape`, not hand-listed). **Tasks 8 and 10 should expect these files to have moved.**
- **`reach.ts:137` vendor name: SCRUBBED** to `'<server> <tool>'`, and the same string removed from test fixtures — `rg codebase-memory src/ targets/` now returns nothing, so Truth 11 is greppable rather than a judgement call.
- **Type-cycle trap:** `AgentReachSchema` calls `normalizeReachSources` inside its own `.refine()`, so a type-only import of the inferred `AgentReach` back into `reach-sources.ts` produces `TS2502`/`TS7022`/`TS2456` — **clean under Bun, four errors under `tsc`**. `reach-sources.ts` imports nothing from `reach.ts` and declares a structural `ReachInput` instead. Documented in-file; do not "tidy" it back.
- **Rejection semantics:** a failing **non-primary** source is *dropped* and rendered as rejected-but-unscored, verdict untouched; a failing **primary** rejects the whole call and names only itself (a test asserts the innocent source's name is absent from the error).

## Implementation Notes

- **THIRD bug found and fixed in Task 1 (not in the plan):** `helpers.ts:88`'s `.split(" ")[0]` dropped every path after the first on comma-separated `- Modify: \`a.ts\`, \`b.ts\`, \`c.ts\`` lines — a form **this plan file itself uses**. Without fixing it, Task 1's own fix would have flagged 2 of its 3 files as unexpected changes. Now: when backticks are present take all `` `...` `` tokens, else keep the original first-token behaviour verbatim.
- **`check_diagnostics` has the same `specStore === null` blindness** (`analysis/mcp-tools.ts:182`) but degrades *safely* — an empty `specFiles` means every error is treated as spec-relevant, so it over-reports rather than dropping signal. Left alone to hold `mcp-tools.ts` at 416. **Worth a follow-up.**
- **`normalizeSpecFilePath` is now exported** from `helpers.ts` so Task 4's parser shares it instead of forking a second copy.
- **Verb-list derivation gotcha (Task 1):** scoping the template scan to the fenced ` ```markdown ` block silently finds the WRONG block — `spec-plan.md` has an *indented* closing fence at line 118, so naive fence-pairing spans 107→181 and swallows the task template. The `**Files:**` marker is unique and fence-independent; use it.
- **`src/spec/mcp-tools.ts` was not prettier-clean at HEAD** (an 88-char line). Expect more of this; only reformat lines you move.
- **`SidecarClient` split uses inverted inheritance** — `SidecarRoutes` is the abstract *base* holding all 30 endpoint methods and declaring `protected abstract get()/post()`; `SidecarClient extends` it and supplies transport plus every static. Putting transport in the base instead would force the static factories down too, where `connect()` returns the base type and `reconnect()` needs `this.constructor` gymnastics to see test overrides. `SidecarRoutes` is deliberately NOT exported from the barrel.
- **`bun:sqlite` non-reachability is verified by bundling, not by eyeballing imports:** `bun build --target=bun src/sidecar/client.ts` then grep the output — `--target=bun` leaves `bun:sqlite` as an external import so any reachable importer surfaces as a string. Control: the same check on `server.ts` yields 2 hits, proving it is not vacuous.
- **Registration order of the 9 `spec_*` tools changed** (delegation cannot preserve interleaving). `listTools` order is not part of any contract and nothing asserts on it.
- **The TDD guard blocks pure extractions**, including files that already have a companion test beside them. Third and fourth sightings. Use `RED_CONFIRMED` with a rationale; never write a fake failing test.

## Implementation Tasks

### Task 1: Fix spec context under sidecar + all-verb/backtick extraction

**Objective:** Restore `impact_analysis`'s spec-compliance half in production and make file extraction correct for every verb the template emits — together, because the first fix activates the second bug.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/analysis/mcp-tools.ts`, `src/analysis/impact.ts`, `src/analysis/helpers.ts`
- Modify: `src/analysis/impact.test.ts`, `src/analysis/helpers.test.ts`

**Key Decisions / Notes:**
- Thread the `SidecarClient` into `registerImpactAnalysisTool`; resolve the active spec via `client.getCurrentSpec(project)` when `specStore` is null. Keep the `specStore` path for the no-sidecar case. Handler is already `async`.
- **⛔ RED first, on the client path.** The suite passes a store, which is exactly why this shipped broken. The new test must use `{client, store: null}`.
- `helpers.ts:84`: add `Test`. `helpers.ts:88`: strip backticks — **this affects every verb**, not just `Test:`.
- **Derive the verb list in the test from the shipped `spec-plan.md` template**, not a hand-written literal, so a future template verb cannot silently go unmatched again.
- Keep `src/analysis/mcp-tools.ts` growth minimal — it is at 414.
- **Expect the HIGH rate to rise** once `hasUnexpected` can fire. That is restored behaviour; Task 11 quantifies it.

**Definition of Done:**
- [ ] Test with `{client, store: null}` asserts `_Active spec:_` renders — fails before the fix
- [ ] Test asserts an unexpected-file warning can fire under the client path
- [ ] Table-driven test covers every verb from the shipped template, backticked and bare
- [ ] Test asserts a plan's own `Test:` file is NOT reported unexpected
- [ ] `src/analysis/mcp-tools.ts` ≤ ~420
- [ ] `bun test` 0 failures; tsc clean

**Verify:** `bun test src/analysis/`

---

### Task 2: Split `src/spec/mcp-tools.ts` (681 → <400)

**Objective:** Clear the hard block so the file is editable at all.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/spec/mcp-tools.ts`
- Create: sibling(s), e.g. `src/spec/plan-mcp-tools.ts`

**Key Decisions / Notes:**
- **Pure move.** `src/spec/mcp-tools.test.ts` must pass **unmodified** — the free checkpoint.
- At 681 the file-length hook refuses edits; split by cohesion following `src/runtime/` (`mcp-tools.ts` calls `lifecycle-mcp-tools.ts`'s register function, so `src/mcp/server.ts` needs no change). `registerSpecTools` stays the single entry point with an unchanged signature.

**Definition of Done:**
- [ ] `src/spec/mcp-tools.ts` < 400; every sibling < 400
- [ ] `git diff --exit-code src/spec/mcp-tools.test.ts` exits 0
- [ ] `src/mcp/server.ts` unchanged
- [ ] All 9 `spec_*` tools still registered
- [ ] `bun test` 0 failures

**Verify:** `git diff --exit-code src/spec/mcp-tools.test.ts && bun test src/spec/`

---

### Task 3: Split `src/sidecar/client.ts` (582 → <400)

**Objective:** Create headroom before anything adds a route method.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/sidecar/client.ts`
- Create: sibling(s)

**Key Decisions / Notes:**
- **Pure move**; existing sidecar tests unmodified.
- **⛔ Do NOT make `bun:sqlite` reachable from `client.ts` or its siblings.** Hooks that only need the client must not pay that cost — this is why `paths.ts` was factored out of `server.ts`.
- Preserve `connect()`, `connectWithRetry()`, `buildForTest()` and every existing public method name exactly.

**Definition of Done:**
- [ ] `src/sidecar/client.ts` < 400; siblings < 400
- [ ] No `bun:sqlite` reachable from `client.ts`
- [ ] Existing sidecar tests unmodified and passing
- [ ] `bun test` 0 failures

**Verify:** `bun test src/sidecar/`

---

### Task 4: Per-task plan parser

**Objective:** Produce the structured per-task view nothing currently provides.
**Dependencies:** None
**Wave:** 2

**Files:**
- Create: `src/analysis/plan-files.ts`, `src/analysis/plan-files.test.ts`

**Key Decisions / Notes:**
- **Standalone module, NOT an extension of `src/spec/parser.ts`** (386, 14 from warn; adding `files` to `SpecTask` ripples into `SpecTaskSchema`, `store.ts` at 407, and a SQLite migration — none of it needed, since the plan file is read directly exactly as `extractSpecFiles` already does).
- Shape: `PlanTaskFiles { task: number; title: string; wave: number | null; files: Array<{ path; verb: "create"|"modify"|"test"|"delete"; exists: boolean }> }`.
- Per-task state machine keyed on `### Task N:` headings — a flat `gim` regex cannot attribute.
- Parse per-task `**Wave:**` (`spec-plan.md:186`). The template ships literal `[1 | 2 | ...]` placeholders — an unfilled one must yield `wave: null`, not a throw.
- Share the backtick/`./` normalisation with Task 1's fix rather than duplicating it.
- **Validate against the real corpus:** run over every `docs/plans/*.md` in this repo (Pre-Mortem 1's trigger is <90% agreement).

**Definition of Done:**
- [ ] Per-task grouping with verb and `exists`
- [ ] `wave: null` for unfilled placeholders, no throw
- [ ] Backticks stripped; `Test:` recognised
- [ ] Test parses this repo's entire `docs/plans/` corpus without throwing, and reports coverage
- [ ] < 400 lines
- [ ] `bun test src/analysis/plan-files.test.ts` passes

**Verify:** `bun test src/analysis/plan-files.test.ts`

---

### Task 5: Multi-source surface + call sites + shipped rule update

**Objective:** Accept reach from multiple sources each with its own universe, plus call sites — scoring from exactly one — and update the shipped rule that documents the contract, in the same task.
**Dependencies:** None
**Wave:** 2

**Files:**
- Modify: `src/analysis/reach.ts`, `src/analysis/reach.test.ts`
- Modify: `targets/claude-code/rules/mcp-servers.md`, `targets/opencode/rules/mcp-servers.md`
- Modify: `src/cli/target-parity.test.ts` (if `IDENTICAL_RULES` needs it — `mcp-servers.md` is already there)
- Modify: `src/cli/__fixtures__/target-parity/` (regenerate — **the only regenerating task in Wave 2**)

**Key Decisions / Notes:**
- Shape: `sources: Array<{ source?, primary?, moduleCount, files }>` plus optional `callSites: Array<{ file, line, caller, callee, target }>`.
- **⛔ D1 — exactly one source scores.** `primary: true`, or the first if unmarked. All others are accepted for attribution and call sites and rendered **explicitly as unscored**. Do NOT take max/min across sources; see D1 for why the verdict would otherwise depend on tool inventory.
- **⛔ D2 — the single-object `reach` form stays valid**, normalised to a one-element list. Without this every agent following the currently-shipped rule breaks.
- All-or-nothing coverage is enforced **per source**; a failing source is rejected by name without poisoning the others. Preserve the existing rejection-message quality (it names missing paths — that is what surfaces rel-vs-abs mistakes).
- **Rewrite the `AgentReachSchema` docblock (`reach.ts:113-117`).** Its argument stays true *per source*; what changes is that the universe travels per-source. Restate it correctly — do not delete it.
- **Decide `reach.ts:137`'s fate.** It currently reads `"e.g. 'codebase-memory-mcp trace_path'"` — a vendor name in shipped `src/`, surfaced in every emitted `inputSchema`. Either scrub it to a generic phrasing, or keep it and record here that illustrative `e.g.` is permitted. Truth 11 is written to accept either, but the choice must be explicit.
- **Update BOTH `mcp-servers.md` copies** — the reach table, the example payload (`:161-173`), and the "single report-level scalar" paragraph (`:175-177`). They are byte-identical and in `IDENTICAL_RULES`; keep them so.
- Call sites are **evidence only** — no effect on `scoreRisk` in this task.
- **Restate every constraint in `.describe()`** (Gotcha 1).
- Keep `reach.ts` < 400 (currently 331); split the rejection builder to `src/analysis/reach-reject.ts` if needed.

**Definition of Done:**
- [ ] Multi-source schema; single-object form still accepted (test proves both)
- [ ] Test: two sources disagreeing (26.6% vs 2.4% same file) — verdict equals primary's alone, unchanged by adding/removing the second
- [ ] Test: non-primary sources rendered explicitly as unscored
- [ ] Test: a source missing a changed TS file is rejected by name without poisoning others
- [ ] Test: call sites accepted, verdict unchanged
- [ ] Docblock rewritten; `reach.ts:137` decision recorded
- [ ] Both `mcp-servers.md` copies document the new shape and stay byte-identical
- [ ] Every constraint present in the emitted `inputSchema` `.describe()` text
- [ ] Baselines regenerated; hunk counts unchanged
- [ ] `reach.ts` < 400

**Verify:** `bun test src/analysis/reach.test.ts src/cli/target-parity.test.ts`

---

### Task 6: `/sync` capability catalogue + corrected emitted recipe

**Objective:** Catalogue what a project actually has, and emit a recipe that matches the schema Task 5 shipped.
**Dependencies:** Task 5
**Wave:** 3

**Files:**
- Modify: `targets/claude-code/commands/sync.md`, `targets/opencode/commands/sync.md`
- Modify: `src/cli/__fixtures__/target-parity/` (regenerate — **the only regenerating task in Wave 3**)

**Key Decisions / Notes:**
- Extend the existing `SENTINAL GRAPH TOOLS` block; do not add a second. Widen the capability table beyond reach to: per-file reach, call sites with file+line, symbol search, cross-repo/cross-service.
- **⛔ Update the emitted recipe at `sync.md:540/542`** — it currently writes the single-`moduleCount` payload. It must match Task 5's shape. **Add a `plan_impact` recipe alongside it.** This is why the task depends on Task 5.
- **⛔ The generated block MAY name a vendor and carry a concrete recipe** — it is written per-project from Phase 7's smoke-testing and is never shipped. Say so in the prose so a future reader does not "fix" it.
- **Record the *verified* invocation, not the obvious one.** Phase 7 already smoke-tests; the block must record what actually returned correct data, with a caution that the obvious-looking tool is not always the sound one — **naming no vendor**.
- Cross-repo may be catalogued as present but **marked unverified**; nothing may score from it.
- Preserve the omit-if-universe-unknown rule.
- Apply identically to both copies.

**Definition of Done:**
- [ ] Capability table covers reach, call sites, symbol search, cross-repo (last marked unverified)
- [ ] Emitted recipe matches Task 5's schema; `plan_impact` recipe added
- [ ] "Generated block may be vendor-specific; shipped rules may not" rationale stated
- [ ] Verify-before-cataloguing caution present, naming no vendor
- [ ] Phase 7 slice byte-identical across targets
- [ ] Baselines regenerated, hunk counts unchanged; `spec-verify.diff` 0 bytes
- [ ] `bun run embed-assets && bun test src/cli/` passes

**Verify:** `diff <(sed -n '/## Phase 7/,/## Phase 8/p' targets/claude-code/commands/sync.md) <(sed -n '/## Phase 7/,/## Phase 8/p' targets/opencode/commands/sync.md)`

---

### Task 7: `plan_impact` tool + overlap detection + MCP catalogue counts

**Objective:** Analyse a plan before implementation: deterministic same-wave overlap detection, plus prospective reach on `Modify:` targets.
**Dependencies:** Task 4, Task 5
**Wave:** 3

**Files:**
- Create: `src/analysis/plan-impact.ts`, `src/analysis/plan-impact.test.ts`
- Modify: `src/analysis/mcp-tools.ts` (registration — one line)
- Modify: `src/mcp/server.test.ts`, `README.md`, `.sentinal/rules/sentinal-mcp-servers.md`

**Key Decisions / Notes:**
- **Separate tool, not a mode of `impact_analysis`** — the outputs genuinely differ.
- Params: `project`, optional `plan_path` (default: active spec), plus Task 5's injection surface.
- **⛔ D4 — the two halves have different standing and the output must say so.** Overlap detection is deterministic on plan text, **works with zero injected sources and no graph tool**, and is the highest-value output because `spec-plan.md:220` states the rule and nothing enforces it. Prospective reach is prediction-bounded — render it as a hint with its assumption named **inline in the output**, not just in docs.
- **Reach only on `Modify:` targets.** `Create:` files have no reach by construction; report them separately and say why they are unscored, or a plan of mostly-new files always scores LOW.
- Include the OpenCode framing: parallel tasks share one working directory, so an overlap corrupts work rather than merely racing.
- **Advisory, never blocking.** Validate against this repo's VERIFIED plans (Pre-Mortem 2).
- **⛔ MCP catalogue checklist (Gotcha 7):** update Analysis domain **3 → 4** and the header figure **35 → 36** in BOTH `README.md` (`:59`, `:666`) and `.sentinal/rules/sentinal-mcp-servers.md` (`:3`, `:74`) — they drift independently. Assert registration in `src/mcp/server.test.ts`.
- **⛔ `src/analysis/mcp-tools.ts` is 414** — registration is one line, nothing more.

**Definition of Done:**
- [ ] `plan_impact` in the emitted `inputSchema` (real `Client` + `InMemoryTransport`)
- [ ] `src/mcp/server.test.ts` asserts registration
- [ ] Detects a same-wave overlap **with zero injected sources**; none for this plan
- [ ] Integration test: injected vs built-in produces a different, attributed verdict
- [ ] `Create:` targets reported separately and explicitly unscored
- [ ] Output names the prediction assumption inline and states it does not replace verification
- [ ] No overlap false positives across `docs/plans/` VERIFIED plans (or wording downgraded)
- [ ] Under 2s on a 12-task plan
- [ ] Counts updated in BOTH `README.md` and `.sentinal/rules/sentinal-mcp-servers.md`
- [ ] `plan-impact.ts` < 400; `mcp-tools.ts` grew ~1 line

**Verify:** `bun test src/analysis/plan-impact.test.ts src/mcp/server.test.ts`

---

### Task 8: Call-site reporting in `impact_analysis` output

**Objective:** Make a HIGH actionable by naming where the coupling is.
**Dependencies:** Task 5
**Wave:** 3

**Files:**
- Modify: `src/analysis/impact.ts`, `src/analysis/impact.test.ts`

**Key Decisions / Notes:**
- Emit `### Call Sites` **after** the `### Import Reach` loop (ends `impact.ts:255`) and **before** `### File Length Warnings` (`:257`) — reach is the count, call sites the evidence; later sections stay byte-unchanged, which matters because `impact.test.ts` asserts on this output.
- Render `file:line` (clickable) with caller and callee. **Cap the list and state the omitted count** — a 200-entry dump is not actionable.
- Render only when call sites were supplied — no empty heading.
- Follow the `reachAttribution` precedent (`impact.ts:280`) for naming the source.

**Definition of Done:**
- [ ] Section renders only when supplied
- [ ] `file:line` with caller and callee
- [ ] Capped, with omitted-count line
- [ ] Existing `impact.test.ts` output assertions still pass
- [ ] `impact.ts` < 400

**Verify:** `bun test src/analysis/impact.test.ts`

---

### Task 9: Wire catalogue into `spec-plan` + `spec-implement`, fix LSP prose

**Objective:** Join the catalogue to the workflow — the user's points 3 and 4 — and stop instructing OpenCode agents to call a tool that target lacks. One task because splitting it would put two baseline regenerations in one wave (Gotcha 4).
**Dependencies:** Task 6, Task 7
**Wave:** 4

**Files:**
- Modify: `targets/claude-code/commands/spec-plan.md`, `targets/opencode/skills/spec-plan/SKILL.md`
- Modify: `targets/claude-code/commands/spec-implement.md`, `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/claude-code/rules/lsp-tools.md`, `targets/opencode/rules/lsp-tools.md`
- Modify: `targets/*/rules/development-practices.md`, `targets/*/rules/code-review-reception.md`
- Modify: `src/cli/target-parity.test.ts` (`IDENTICAL_RULES`), `src/cli/__fixtures__/target-parity/` (regenerate)

**Key Decisions / Notes:**
- **spec-plan:** insert after Step 1.5.0 (Execution Wave Grouping) — the earliest point waves exist. Step 1.5.0 item 2 currently states the overlap rule with no enforcement; change it to call `plan_impact` and act on the result, keeping the manual rule as fallback. **The prose must instruct consulting the project rule's capability catalogue and injecting a verified reach/call-site capability if one is catalogued; call `plan_impact` without it otherwise.** Frame as advisory, not a gate.
- **spec-implement:** replace the `lsp(...)`-only guidance at CC:174-175 / OC:170-171 with the ordering **LSP where present → catalogued code-graph capability → grep as last resort**, naming no vendor and stating grep's limitations. Point at the catalogue **by its marker name** (`SENTINAL GRAPH TOOLS`).
- **⛔ VERIFY the Claude Code LSP tool exists before editing** (Assumption 1). If it does not, this becomes "delete `lsp-tools.md` from both targets".
- **⛔ Do NOT touch `spec-verify` / `spec-bugfix-verify` LSP text.** It describes Sentinal's own `LspClient` ("~10 open files"), is **accurate** (`lsp-client.ts:196` really does `findTsFiles(srcDir, 10)`), is in `MUST_STAY_BYTE_EQUAL`, and is asserted by `src/cli/spec-verify-full-tsc.test.ts`.
- `lsp-tools.md` currently differs between targets (2952 vs 2970) and is unguarded. If they end identical, add to `IDENTICAL_RULES`; if they legitimately differ, leave it out and comment why. `development-practices.md` and `code-review-reception.md` are byte-identical but unguarded — add them if edited in both.
- **Single baseline regeneration**, once, after all edits land.

**Definition of Done:**
- [ ] Claude Code LSP availability verified; finding recorded in this plan
- [ ] Both `spec-plan` copies call `plan_impact` AND instruct consulting/injecting the catalogue
- [ ] Both `spec-implement` copies state the LSP → catalogue → grep ordering, naming no vendor, referencing the marker
- [ ] No target instructs the agent to call a tool that target lacks
- [ ] `spec-verify`/`spec-bugfix-verify` LSP text byte-unchanged
- [ ] `IDENTICAL_RULES` updated for any pair now edited together
- [ ] Baselines regenerated once; hunk counts unchanged
- [ ] `bun run embed-assets && bun test src/cli/` passes

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/spec-verify-full-tsc.test.ts`

---

### Task 10: Content + contract tests for all shipped prose

**Objective:** Make the prose falsifiable, and machine-check that what `/sync` tells projects to emit is something the schema actually accepts.
**Dependencies:** Task 6, Task 9
**Wave:** 5

**Files:**
- Modify/Create: `src/cli/sync-graph-tools.test.ts` (extend) and/or `src/cli/plan-impact-prose.test.ts`

**Key Decisions / Notes:**
- **The contract test is the most valuable item here.** Extract the example payload from both `sync.md` copies and both `mcp-servers.md` copies, parse it, and validate against the **imported** `AgentReachSchema`. This is precisely the check that would have caught the drift the first iteration of this plan introduced.
- Content assertions: capability table rows in both `sync.md`; `plan_impact` in both `spec-plan` copies; the LSP→catalogue→grep ordering in both `spec-implement` copies; no target naming a tool it lacks.
- **Bind param names to schema shape** (`Object.keys(AgentReachSchema.shape)`), never `src.includes(param)` — that form cannot fail for its own reason and was already fixed once.
- **Mutation-verify:** break one assertion, confirm failure, revert, record what was observed.

**Definition of Done:**
- [ ] Contract test parses every shipped example payload against the imported schema
- [ ] Assertions cover Tasks 6 and 9 prose
- [ ] Param names bound to schema shape
- [ ] Mutation-verified, observation recorded
- [ ] `bun test src/cli/` passes

**Verify:** `bun test src/cli/`

---

### Task 11: Threshold measurement — gated

**Objective:** Decide from data whether the reach cutoffs should change. **This task may legitimately end with zero production changes.**
**Dependencies:** Task 1, Task 5
**Wave:** 5

**Files:**
- Create: `scripts/measure-reach-thresholds.ts`
- Modify: `src/analysis/reach.ts` **only if the data justifies it**
- Modify: this plan file (append the verdict block)

**Key Decisions / Notes:**
- **⛔ A script, NOT a `.test.ts`.** As a test it would join the default suite, measure the live repo, drift with every commit, and either become meaningless or fail for unrelated reasons — against the "full suite stays green" bar. The artifact is a **written verdict block appended to this plan** with date, percentiles, classification rates, and the HIGH-rate delta across Task 1.
- Measure: reach distribution under the built-in module model, and — where a catalogued source is available — other granularity models, to establish whether a 25% share means anything outside the module universe it was derived from. Note D1 means no cross-model scoring shipped, so this is now *informative* rather than *load-bearing*.
- **Quantify the HIGH-rate change caused by Task 1**, which restores `hasUnexpected`. Do not assume; measure.
- `ec642c6` derived the current cutoffs from p50 = 10, p75 = 82 on this repo. Re-deriving without equally good data would re-break a just-fixed formula.

**Definition of Done:**
- [ ] `scripts/measure-reach-thresholds.ts` produces percentile + classification-rate tables
- [ ] Explicit written verdict: cutoffs justified, or changed with data cited
- [ ] HIGH-rate before/after Task 1 quantified
- [ ] Verdict block appended to this plan with the date
- [ ] If changed: threshold tests updated and the `reach.ts` rationale comment rewritten
- [ ] `bun test` 0 failures

**Verify:** `bun test src/analysis/ && bun scripts/measure-reach-thresholds.ts`

---

## Threshold Measurement Verdict

**Date:** 2026-08-26 · **Reproduce:** `bun scripts/measure-reach-thresholds.ts`

### ⛔ VERDICT: the cutoffs are JUSTIFIED. Nothing was changed.

`HIGH_REACH_MIN = 8` / `HIGH_REACH_SHARE = 0.25` / `MEDIUM_REACH_MIN = 4` /
`MEDIUM_REACH_SHARE = 0.1` stand. The only production edit is a **comment-only**
correction to `reach.ts`'s rationale block (see "Corrections" below); no constant,
no behaviour and no test changed.

### 1. Reach distribution — built-in module model

Universe = `graph.modules.size` = **350** (was 334 at `ec642c6`, +4.8%; `plan_impact`
measured 347 mid-plan — the drift is ordinary growth).

| population      |   n | p50 | p75 | p90 | p95 | max | mean |
| --------------- | --: | --: | --: | --: | --: | --: | ---: |
| all modules     | 350 |   1 |  11 |  94 | 100 | 205 | 23.1 |
| non-test source | 190 |  10 |  91 |  98 | 114 | 205 | 42.6 |
| test modules    | 160 |   0 |   0 |   0 |   0 |   0 |  0.0 |

**`ec642c6`'s numbers reproduce exactly** — p50 = 10 is identical, p75 82 → 91 —
but only against the **non-test source** row. Bimodality is confirmed and is if
anything sharper than claimed: p50 → p75 is a 9× jump.

**⚠️ The most useful thing found here is a population mix-up, not a threshold
problem.** `ec642c6` wrote "334 modules … p50 = 10, p75 = 82" in one breath: 334 is
the **divisor** (all modules) while the percentiles are over **non-test source**
modules. Across all 350 modules p50 is **1**, because 160 test files are imported
by nothing. Anyone re-deriving the figures from the comment as written concludes it
is wrong. This is exactly the trap this task existed to avoid re-triggering, and it
is now stated explicitly in `reach.ts`.

### 2. Classification rates under the current cutoffs

HIGH needs reach ≥ 8 **and** ≥ 87.5. MEDIUM needs reach ≥ 4 **and** ≥ 35.0.

| population      |   n |          LOW |     MEDIUM |       HIGH |
| --------------- | --: | -----------: | ---------: | ---------: |
| all modules     | 350 |  277 (79.1%) |  23 (6.6%) | 50 (14.3%) |
| non-test source | 190 |  117 (61.6%) | 23 (12.1%) | 50 (26.3%) |
| test modules    | 160 | 160 (100.0%) |   0 (0.0%) |   0 (0.0%) |

Against the comment's claimed **60 / 18 / 22**: LOW is spot-on, MEDIUM drifted
−6 pt, HIGH +4 pt. **The HIGH band is a useful minority — neither empty nor half
the tree**, which is the question the task posed. Band boundaries intact.

### 3. Which condition binds, and is 0.25 a knife-edge?

| floor \ share |   10% |   15% |   20% |   25% |  30% |  35% |  40% |
| ------------- | ----: | ----: | ----: | ----: | ---: | ---: | ---: |
| 4             | 20.9% | 20.3% | 20.3% | 14.3% | 4.0% | 2.0% | 2.0% |
| 8             | 20.9% | 20.3% | 20.3% | 14.3% | 4.0% | 2.0% | 2.0% |
| 16            | 20.9% | 20.3% | 20.3% | 14.3% | 4.0% | 2.0% | 2.0% |
| 32            | 20.9% | 20.3% | 20.3% | 14.3% | 4.0% | 2.0% | 2.0% |
| 64            | 20.3% | 20.3% | 20.3% | 14.3% | 4.0% | 2.0% | 2.0% |

**The share does all the work; the absolute floor is inert here.** Floor-8 alone
would mark 110/350 (31.4%) HIGH — 58% of non-test source, i.e. the "roughly half"
the original comment warned about. Adding the share cuts that to 50 (14.3%). Rows
for floors 4/8/16/32 are *identical* at every share ≥ 10%: no module sits between
the floor and the share cut.

**⛔ That is NOT an argument for deleting the floor.** The floor is calibrated for
*small* projects — the comment's own 3-file case, where one importer is 33% of the
tree. Being inert on a 350-module repo is the expected result. Deleting it would
over-fit to this repo. Recorded in `reach.ts` so nobody "simplifies" it away.

**Is 0.25 a knife-edge? Somewhat — and every alternative is worse.** The curve is
steep there (20.3% → 14.3% → 4.0% across 20/25/30%). The flat plateaus are 15–20%
(20.3% overall ≈ 37% of non-test source — too close to "half the tree" again) and
35–40% (2.0% — too rare to triage with). 0.25 is a defensible interior choice, and
the distribution that produced it three days ago is unchanged. **Re-deriving it
would re-break a just-fixed formula for no measured gain.**

### 4. ⚠️ Task 1's HIGH-rate delta — the headline number

Corpus: every commit touching exactly one `docs/plans/*.md` — the commits where an
agent finished a task. Real changesets, paired with the plan **as read at that SHA**.
`before` scores with an empty `specFiles` (production's permanent state before
Task 1); `after` scores with the real one.

| changeset               | scenarios | HIGH before |  HIGH after | newly HIGH |
| ----------------------- | --------: | ----------: | ----------: | ---------: |
| work files only         |        50 |   9 (18.0%) |  45 (90.0%) | 36 (72.0%) |
| + the plan file         |        50 |   9 (18.0%) | 50 (100.0%) | 41 (82.0%) |
| source files only       |        44 |  9 (20.5%) |  32 (72.7%) | 23 (52.3%) |
| source, minus generated |        44 |  9 (20.5%) |  20 (45.5%) | 11 (25.0%) |

Skipped: 35 plans with no parseable `Files:` block, 3 checkbox-only commits, 24
commits touching several plans (which plan was active is genuinely ambiguous).

**Headline: the HIGH rate at least doubles — 20.5% → 45.5% on the cleanest arm, and
18% → 90% on the raw production-shaped one.** The four arms exist because the raw
number is inflated by files no plan would ever list: lockfiles, `CHANGELOG.md`,
`.github/`, review JSONs, and — in 23 of 44 scenarios — the generated
`src/cli/embedded-assets.ts`. Excluding only that generated file moves the newly-HIGH
rate from 52.3% to 25.0%.

**The restored signal is real, not an artifact.** 76 distinct source paths were
flagged across the corpus with a long tail (max 3 occurrences each once the generated
file is excluded) — `src/index.ts`, `src/memory/types.ts`, `src/cli/commands/sidecar.ts`
and many `*.test.ts` files that TDD forced a task to touch without the plan naming
them. Plans genuinely under-predict roughly half of what implementation touches,
which is precisely Assumption 3 of this plan, now quantified.

**Independent confirmation of the reach cutoffs:** `HIGH before` is 18–20.5% on real
changesets, produced by reach alone. That is the same useful-minority rate the module
distribution predicts (14.3%), arrived at by a completely different route — real git
history rather than the static graph. The cutoffs behave on real data as designed.

### 5. ⛔ Finding that is NOT about the thresholds — `hasUnexpected` now dominates

`scoreRisk` is `hasUnexpected || isHighReach(...)`. With `hasUnexpected` firing on
45–100% of real changesets, **the reach thresholds are largely unreachable as a
differentiator in production**: HIGH is decided by plan compliance before reach is
consulted. The Risks table predicted "previously-LOW runs go HIGH … looks like a
regression"; the measured shape is stronger than that — on the raw arm the score is
close to constant.

**No reach cutoff change can fix this, which is why nothing was changed.** Loosening
reach does not reduce the 45–100% (`hasUnexpected` still fires); tightening it makes
things worse. The lever is `hasUnexpected`'s standing inside `scoreRisk` — e.g.
excluding generated/vendored paths from the unexpected set, or demoting a
lone-unexpected-file to MEDIUM. **That is `impact.ts` (Task 8's file) and outside this
task's declared scope. Recorded here as a follow-up, deliberately not actioned.**

### 6. Other granularity models — informative only (D1)

| model      |   n | p50 | p75 | p90 | p95 | max | HIGH under 25% |
| ---------- | --: | --: | --: | --: | --: | --: | -------------: |
| transitive | 350 |   1 |  11 |  94 | 100 | 205 |     50 (14.3%) |
| single-hop | 350 |   1 |   2 |   6 |  10 | 102 |       1 (0.3%) |

**A symbol-level universe was NOT measured.** It requires an external code-graph
server, none is catalogued in this worktree, and under D1 nothing would ever score
from it — so it is informative at best and was not worth the setup. Single-hop reach
is free from the same graph and makes the point just as well: **same files, same
universe, different model — and the HIGH band collapses from 14.3% to 0.3%.** D1's
argument, reproduced with this repo's own numbers.

### Corrections applied to `src/analysis/reach.ts` (comment only)

| Was                            | Now                                                | Why                                              |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| "334 modules … p50 = 10, p75 = 82" | 350 modules; p50 = 10 / p75 = 91 over non-test source | Two populations in one sentence; not reproducible |
| "roughly half of all files"    | "110 of 350 modules, 58% of non-test source"       | Vague → checkable                                |
| "60% LOW / 18% MED / 22% HIGH" | "61.6% / 12.1% / 26.3% over non-test source"       | Refreshed + population named                     |
| `ownership.ts` "89 modules"    | "98 modules, 28%"                                  | Refreshed; still HIGH                            |
| —                              | "do not delete the floor because it does nothing here" | Measured inert; pre-empts a wrong simplification |

### Definition of Done

- [x] `scripts/measure-reach-thresholds.ts` produces percentile + classification-rate tables
- [x] Explicit written verdict: **cutoffs justified, unchanged**
- [x] HIGH-rate before/after Task 1 quantified — 20.5% → 45.5% (clean) / 18% → 90% (raw)
- [x] Verdict block appended to this plan with the date
- [x] Not changed, so no threshold test needed updating; the rationale comment was corrected anyway
- [x] `bun test` 0 failures
