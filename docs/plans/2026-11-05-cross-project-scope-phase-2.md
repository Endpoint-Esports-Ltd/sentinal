# Related Projects + Foreign Context

Created: 2026-11-05
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: 2026-11-05-cross-project-scope
Wave: 2

## Summary

**Goal:** A project can declare related projects in `.sentinal/related.json`; the first time a
session edits a file in another project, that project's `.sentinal/rules` reach the agent (once,
capped, re-injected after compaction); `memory_search` can search the session project plus its
related projects; session start lists related projects.
**Architecture:** Two pure modules in `src/project/` (`related.ts` loader, `foreign-rules.ts`
reader/filter/formatter) consumed by: the Claude Code PreToolUse pre-edit dispatch (marker file
for once-per-session), the OpenCode `experimental.chat.system.transform` hook (in-memory, total
cap), the `memory_search` MCP tool (per-project fan-out, no sidecar change) and the restore
markdown builder (related index).
**Tech Stack:** TypeScript, Bun, zod, Claude Code hooks, OpenCode plugin, MCP.
**Master plan:** `docs/plans/2026-11-05-cross-project-scope.md` (Context → decisions 2, 3, 5 and
"Rules-injection state", "Undeclared foreign projects"). **Depends on Phase 1**:
`resolveFileProject` (`src/project/file-project.ts`), `metadata.sessionProject` on captured
observations, and OpenCode's `touchedProjects` set.

## Scope

### In Scope

- `.sentinal/related.json` schema + loader; `.sentinal/.gitignore` allowlists it.
- Foreign rules injection on first **edit** in a foreign project (CC + OC), with `paths:`
  frontmatter filtering, per-project and total caps, overflow pointer list, re-injection after
  compaction.
