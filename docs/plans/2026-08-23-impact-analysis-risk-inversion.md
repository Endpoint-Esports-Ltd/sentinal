# impact_analysis Risk Inversion Fix Plan

Created: 2026-08-23
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: Yes
Type: Bugfix

## Summary

**Symptom:** `impact_analysis` scores a two-line comment change as **HIGH** risk, while a semantic change to a safety-critical function that reaches 13 symbols scores at most **MEDIUM**. It also reports importers that are not importers.

**Trigger:** Every invocation. Measured 2026-08-23 against this repo.

**Root Cause:** Two independent defects.

1. **`src/analysis/mcp-tools.ts:326-328`** — the risk formula makes a _style_ signal dominant and caps the only _structural_ signal below it:

   ```ts
   let risk: RiskLevel = "LOW";
   if (hasUnexpected || hasLimitViolation) risk = "HIGH";
   else if (changedFiles.some((f) => f.importerCount > 3)) risk = "MEDIUM";
   ```

   `hasLimitViolation` is `lineCount > 400` (`:317`). `importerCount` is the only measure of reach, and it sits in the `else if` — **so structural impact can never produce HIGH.** The tool named "impact analysis" cannot let impact drive its top score.

2. **`src/analysis/helpers.ts:130-148`** — `countImporters` approximates imports with a basename grep:

   ```ts
   grep -rl "from.*<basename>" --include=*.ts src
   ```

   This is file-granular, single-hop, and substring-matched. It produces **false positives** (barrel re-exports, comments, any file whose name contains the substring) and **false negatives** (any caller that reaches the symbol transitively).

## Investigation

Measured on this repo, changing `src/runtime/ownership.ts` (adding two comment lines):

|                   | Result                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| `impact_analysis` | `Risk: HIGH — 402 lines, 12 importers` + "over the 400-line limit"                      |
| Why HIGH          | The file is **2 lines over a length threshold**. Nothing about what the change reaches. |

For "what calls `maySignalGroup`?" — the signalling gate every kill path in `src/runtime/` funnels through:

| Method                                       | Answer                                          |
| -------------------------------------------- | ----------------------------------------------- |
| `rg -l` (what `countImporters` approximates) | 4 files                                         |
| A real call graph, inbound                   | **7 callers across 5 files, with hop distance** |

The two barely overlap:

- **False positive:** `src/index.ts:329` is a **barrel re-export**, not a caller. `countImporters` counts it.
- **False negatives:** `worktree-deps.ts`, `lifecycle.ts`, `lifecycle-mcp-tools.ts` are real transitive callers. **`worktree-deps.ts` contains ZERO textual occurrences of `maySignalGroup`** — grep could never find it.

That last one is not academic: `worktree-deps.ts:stopOwnedRuntime` is the injection seam reaching `manager.ts`'s `abandon`/`squashMerge` — the exact paths the Phase 4 review flagged as able to delete a directory without stopping a process. **The tool shipped today cannot see that edge.**

### Working example — already in this repo, in the wrong place

`src/runtime/no-module-cycle.test.ts:28-71` already does parsed-import resolution correctly:

- `importsOf(path)` (`:28-39`) — extracts specifiers from `from "…"`, `require("…")` **and** `import("…")`
- `offendersIn(file)` (`:63-71`) — resolves each relative specifier against the importing file's directory, strips the extension, and compares **resolved paths**

It was built during Phase 3 of the runtime-isolation work and lives in a test file. Fix 2 is largely promoting it to a shared module — not inventing anything.

### Prerequisite

`src/analysis/mcp-tools.ts` is **602 lines**, over Sentinal's own **600-line hard block**. The file-length hook will refuse an edit to `:326`. A split must land first — same pattern as `manager.ts` in Phase 4.

`src/analysis/helpers.ts` (162 lines) has **no companion test file**.

## Behavior Contract

### Fix Property (C ⇒ P)

**When C:** a changed file's resolved import reach exceeds the high threshold (transitive, parsed-import based).
**Then P:** risk is **HIGH**, and the output names the reach, not merely the line count.

**When C:** a file appears in the importer set only via a barrel re-export or a comment.
**Then P:** it is **not** counted as an importer.

### Preservation Property (¬C ⇒ unchanged)

**When ¬C:** no unexpected files, low reach, no over-limit file → risk stays **LOW**, byte-identical output.
**When ¬C:** a file is genuinely over 400 lines → the length **warning** is still emitted. It simply no longer dominates the risk score on its own.
**Unexpected-file detection is unchanged** — `hasUnexpected` remains a HIGH trigger. That signal is about plan compliance and is correct today.

## Fix Approach

**Strategy:** split to clear the block, promote the proven import resolver, re-weight the formula so reach can reach HIGH, then add a seam so an external graph can supply better reach when one exists.

**Files:**

- Split: `src/analysis/mcp-tools.ts` (602) → extract `impact_analysis` into `src/analysis/impact.ts`
- Modify: `src/analysis/helpers.ts` — replace `countImporters`
- Create: `src/analysis/imports.ts` — parsed-import resolution, promoted from `no-module-cycle.test.ts:28-71`
- Create: `src/analysis/imports.test.ts`, `src/analysis/impact.test.ts`
- Modify: `src/analysis/mcp-tools.test.ts`

**Optional-graph seam (approved scope):** `impact_analysis` accepts an optional reach provider. When absent it uses the built-in resolver (fixes 1+2). When present it defers to it. Sentinal **never depends** on an external graph; this only makes a better answer possible. Do **not** wire any specific external tool in this plan.

