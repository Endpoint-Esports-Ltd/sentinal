# Shipped Rules Reference Stale Memory Tools (+ add recall to decision points) Fix Plan

Created: 2026-07-18
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Bugfix

## Summary

**Symptom:** Shipped Sentinal rules document a **renamed/removed memory interface**. They tell the agent to call `mem-search`, `save_memory`, `get_observations`, and `mcp__plugin_sentinal_mem-search__*` with observation types `bugfix/feature/refactor/change`. None of these exist — the real MCP server is `sentinal` with tools `memory_search`/`memory_save`/`memory_get`/`memory_timeline`/`memory_stats`/`memory_share` and types `decision/discovery/error/fix/pattern`. An agent that follows these rules calls non-existent tools and silently fails to use memory. **Bundled enhancement:** even where memory *is* correctly named, it's absent from the always-loaded discovery/debugging decision points where recall pays off.

**Trigger:** Any session where the agent consults `mcp-servers.md`, `research-tools.md`, or `sentinal-memory.md` (all always-loaded) to use memory, or follows `sync.md`'s core-server list.

**Root Cause:** Shipped rule/command docs predate a memory-subsystem consolidation. The tools were renamed from a separate `mem-search` server (`search`/`timeline`/`get_observations`/`save_memory`) to the single `sentinal` server's `memory_*` tools (verified: `src/memory/mcp-tools.ts:75` `memory_search`, `:257` `memory_save`, types enum at `:267` = `decision/discovery/error/fix/pattern`; server name `sentinal` in `targets/claude-code/.mcp.json:3` and `targets/opencode/opencode.json:75`). The docs were never updated. The strings `mem-search`/`save_memory`/`mcp__plugin_sentinal_mem-search` exist NOWHERE in `src/`.

## Investigation

**Stale references (verified via rg, both targets):**

- `mcp-servers.md` — the whole `### mem-search — Persistent Memory` section (OC+CC `:15-42`): server name, 3-step tool table (`search`/`timeline`/`get_observations`), `save_memory` params, wrong types (`:34` `bugfix/feature/refactor/discovery/decision/change`), and `mcp__plugin_sentinal_mem-search__*` code examples (`:37-42`). Also the tool-selection row `:128` (`mem-search | search → timeline → get_observations`).
- `research-tools.md` — tool-selection row `:23` (`Past work / decisions | mem-search (MCP) | search → timeline → get_observations`).
- `sentinal-memory.md` — `:20` "See also `mcp-servers.md` → mem-search for the external 3-step search workflow." (dangling ref to the stale section).
- `sync.md` (commands, OC+CC `:435,:439`) — lists `mem-search` as a "Sentinal core MCP server" to skip; the server is actually `sentinal`.

**Actual tool signatures (source of truth, `src/memory/mcp-tools.ts`):**

- `memory_search({ query: string, project?: string, type?: enum, limit? })` — returns a compact index of IDs+titles.
- `memory_timeline({ anchor: number, depth?: number, project? })` — NOT `depth_before`/`depth_after`.
- `memory_get({ ids: number[] })`.
- `memory_save({ title, content, type: decision|discovery|error|fix|pattern, project, tags?, shared? })` — NOT `save_memory({ text, title })`.
- `memory_stats`, `memory_share` also exist.

**Working reference (already-correct doc to mirror):** `sentinal-memory.md:7-14` has the CORRECT tool table (`memory_save`/`memory_search`/`memory_get`/`memory_timeline`/`memory_stats`/`memory_share`). The fix makes the other rules consistent with this one.

**Enhancement gaps (always-loaded rules, no `paths:` scoping ⇒ every turn):**

- `research-tools.md` "Search Priority" (`:5` "Vexor first, always") omits memory from the discovery chain — memory of a past decision should be checked before re-deriving it.
- `development-practices.md` has decision points that mirror what we just added to the spec skills but with NO memory cue: "Codebase Search — Vexor First", "Systematic Debugging → Phase 1: check recent changes", and "3+ failed fixes = architectural problem." These govern ALL ad-hoc (non-`/spec`) work.

**Naming note:** OpenCode surfaces MCP tools as `sentinal_<tool>` (server prefix). The `mcp__plugin_sentinal_mem-search__*` form is doubly wrong (wrong server + wrong tool). Docs should use the bare `memory_search` form consistent with `sentinal-memory.md` and the skills.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** An agent consults any shipped rule/command to use Sentinal memory, or follows `sync.md`'s core-server list.
**Property P must hold:** Every memory reference names a REAL tool (`memory_search`/`memory_save`/`memory_get`/`memory_timeline`/`memory_stats`/`memory_share`) with correct params and real types (`decision/discovery/error/fix/pattern`); the server is named `sentinal`; no `mem-search`/`save_memory`/`get_observations`/`mcp__plugin_sentinal_mem-search`/`bugfix|feature|refactor|change`-type strings remain in shipped rules/commands. Additionally, `research-tools.md` and `development-practices.md` cue `memory_search` at their discovery/debugging decision points.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** The already-correct `sentinal-memory.md` tool table, all non-memory rule content, and the spec-skill memory integration from the prior plan.
**Existing behavior preserved:** No change to correct memory docs, to non-memory guidance, or to the memory tool implementations. Other core servers in `sync.md` (context7/web-search/web-fetch/grep-mcp) unchanged.