- OpenCode: make the pre-edit memory hint model-visible (pushed once via `system.transform`).
- `memory_search` `scope: "project" | "related" | "all"`.
- Restore markdown: "Related projects" index (declared + undeclared foreign projects this
  project's sessions captured memories for).
- Shipped prose (`sentinal-memory.md`, `/sync`), README, `.sentinal/rules/sentinal-mcp-servers.md`.

### Out of Scope

- `memory_timeline` scope (anchor-based; project filter stays as is).
- Restoring related projects' memories or shared memory at session start (decided: index only).
- Rules injection on **Read** (decided: edits only).
- Cross-repo master plans (Phase 3).

## Context for Implementer

- **Phase 1 contracts used here:** `resolveFileProject(filePath, session) → {identity,
  workspace, foreign}`; `sessionRootsFromCwd(cwd)`. Observations captured for a foreign file are
  keyed by the file's identity and carry `metadata.sessionProject = <session identity>`.
  OpenCode plugin keeps `touchedProjects` (foreign identities) — Phase 2 needs the **workspace**
  too, so extend it to a `Map<identity, workspace>` (Task 5 owns that change).
- **`related.json`** (committed, at `<workspace>/.sentinal/related.json`):
  ```json
  { "projects": [ { "name": "api", "path": "../api" }, { "path": "/abs/web" } ] }
  ```
  zod schema; `name` optional (defaults to the basename); `path` relative to the declaring
  **workspace** (the checkout holding the file) or absolute. Loader
  `loadRelatedProjects(workspace) → { projects: RelatedProject[]; warnings: string[] }` where
  `RelatedProject = { name, path (realpath), identity, exists, hasRules }`. Missing file → empty,
  no warning. Invalid JSON/schema → empty + warning. Non-existent path → kept with
  `exists: false` (reported, never searched). Identity via `resolveProjectIdentity(path)` —
  one git spawn per entry; callers are the MCP server and the sidecar, not hot hooks. Never
  throws. Drop entries whose identity equals the declaring project's.
- **`.sentinal/.gitignore`** (`src/memory/shared.ts:271-330`): add `!related.json` to
  `GITIGNORE_CONTENT`, and append the **current** content (v3) byte-for-byte as a new
  `KNOWN_PRIOR_GITIGNORES` entry so existing projects upgrade (anything else is user-customized
  and left alone). `injected-rules.json` needs nothing (ignored by `*`). `ensureGitignore` only
  runs from `writeSharedMemory` and `sentinal install|update`, so a hand-written `related.json` in
  a project that has not reinstalled stays ignored: `loadRelatedProjects` callers that find a
  `related.json` also call `ensureSentinalGitignore(workspace)` (cheap, idempotent, never
  throws), and if the file is still ignored (user-customised `.gitignore`) the restore index and
  `/sync` say so ("`.sentinal/related.json` is gitignored — add `!related.json`").
- **Foreign rules** (`src/project/foreign-rules.ts`):
  - `readProjectRules(workspace) → RuleFile[]` (`*.md` in `<workspace>/.sentinal/rules`,
    sorted; `{path, name, paths?: string[], body}`; frontmatter `---` block with a `paths:` YAML
    list of quoted/unquoted globs; parse only that key; strip the frontmatter from `body`).
  - `rulesForFile(rules, fileRelPath)`: a rule with `paths` applies only if a glob matches the
    file path relative to the workspace (`**`, `*`, `?` — small `globToRegExp`; no dependency);
    no `paths` → always applies. (OpenCode itself ignores `paths:`; applying it here is
    deliberate and consistent with Claude Code's own rule loading.)
  - `formatForeignRules({projectName, workspace, rules, maxChars})` → markdown block:
    header `[Sentinal] Rules for <name> (<workspace>) — you are editing files in this project:`,
    rule bodies in order until `maxChars`; the remainder becomes a pointer list
    (`- <abs path> — <first heading>`), with "Read these files before editing further".
  - Caps: per project `FOREIGN_RULES_MAX_CHARS = 12_000`; OpenCode total across projects
    `FOREIGN_RULES_TOTAL_CHARS = 24_000` (later projects degrade to pointer lists).
- **Claude Code injection** (Task 3): in `runPreEditGuide` (`src/cli/commands/hook.ts`, the
  PreToolUse Write/Edit/MultiEdit dispatch that already emits `hint("PreToolUse", …)`):
  1. Resolve the file's project (Phase 1). If not foreign, or no `.sentinal/rules` there → skip.
  2. Marker `<session workspace>/.sentinal/injected-rules.json` =
     `{ "<session_id>": ["<identity>", …] }`. If the identity is listed for this session → skip.
  3. Else append `formatForeignRules(...)` to the hint parts and record the identity (atomic
     write: temp + rename; corrupt file → treat as empty and overwrite).
  4. Clear: on `SessionStart` with source `compact` (`src/hooks/post-compact-restore.ts`) remove
     this session's entry — ⛔ **before** the early return at `post-compact-restore.ts:39`, which
     fires whenever `compact-state.json` is absent (every compaction without an active plan —
     the common ops case); on `SessionEnd` (`src/hooks/session-end.ts:57-64`, next to the
     event-buffer cleanup) remove this session's entry (delete the file when empty).
  Keep this logic in a new `src/hooks/foreign-context.ts` (testable, `hook.ts` only wires it).
  Wiring: `session = sessionRootsFromCwd(input.cwd)` (Phase 1), resolve a relative `filePath`
  against `input.cwd`, `file = resolveFileProject(filePath, session)`; the rule glob is matched
  against `relative(file.workspace, filePath)` — the **foreign** checkout, not the session's.
  Marker location: `<session workspace>/.sentinal/injected-rules.json` only when the session
  workspace is a git working tree (`.git` exists there). Otherwise (session started in `$HOME`
  or another non-repo directory, where `.sentinal/` is Sentinal's global runtime dir) use
  `~/.sentinal/injected-rules/<session_id>.json` — a dedicated subdirectory, cleaned by the same
  compact/end hooks.
- **OpenCode injection** (Task 4): plugin keeps `foreignRules: Map<identity, {name, workspace,
  text}>` built lazily on first edit of each foreign project (`tool.execute.before` for edit
  tools, after the Phase 1 resolver). In `experimental.chat.system.transform`
  (`sentinal.ts:1113-1191`, pushes into `systemArr`) push every cached block **every turn**
  (the prompt is rebuilt per turn) within the total cap. After compaction nothing to clear (the
  push is per turn). Also queue the pre-edit memory hint (`getPreEditGuide` result, today only
  logged) and push queued hints **once** on the next transform, then drop them (max 3 hints,
  newest first). Put formatting/caps logic in `src/opencode/foreign-context.ts`.
- **`memory_search` scope** (Task 2, `src/memory/mcp-tools.ts:112-170`): new optional
  `scope: z.enum(["project","related","all"])`.
  - `project` (default when `project` is given) — today's behaviour.
  - `all` (default when `project` is absent) — today's behaviour.
  - `related` — base = `project ?? process.cwd()`; identities = base identity + each
    `related.json` project with `exists` (loader on `resolveWorkspaceRoot(base)`); one search
    per identity (sidecar `client.memorySearch({query, project, type, limit})` or
    `service.search`), each already relevance-ranked; merge by **round-robin** over the
    per-project ranked lists (the results carry no comparable `score`), de-duplicate by id,
    truncate to `limit`. Each result row gains a `project` label in the
    rendered table. No sidecar change (works with old sidecars).
  - Description text must state the scopes (agents only see the description).
- **Restore index** (Task 2b): `src/memory/restore.ts` builds the session-start markdown in the
  **sidecar** (it has the store and receives `workspace`, `restore.ts:29,158-163`). Append
  `### Related projects` when there is anything to list:
  - declared: `- <name> — <path>` + `(rules)` if `hasRules` + `N memories` (count by
    `project_path`), `(missing)` when `!exists`;
  - undeclared: distinct `project_path` of observations whose
    `json_extract(metadata, '$.sessionProject') = <identity>` and not declared, with
    `N memories` and a one-line hint: "add to `.sentinal/related.json` to search with
    `memory_search({scope: "related"})`".
  - Cap 10 lines; add store helpers in `src/memory/store-observations.ts`
    (`countByProject(identity)`, `foreignProjectsCapturedFrom(identity)`), exposed through
    `MemoryStore` like existing helpers.
- **Shipped prose** (Task 6): `targets/{claude-code,opencode}/rules/sentinal-memory.md` (they are
  byte-identical today — keep them so; consider adding to `IDENTICAL_RULES` in
  `src/cli/target-parity.test.ts`) gain "Working in another repository": pass that repo's path
  as `project` to `memory_save`/`memory_search`/`quality_report`/`spec_register`; use
  `scope: "related"` to search related projects; declare them in `.sentinal/related.json`.
  `/sync` (`targets/*/commands/sync.md`, both identical in the relevant part) gains an optional
  step: if the project's rules mention sibling git repos, offer to draft `related.json` (show it,
  never write without confirmation). Regenerate parity baselines once
  (`UPDATE_PARITY_BASELINES=1 bun test src/cli/target-parity.test.ts`) and confirm only the
  intended `.diff` files changed (`git diff --stat src/cli/__fixtures__/target-parity/`).
- **Gotchas:** `src/project/*.ts` must stay `bun:sqlite`-free (bundled into the plugin;
  `src/cli/target-assets.test.ts`). CC hooks are fresh processes. Hook output has no size cap
  convention — the 12k cap is ours. After plugin edits: `bun run typecheck:plugin`,
  `bun run build:opencode`. TDD guard + file-length limits apply to `src/**`. Embedded assets:
  `src/cli/embedded-assets.ts` is **generated and not committed** (`scripts/check-embed-assets.mjs`);
  shipped `targets/*` changes reach the binary through `build:cli`. Do not commit it.
- **OpenCode "once" semantics.** OpenCode's system prompt is rebuilt every turn, so "inject once"
  there means "keep present for the rest of the session" (re-pushed each turn, under the 24k
  total cap). This is the deliberate OpenCode equivalent of Claude Code's once-per-session
  `additionalContext`, which stays in the transcript; the README records the difference.

## Assumptions

- Phase 1 delivers `resolveFileProject`, `metadata.sessionProject` and `touchedProjects` as
  specified in its plan — Tasks 2b, 3, 4.
- Restore runs in the sidecar with a `MemoryStore` and the session workspace
  (`restore.ts:29,158-163`, `memory-routes.ts:113-127`) — Task 2b.
- `observations.metadata` is JSON text queryable with `json_extract` (SQLite JSON1, built into
  Bun's SQLite) — Task 2b. Verify early; fall back to a `LIKE` pre-filter + JS parse.
- `experimental.chat.system.transform` runs every turn and its array is rebuilt each time
  (`sentinal.ts:1113-1191`, notification digest pattern) — Task 4.

## Testing Strategy

- Unit: loader (valid, relative/absolute, missing file, bad JSON, missing path, self-reference),
  rules reader (frontmatter, `paths` filter, caps, overflow pointers), glob matcher.
- Unit: CC `foreign-context` marker logic (first edit injects, second skips, other session
  injects, compact clears, end clears, corrupt marker), `runPreEditGuide` wiring.
- Unit: OC foreign-context formatter (total cap, per-turn push, hint queue once).
- Unit: `memory_search` scope fan-out with an injected client (per-project calls, merge,
  dedupe, limit) and store path.
- Unit: restore index (declared/undeclared/missing, cap).
- Parity test + target-assets test.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Context flood from large rule sets | Med | Med | Per-project 12k / OC total 24k caps; pointer list |
| Marker file races between parallel hooks | Low | Low | Atomic rename; worst case a duplicate injection |
| `related.json` silently ignored by `.gitignore` | High (without fix) | High | Allowlist + prior-content upgrade (Task 1) |
| Fan-out search slow with many related projects | Low | Low | Typical list is small; per-call limit; document |
| `json_extract` unavailable | Low | Low | LIKE pre-filter fallback |

## Pre-Mortem

1. **Rules never appear in Claude Code because the hint is dropped** (Task 3) → Trigger: the
   live `sentinal hook shared pre-edit-guide` run with a foreign file prints no
   `additionalContext`.
2. **Gitignore upgrade skips real projects** because their current file differs by a byte from
   the recorded prior content (Task 1) → Trigger: test with this repo's actual
   `.sentinal/.gitignore` does not upgrade.
3. **OpenCode shows rules only once** because the transform array is not rebuilt per turn as
   assumed (Task 4) → Trigger: a plugin test calling transform twice sees the block only in the
   first output.

## Execution Waves

**Wave 1** — Foundations: Task 1 (loader, rules reader, gitignore).
**Wave 2** — Consumers (parallel, disjoint files): Task 2 (`memory_search`), Task 2b (restore
index), Task 3 (CC injection), Task 4 (OC injection + hint).
**Wave 3** — Prose + docs: Task 6 (shipped rules, `/sync`, parity, README, dev rules).

## Goal Verification

### Truths

1. `src/project/related.ts` exports `loadRelatedProjects`; `src/project/foreign-rules.ts` exports
   `readProjectRules`, `rulesForFile`, `formatForeignRules`; both pass
   `bun test src/cli/target-assets.test.ts` (no `bun:sqlite`).
2. `grep -n "related.json" src/memory/shared.ts` shows `!related.json` in `GITIGNORE_CONTENT`.
3. Test: first CC edit of `B/x.ts` from session A emits B's rules in `additionalContext`; a
   second edit in the same session does not; after `SessionStart(compact)` it does again.
4. Test: OC transform output contains B's rules block on two consecutive turns after a B edit.
5. Test: `memory_search({query, scope: "related"})` from A returns observations keyed to A and
   to B (B declared), and none from undeclared C.
6. Test: restore markdown for A lists B under "Related projects" with its memory count, and an
   undeclared D that A's sessions captured memories for.
7. All gates pass: `bun test`, `bun run typecheck`, `bun run typecheck:plugin`, `bun run lint`,
   `bun run format:check`.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/project/related.ts` | related.json loader | `loadRelatedProjects`, `RelatedProject` |
| `src/project/foreign-rules.ts` | Rules read/filter/format | `readProjectRules`, `rulesForFile`, `formatForeignRules` |
| `src/hooks/foreign-context.ts` | CC once-per-session injection | `foreignRulesHint`, `clearInjectedRules` |
| `src/opencode/foreign-context.ts` | OC per-turn block builder | `buildForeignContext` |
| `src/memory/mcp-tools.ts` | `scope` param | `memory_search` |
| `src/memory/restore.ts` | Related index | restore markdown |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/cli/commands/hook.ts` | `src/hooks/foreign-context.ts` | PreToolUse hint | `foreignRulesHint` |
| `src/hooks/post-compact-restore.ts` | `foreign-context.ts` | compact clear | `clearInjectedRules` |
| `targets/opencode/plugins/sentinal.ts` | `src/opencode/foreign-context.ts` | system.transform | `buildForeignContext` |
| `src/memory/mcp-tools.ts` | `src/project/related.ts` | scope fan-out | `loadRelatedProjects` |
| `src/memory/restore.ts` | `src/project/related.ts` | index | `loadRelatedProjects` |

## Progress Tracking

- [x] Task 1: related.json loader, rules reader, gitignore allowlist (Wave 1)
- [x] Task 2: memory_search scope (Wave 2)
- [x] Task 2b: Restore related-projects index (Wave 2)
- [x] Task 3: Claude Code foreign rules injection (Wave 2)
- [x] Task 4: OpenCode foreign rules + model-visible pre-edit hints (Wave 2)
- [x] Task 6: Shipped prose, /sync, parity, README, dev rules (Wave 3)

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Notes

- **Task 1 — this repo's `.sentinal/.gitignore` is hand-maintained** (`!continue-here.md`), so it
  matches no `KNOWN_PRIOR_GITIGNORES` entry and never auto-upgrades (pre-mortem 2 is expected,
  not a bug): `!related.json` was added to it by hand and `src/memory/shared.test.ts` ("this repo's
  own .sentinal/.gitignore (R9)") now asserts `related.json` is not ignored. The byte-for-byte
  upgrade test uses the generated v3 content. The loader itself calls `ensureSentinalGitignore`
  when it finds a `related.json` and reports `gitignored` (via `git check-ignore`) + a warning.
- **Task 2** — fan-out lives in `src/memory/related-search.ts` (`searchRelated`,
  `mergeRoundRobin`). Explicit `scope: "project"` without `project` uses the cwd's identity.
  The `Project` column appears only for `scope: "related"`.
- **Task 2b** — the helpers live in `src/memory/store.ts` (not `store-observations.ts`, which is at
  400 lines) and `MemoryService` (restore receives a service). When the project has no memories of
  its own but related projects exist, restore returns just the index (`hasMemory: true`).
- **Task 3** — live check (`./dist/sentinal hook shared pre-edit-guide`, sibling repo `b` with one
  rule file, `SENTINAL_HOME` temp):
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[Sentinal] Rules for b (/private/var/…/x/b) — you are editing files in this project:\n\n<!-- …/b/.sentinal/rules/b.md -->\n# B conventions\nAlways use zod in B.\n"}}`.
  The home marker uses `getSentinalHome()` (honours `SENTINAL_HOME`), i.e.
  `~/.sentinal/injected-rules/<session>.json` by default. `post-compact-restore` clears for
  `source` absent or `compact`.
- **Task 4** — `touchedProjects` stays a `Set` (its consumer `handleCompactionAutocontinue` is
  unchanged); the identity → workspace map lives in `createForeignContext().touched()`. Path-scoped
  rules join a project's block once a matching file is edited. Edits = `write`, `edit`,
  `multiedit`, `patch`, `apply_patch`; reads never inject.
- **Review fixes (spec-reviewer, iteration 1)** — should_fix: the CC marker now records injected
  **rule-file paths** per session (`{ "<session_id>": ["<abs rule path>", …] }`) instead of
  identities, so a later edit matching another rule's `paths:` gets that rule (and only it) —
  same behaviour as OpenCode. Suggestions: `foreignProjectsCapturedFrom` guards with
  `json_valid(metadata)` (a malformed row no longer empties the index); `SearchRow` moved below
  the imports. Not changed: restore calls `loadRelatedProjects` uncached — one `existsSync`
  without a `related.json`, else one `git check-ignore` + one spawn per entry, once per session
  start/compaction.

## Implementation Tasks

### Task 1: related.json loader, rules reader, gitignore allowlist

**Objective:** Provide the pure building blocks every consumer uses.
**Dependencies:** None (Phase 1 complete)
**Wave:** 1

**Files:**

- Create: `src/project/related.ts`, `src/project/related.test.ts`
- Create: `src/project/foreign-rules.ts`, `src/project/foreign-rules.test.ts`
- Modify: `src/memory/shared.ts` (gitignore), `src/memory/shared.test.ts`

**Key Decisions / Notes:** Context → `related.json`, `.sentinal/.gitignore`, Foreign rules.

**Definition of Done:**

- [ ] Truths 1, 2
- [ ] Gitignore test: a file with the current (pre-change) content — copied byte-for-byte from
      this repo's `.sentinal/.gitignore` — upgrades; a customised file is untouched; a
      `related.json` in an un-upgraded project triggers the upgrade on load
- [ ] Loader and reader never throw (fuzz: unreadable dir, binary file, huge file)

**Verify:**

- `bun test src/project/ src/memory/shared.test.ts src/cli/target-assets.test.ts`

### Task 2: memory_search scope

**Objective:** `memory_search` can search the session project plus its related projects.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/memory/mcp-tools.ts`
- Test: `src/memory/mcp-tools.test.ts`

**Key Decisions / Notes:** Context → `memory_search` scope. Keep `src/memory/mcp-tools.ts` under
400 lines (291 today) — if the fan-out pushes it over, move it to
`src/memory/related-search.ts` (+ test) within this task.

**Definition of Done:**

- [ ] Truth 5; default behaviour unchanged for calls without `scope`
- [ ] Description lists the three scopes

**Verify:**

- `bun test src/memory/mcp-tools.test.ts`

### Task 2b: Restore related-projects index

**Objective:** Session start shows which related projects exist and where memories went.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/memory/restore.ts`, `src/memory/store-observations.ts`, `src/memory/store.ts`
  (expose helpers)
- Test: `src/memory/restore.test.ts`, `src/memory/store.test.ts`

**Key Decisions / Notes:** Context → Restore index. Index only — no related memories restored.

**Definition of Done:**

- [ ] Truth 6; no "Related projects" section when there is nothing to list
- [ ] Restore output unchanged for projects with no related/foreign data (existing tests pass)

**Verify:**

- `bun test src/memory/restore.test.ts src/memory/`

### Task 3: Claude Code foreign rules injection

**Objective:** First edit in a foreign project injects its rules once per session.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/hooks/foreign-context.ts`, `src/hooks/foreign-context.test.ts`
- Modify: `src/cli/commands/hook.ts` (`runPreEditGuide`), `src/hooks/post-compact-restore.ts`,
  `src/hooks/session-end.ts`
- Test: `src/cli/commands/hook.test.ts`, `src/hooks/post-compact-restore.test.ts`,
  `src/hooks/session-end.test.ts`

**Key Decisions / Notes:** Context → Claude Code injection.

**Definition of Done:**

- [ ] Truth 3, including a compaction with **no** `compact-state.json` (marker still cleared)
- [ ] Non-repo session cwd writes the marker under `~/.sentinal/injected-rules/`, never
      `~/.sentinal/injected-rules.json` (test with a temp `HOME`)
- [ ] Live check: `bun run build:cli`, pipe a PreToolUse payload for a sibling-repo file into
      `./dist/sentinal hook shared pre-edit-guide` and see the rules in `additionalContext`
      (record output excerpt in the plan)

**Verify:**

- `bun test src/hooks/foreign-context.test.ts src/cli/commands/hook.test.ts src/hooks/post-compact-restore.test.ts src/hooks/session-end.test.ts`

### Task 4: OpenCode foreign rules + model-visible pre-edit hints

**Objective:** OpenCode sessions see foreign rules every turn and pre-edit memory hints once.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/opencode/foreign-context.ts`, `src/opencode/foreign-context.test.ts`
- Modify: `targets/opencode/plugins/sentinal.ts`
- Test: `targets/opencode/plugins/sentinal.test.ts`

**Key Decisions / Notes:** Context → OpenCode injection. Extend Phase 1's `touchedProjects` to
carry the workspace.

**Definition of Done:**

- [ ] Truth 4; pre-edit hint pushed once then dropped
- [ ] `bun run typecheck:plugin`, `bun run build:opencode`, `bun test src/cli/target-assets.test.ts`

**Verify:**

- `bun test src/opencode/foreign-context.test.ts targets/opencode/plugins/ src/cli/target-assets.test.ts`

### Task 6: Shipped prose, /sync, parity, README, dev rules

**Objective:** Agents and users know how to work across repositories.
**Dependencies:** Tasks 2, 2b, 3, 4
**Wave:** 3

**Files:**

- Modify: `targets/claude-code/rules/sentinal-memory.md`, `targets/opencode/rules/sentinal-memory.md`,
  `targets/claude-code/commands/sync.md`, `targets/opencode/commands/sync.md`,
  `src/cli/target-parity.test.ts` (`IDENTICAL_RULES` += `sentinal-memory.md`),
  `src/cli/__fixtures__/target-parity/*` (regenerated), `README.md`,
  `.sentinal/rules/sentinal-mcp-servers.md`, `.sentinal/rules/sentinal-project.md`

**Key Decisions / Notes:** Context → Shipped prose. Use the `sentinal-parity-baselines` and
`sentinal-schema-prose-drift` skills before editing.

**Definition of Done:**

- [ ] Parity test passes; only `sync.diff` (if at all) changed in the fixture dir
- [ ] README documents `related.json`, foreign rules injection, `scope: "related"`
- [ ] Truth 7

**Verify:**

- `bun test src/cli/target-parity.test.ts && bun test && bun run typecheck && bun run typecheck:plugin && bun run lint && bun run format:check`

## Verification Report

- Runtime profile: Minimal (library, hooks, plugin). Build: `bun run build:cli`, `bun run build:opencode` OK.
- Gates (final code): `bun test` 4770 pass / 0 fail; `bun run typecheck`, `bun run typecheck:plugin`,
  `bun run lint`, `bun run format:check` clean.
- Code review (`spec-reviewer`): 0 must_fix, 1 should_fix (fixed: per-rule CC marker), 3 suggestions
  (2 applied, 1 documented). Truths 1–7 verified (Truth 7 by the gate run above).
- Parity: one regeneration; only `sync.diff` changed (1 hunk, header offset); `spec-verify.diff` 0 bytes.
- Not verified: OpenCode behaviour in a real OpenCode session (covered by plugin tests with SDK-shaped
  calls only).