**Tests:** regression tests must exercise `impact_analysis` through its registered MCP handler, not the internal helpers — the bug is in the composed result.

## Progress

- [x] Task 1: Split `mcp-tools.ts` to clear the 600-line block
- [x] Task 2: Regression tests (RED) for both defects
- [x] Task 3: Fix both defects
- [x] Task 4: Optional reach-provider seam
- [x] Task 5: Verify

**Tasks:** 5 | **Done:** 5 | **Left:** 0

## Tasks

### Task 1: Split `mcp-tools.ts`

**Objective:** Extract `impact_analysis` into `src/analysis/impact.ts` so the file drops under 600 and `:326` becomes editable. Extraction only — no logic change.
**Files:** `src/analysis/mcp-tools.ts`, new `src/analysis/impact.ts`
**Verify:** `bun test src/analysis/ && bunx tsc --noEmit && test $(wc -l < src/analysis/mcp-tools.ts) -lt 600`

### Task 2: Regression tests (RED)

**Objective:** Pin both defects before fixing. Each test must fail against current behaviour.
**Files:** `src/analysis/impact.test.ts`, `src/analysis/imports.test.ts`
**TDD:** these four must go RED first —

1. a comment-only change to a 402-line file is **not** HIGH on length alone
2. a change with high transitive reach **is** HIGH
3. a barrel re-export is **not** counted as an importer
4. a transitive caller with zero textual occurrences **is** found

**Verify:** `bun test src/analysis/` — expect failures, and record them.

**Recorded RED (2026-08-23, `bun test src/analysis/impact.test.ts` → 1 pass / 4 fail):**

| # | Test | Expected | Actual (pre-fix) |
| --- | --- | --- | --- |
| 1 | 402-line comment-only change not HIGH | `Risk: **LOW**` | `Risk: **HIGH** (action required)` — sole cause "over 400-line limit" |
| 2 | high transitive reach is HIGH | `Risk: **HIGH**` | `Risk: **LOW**` — `1 importer` found for a file with **9** transitive importers |
| 3 | barrel re-export not an importer | `1 importer` | `2 importers` — the `export * from "./target3.js"` barrel was counted |
| 4 | transitive caller with zero textual occurrences | `2 importers` | `1 importer` — `leaf4.ts` invisible to grep |

Test 2 is a stronger RED than the plan predicted: the grep does not merely cap the
result at MEDIUM, it returns **LOW**, because none of the 8 leaf callers contain the
substring `target` at all.

### Task 3: Fix both defects

**Objective:** Promote the resolver; re-weight the formula.
**Files:** new `src/analysis/imports.ts`, `src/analysis/helpers.ts`, `src/analysis/impact.ts`
**Notes:** port `importsOf`/`offendersIn` from `no-module-cycle.test.ts:28-71` — including `require()` and dynamic `import()`, which the grep never handled. Length becomes a warning, not a HIGH trigger. `hasUnexpected` stays HIGH.
**Verify:** `bun test src/analysis/ && bunx tsc --noEmit`

**⚠️ Invalidated assumption — a flat reach threshold does not work.**

The plan assumed "reach exceeds the high threshold" could be a single number.
Measured on this repo (334 modules) after the resolver landed, transitive reach
is sharply bimodal: **p50 = 10, p75 = 82, max = 198**. Closure saturates through
hub modules, so a flat threshold of 8 marks ~50% of files HIGH — the original
defect with a new cause.

Each tier therefore needs an absolute floor **and** a share of the module tree
(`HIGH_REACH_MIN = 8` ∧ `≥ 25%`; `MEDIUM_REACH_MIN = 4` ∧ `≥ 10%`). The share
alone is also insufficient — in a 3-file project one importer is 33%.

Resulting distribution on this repo: **60% LOW / 18% MEDIUM / 22% HIGH**, with
`src/runtime/ownership.ts` HIGH on reach (89 modules) rather than on line count.
Pinned by `impact.test.ts` — "should not call the same absolute reach HIGH in a
much larger codebase".

### Task 4: Optional reach-provider seam

**Objective:** Allow an external graph to supply reach; degrade to the built-in resolver when absent.
**Files:** `src/analysis/impact.ts`
**Notes:** absent provider ⇒ behaviour identical to Task 3, asserted by test. No external tool wired here.
**Verify:** `bun test src/analysis/`

### Task 5: Verify

**Objective:** Full suite + quality checks; confirm no regression in the tools that consume `impact_analysis`.
**Verify:** `bun run embed-assets && bun test && bunx tsc --noEmit`

**Result (2026-08-23):** `2509 pass / 0 fail` across 309 files; `tsc --noEmit` 0 errors;
prettier clean on all touched files.

### Note — `no-module-cycle.test.ts` keeps its own copy of the resolver

It is **not** refactored to import `src/analysis/imports.ts`. The two need
opposite treatment of re-exports: `imports.ts` excludes `export … from` (a
barrel forwards a symbol, it does not call it), while the cycle guard must
count it, because `export * from "../runtime/loader.js"` closes a
`worktree → runtime` cycle exactly as an import would — the
indirect-through-the-barrel case its own doc comment calls out. Sharing the
resolver would silently disable half the guard, and would also couple an alarm
to the code it is alarming on. Rationale recorded in the test file.

### Final line counts

| File | Lines |
| --- | --- |
| `src/analysis/mcp-tools.ts` | 414 (was 602, over the 600 hard block) |
| `src/analysis/impact.ts` | 352 |
| `src/analysis/imports.ts` | 211 |
| `src/analysis/helpers.ts` | 154 |

All under the 400-line warn threshold.