## Fix Approach

**Files (both targets unless noted):**

- `targets/{opencode,claude-code}/rules/mcp-servers.md` — rewrite the `mem-search` section as `memory` under the `sentinal` server: correct tool names/params, real types, remove `mcp__plugin_sentinal_mem-search__*` examples (use bare `memory_*` names), fix the `:128` selection row, and align the naming-convention note at `:11` (should-fix) with the bare `memory_*` snake_case form.
- `targets/{opencode,claude-code}/rules/research-tools.md` — fix the `:23` selection row (`memory_search`); add memory to the "Search Priority" chain ("check `memory_search` for prior decisions alongside Vexor").
- `targets/{opencode,claude-code}/rules/sentinal-memory.md` — fix the dangling `:20` reference; tighten the passive "before starting work" line into a concrete recall cue.
- `targets/{opencode,claude-code}/rules/development-practices.md` — add a `memory_search` cue at "Systematic Debugging → Phase 1 (check recent changes)" and at "3+ failed fixes = architectural" (recall prior errors/decisions before re-deriving). Best-effort wording.
- `targets/{opencode,claude-code}/commands/sync.md` — replace `mem-search` with `sentinal` in the core-server exclusion list (`:435`,`:439`).
- Regenerate `src/cli/embedded-assets.ts` via `bun run embed-assets`.
- `src/cli/rules-memory-refs.test.ts` (new) — regression test.

**Strategy:** Mirror the already-correct `sentinal-memory.md:7-14` table as the canonical shape. Keep enhancement wording lean and best-effort (never-block), consistent with the spec-skill memory work. Do NOT bloat always-loaded rules — correct existing refs + add cues only at the 2-3 real decision points.

**Tests:** New `src/cli/rules-memory-refs.test.ts` (target-assets style):

1. **No-stale guard (identifier strings only):** walk every `targets/{opencode,claude-code}/rules/*.md` AND `commands/sync.md` and assert NONE contain the UNAMBIGUOUS stale identifiers `mem-search`, `save_memory`, `get_observations`, or `mcp__plugin_sentinal_mem-search`. Fail-loud listing offenders. ⚠️ **Do NOT globally grep the type words `bugfix|feature|refactor|change`** — reviewer confirmed 46 legitimate non-memory matches (e.g. "OnPush change detection", "feature", "refactor"). Instead, scope the observation-type check to the single known offender: assert `mcp-servers.md` (both targets) does NOT contain the literal stale `**Types:**` line (`bugfix`, `feature`, `refactor`, `change` listed together as memory types) — match the specific line, not the bare words.
2. **Presence guard:** `research-tools.md` and `development-practices.md` (both targets) contain `memory_search`.
3. **Delivery guard (BOTH embedded records):** rules embed into TWO separate records — `EMBEDDED_RULES` (OpenCode, embed-assets.mjs:173) and `EMBEDDED_CC_RULES` (Claude Code, :234). Assert `mcp-servers.md`/`research-tools.md` in BOTH `EMBEDDED_RULES` AND `EMBEDDED_CC_RULES` contain `memory_search` and NOT `mem-search`. (Test 3 must not check only the OpenCode record.)

**Defense-in-depth:** The no-stale regression test permanently prevents the renamed interface (or any future rename drift) from reappearing in shipped rules.

## Progress

- [x] Task 1: Fix stale refs + add recall cues (both targets) + embed + regression test
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write the no-stale/presence regression test (RED) → correct all stale memory refs in mcp-servers/research-tools/sentinal-memory/sync + add recall cues in research-tools/development-practices (both targets) → `embed-assets` → test GREEN.
**Files:** `src/cli/rules-memory-refs.test.ts`; `targets/{opencode,claude-code}/rules/{mcp-servers,research-tools,sentinal-memory,development-practices}.md`; `targets/{opencode,claude-code}/commands/sync.md`; regenerated `src/cli/embedded-assets.ts`.
**TDD:**
1. Write `rules-memory-refs.test.ts` — no-stale + presence + embedded guards. Run → RED (stale strings present; embedded stale).
2. Correct the stale references (mirror `sentinal-memory.md:7-14` shape); add the recall cues.
3. `bun run embed-assets`.
4. Re-run → GREEN.
**Verify:** `bun test src/cli/rules-memory-refs.test.ts --verbose` and `rg -n "mem-search|save_memory|mcp__plugin_sentinal_mem-search" targets/*/rules targets/*/commands/sync.md` returns nothing.

### Task 2: Verify

**Objective:** Full suite + type check + delivery-path confirmation.
**Verify:** `bun test && bunx tsc --noEmit`; confirm `EMBEDDED_RULES` has no `mem-search`; `bun scripts/check-embed-assets.mjs` passes.
