# Orca Worker Directory Access Without Prompts Implementation Plan

Created: 2026-10-01
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Pre-warmed OpenCode workers no longer stop at "Permission required — Access external
directory" when they read the coordinator's checkout or the repo's main checkout. They get
**read-only** access to those directories (plus any listed in `SENTINAL_ORCA_WORKER_ALLOW_DIRS`)
without a prompt, and can still edit only their own worktree.

**Architecture:** Sentinal already launches pre-warmed workers itself (`orca terminal create
--command opencode`). The launch command becomes `env OPENCODE_CONFIG_CONTENT='<json>' opencode`
(`env` so it works in fish, csh/tcsh and nushell as well as POSIX shells),
an inline config OpenCode merges at high precedence for that process only. Nothing is written to
the user's config files. A new pure module, `src/orca/worker-access.ts`, builds the JSON and the
shell-quoted command. The coordinator and main checkout paths are injected into the Orca tools by
`src/mcp/server.ts`, as `guardWorktreeRemoval` already is, so `src/orca` stays free of git
imports.

**Tech Stack:** TypeScript, Bun test, OpenCode 1.18.34 config (`OPENCODE_CONFIG_CONTENT`), the
Orca CLI adapter.

## Scope

### In Scope

- **Which directories** (user decision): the coordinator's checkout and the main checkout by
  default, plus absolute paths in `SENTINAL_ORCA_WORKER_ALLOW_DIRS` (comma list, `~` expanded).
  `SENTINAL_ORCA_WORKER_ALLOW_DIRS=none` turns the whole feature off.
- **Read-only** (user decision):
  - `permission.external_directory`: `"<abs dir>/**": "allow"` for each directory.
  - `permission.edit` **and** the `edit` of every built-in primary/subagent (`build`, `plan`,
    `general`, `explore`): `"<dir relative to the worker's worktree>/*": "deny"`. Agent-level
    rules come last and the last match wins, so the deny must also be on any agent the worker
    might run as (plan-review must_fix). Probe 4: `*` also matches files deeper down, and a
    `general` subagent's write was denied.
  - A directory equal to the worker's own worktree is skipped. So is any directory the worktree
    contains (its relative path doesn't start with `..`), so the worker's own files are never
    denied.
- **Only for the pre-warmed path and agent `opencode`.** The `--agent` fallback, other agents and
  `SENTINAL_ORCA_PREWARM_AGENTS=none` launch through Orca, which can't add the variable. Those
  workers may still prompt; the docs say so (user decision).
- **Quoting:** `env OPENCODE_CONFIG_CONTENT='<json>' opencode` with POSIX single quotes
  (`'` → `'\''`); the JSON never contains a newline. On Windows (`process.platform ===
  "win32"`) the plain command is used.
- **Paths:** all directories and the worktree go through `realpathSync` (falling back to the
  raw path if it fails) before the relative paths are computed, so `/var` vs `/private/var`
  can't break them. A directory whose name contains a glob character (`*?[]{}`) is skipped and
  reported. Entries in `SENTINAL_ORCA_WORKER_ALLOW_DIRS` that are relative or empty are
  ignored.
- **Existing variable:** the worker's terminal starts from the user's login shell, not the MCP
  server's environment, so a value exported in shell startup files can't be seen and would be
  replaced for that worker (plan-review should_fix). Sentinal therefore:
  - merges into the MCP environment's `OPENCODE_CONFIG_CONTENT` when that is a JSON object,
    where an existing string `permission.edit` (e.g. `"allow"`) becomes `{"*": <it>}` before
    adding the denies;
  - skips (reporting why) when that value isn't valid JSON;
  - documents that a value set only in shell startup files is replaced for workers, with
    `SENTINAL_ORCA_WORKER_ALLOW_DIRS=none` as the opt-out.
- **Reporting:** `orca_start` reports `worker_access: { dirs, read_only: true }` **only when
  `start_path` is `prewarmed`**, never for a fallback or a replay, or the reason it was skipped.
  `worker_access` is computed in `mcp-tools-start.ts`; `dispatch-start.ts` only passes
  `launchCommand` through (line budget).
- **Placement `current`:** the worker's worktree is the git root of the coordinator's working
  directory (`resolveWorkspaceRoot`), the same directory Orca's `current` selector names. That
  directory is skipped by the "same or contained" rule, so a `current` worker gets only the
  main checkout and extra directories. Unit test included.
- **Prose** (both targets) and **dev docs**.
- **Live check** on Orca 1.4.218.

### Out of Scope

- Changing the user's `~/.config/opencode` or any project config.
- Sentinal's non-Orca subagents. They run inside the coordinator's own OpenCode process and
  directory, and their access is governed by the user's config.
- Restricting `bash`. The edit rules cover OpenCode's edit/write/patch tools only, so a bash
  command can still write to an allowed directory. This is documented.
- Orca 1.4.218 changes. The contract is unchanged, and nothing in it affects the OpenCode path
  (PR #20451, the composer wait, is still open).

## Context for Implementer

- **Live probes** (2026-10-01, OpenCode 1.18.34, Orca 1.4.218; memory #1938; scripts
  `/tmp/orca-drop/perm-probe*.sh`). Probe 4 used the `env` prefix and denies on
  `build`/`general`/`plan`: top-level, deeper and `general`-subagent writes into the main
  checkout were all denied, with no prompt.
  1. Plain `opencode` in an Orca worktree asked "Access external directory
     ~/Projects/endpoint_esports/sentinal". With
     `OPENCODE_CONFIG_CONTENT='{"permission":{"external_directory":{"<main>/**":"allow"}}}'
     opencode` there was no prompt, the read succeeded, and Orca still reported
     `agentIdentity: opencode`.
  2. Absolute `edit` deny patterns had no effect: the worker wrote into the main and
     coordinator checkouts.
  3. Relative deny patterns (`"../../../*"` for the main checkout, `"../../../../../../orca/…/
     orca-support/*"` for the coordinator), in both `permission.edit` and
     `agent.build.permission.edit`: the worker's own write succeeded, the main and coordinator
     writes were denied, the coordinator read succeeded, and there was no prompt.
- **OpenCode source facts:** `write`/`read` ask with `path.relative(instance.worktree,
  filepath)`. `external_directory` defaults to `ask` with absolute globs. Rules evaluate in order
  and the last match wins. "Allow always" is a session-scoped rule only.
- **Code:**
  - `src/orca/dispatch-prewarm.ts` `prewarmTerminal` passes `--command o.agent`.
  - `src/orca/dispatch-start.ts` (393/400 lines) calls `prewarmTerminal` around :205; add one
    `launchCommand` pass-through only.
  - `src/orca/mcp-tools-start.ts` builds the `startTask` options (`prewarmAgents(deps.env ??
    process.env)`).
  - `src/orca/mcp-tools-shared.ts` `OrcaToolsDeps` (add `workerDirs?: () => { coordinator:
    string; main: string }`).
  - `src/mcp/server.ts:74` wires deps: use `resolveWorkspaceRoot(process.cwd())` and
    `resolveProjectIdentity(process.cwd())` from `src/project/identity.ts`.
  - The worker's worktree for the relative patterns: the `{path}` placement, or for `current`,
    the coordinator checkout.
- **Gotchas:**
  - Keep `dispatch-start.ts` at 400 lines or fewer.
  - Set `RED_CONFIRMED` before each implementation write.
  - Regenerate the parity baselines once, then `bun run embed-assets`.
  - Tests never run the real `orca` or `opencode`.

## Assumptions

- `orca terminal create --command` runs its text through the user's POSIX shell, so an
  `VAR='…' cmd` prefix works. Probes 1 and 3 support this. Tasks 1 and 2 depend on it.
- `instance.worktree` for a worker is its own git worktree root (probe 3: the relative patterns
  computed from it matched). Task 1 depends on this.

## Testing Strategy

- **Unit (`worker-access.test.ts`):**
  - the JSON shape;
  - relative patterns for an Orca-nested worktree and for a sibling worktree;
  - skip rules (same dir, contained dir);
  - `none`, extra dirs, `~` expansion;
  - quoting with a `'` in a path;
  - Windows;
  - merging with an existing `OPENCODE_CONFIG_CONTENT`, and skipping it when it is invalid.
- **`orca_start`:** the pre-warm `terminal create` argv carries the prefixed command;
  `worker_access` is reported; the `--agent` path is unchanged.
- **Live:** an Orca worker reads the coordinator and main checkouts with no prompt, its edits
  there are refused, and its own edits work.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| A deny pattern matches the worker's own files | Low | The worker can't edit its worktree | Patterns only for dirs whose relative path starts with `..`; unit test with the nested `.orca/worktrees` layout; live check |
| The user's own `OPENCODE_CONFIG_CONTENT` is overridden | Low | Lost user settings | Deep-merge into valid JSON; skip and report when invalid |
| Bash writes bypass read-only | Med | A worker edits the main checkout through bash | Documented; the brief already says to work only in its worktree |
| A future OpenCode changes pattern semantics | Low | Prompts return or denies stop working | The live check is recorded; the off switch is `SENTINAL_ORCA_WORKER_ALLOW_DIRS=none` |

## Pre-Mortem

1. **A custom default agent the user defines** isn't in the built-in list, so its own
   `edit: allow` could win. → Trigger: a user reports a write into a read-only directory.
   Mitigation: the top-level deny still applies to every agent that doesn't override `edit`
   (probe 4); documented.
2. **Line budget in `dispatch-start.ts`.** → Trigger: over 400 lines. Pass the command through
   a single existing options spread.

## Execution Waves

**Wave 1:** Task 1 (the pure module).
**Wave 2:** Task 2 (wiring: prewarm, start, tool, server).
**Wave 3**, in parallel with disjoint files: Task 3 (`targets/` prose + parity), Task 4 (dev
docs).
**Wave 4:** Task 5 (the live check).

## Goal Verification

### Truths

1. `opencodeLaunch({ agent: "opencode", worktree: "/r/.orca/worktrees/w", dirs: ["/r",
   "/c/co"] })` returns a command starting `OPENCODE_CONFIG_CONTENT='` whose JSON has
   `permission.external_directory["/r/**"] === "allow"` and
   `permission.edit["../../../*"] === "deny"`, and the same edit rule under
   `agent.build.permission.edit`.
2. For a directory equal to, or contained in, the worktree, no rule is emitted.
3. An `orca_start` test shows the pre-warm `terminal create` `--command` with the prefix, and
   `worker_access` in the result. With `SENTINAL_ORCA_WORKER_ALLOW_DIRS=none` the command is
   plain `opencode`.
4. Live: no permission prompt; coordinator and main reads succeed; writes there are refused; own
   writes succeed.

### Artifacts

| Artifact | Provides | Exports |
| -------- | -------- | ------- |
| `src/orca/worker-access.ts` | Inline OpenCode permission config + launch command | `workerAllowDirs`, `opencodeLaunch` |

### Key Links

| From | To | Via | Pattern |
| ---- | -- | --- | ------- |
| `src/orca/mcp-tools-start.ts` | `worker-access.ts` | launch command | `opencodeLaunch` |
| `src/mcp/server.ts` | Orca tools | injected dirs | `workerDirs` |

## Progress Tracking

- [x] Task 1: `worker-access.ts` (pure) (Wave 1)
- [x] Task 2: Wire into pre-warm / start / server (Wave 2)
- [x] Task 3: Prose in both targets + parity (Wave 3)
- [x] Task 4: Dev docs (Wave 3)
- [x] Task 5: Live check (Wave 4)

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Notes

- **Spec review, applied:**
  - `orca_start` now reports `worker_access_skipped` (with the reason) and
    `worker_access_skipped_dirs`, and adds a "may still prompt" line.
  - A string `permission` (top level or per agent) in an existing `OPENCODE_CONFIG_CONTENT` is
    kept as the `*` rule.
  - A directory named like `..cache` inside the worktree counts as the worker's own.
  - Glob characters are checked on the resolved path too.
  - The text and JSON rewrite no longer uses `String.replace`, so `$` patterns in paths are safe.

## Live Verification

Task 5, 2026-10-01, Orca 1.4.218, OpenCode 1.18.34, macOS. A fresh Orca worktree
`.orca/worktrees/e2e-access` with `bun install`; `startTask` with the real runner and
`launchCommand` from `opencodeLaunch` using the real `orcaWorkerDirs` (coordinator
`orca-support`, main `~/Projects/endpoint_esports/sentinal`).

| Check | Result |
| ----- | ------ |
| `start_path` | ✅ `prewarmed` (`ctx_03784261e34c`) |
| Permission prompt on the worker's screen during the whole run | ✅ none |
| Read the coordinator's `package.json` and the main checkout's `README.md` | ✅ succeeded |
| Write into the main checkout | ✅ denied (`../../../*`) |
| Write into the coordinator checkout | ✅ denied |
| Write through a `general` subagent into the main checkout | ✅ denied |
| Write in its own worktree | ✅ succeeded |
| `worker_done` | ✅ accepted ("access ok") |
| Cleanup | ✅ worktree, branch and probe files removed; nothing pending |

## Implementation Tasks

### Task 1: `worker-access.ts`

**Objective:** Build the per-worker inline config and launch command.
**Dependencies:** None
**Wave:** 1

**Files:** Create `src/orca/worker-access.ts` and `src/orca/worker-access.test.ts`.

- `workerAllowDirs(env, defaults: string[], home)` → `string[] | null`. It returns `null` when
  the variable is `none`. Otherwise it returns the defaults plus the list in
  `SENTINAL_ORCA_WORKER_ALLOW_DIRS`, with `~` expanded, absolute paths only, trailing `/`
  stripped and duplicates removed.
- `opencodeLaunch({ agent, worktree, dirs, env, platform })` →
  `{ command: string; access?: { dirs: string[]; readOnly: true }; skipped?: string }`.
  - It returns a plain `agent` command when the agent isn't `opencode`, when `dirs` is null or
    empty after the skip rules, or on `win32`.
  - It merges into an existing `env.OPENCODE_CONFIG_CONTENT` when that is a JSON object, and
    skips (reporting why) when it isn't.

**Definition of Done:**

- [ ] Truths 1 and 2, plus tests for: quoting with `'`, `$` and `!` in paths, Windows, merging
      (including a string `permission.edit`), invalid existing JSON, `none`, relative or empty
      list entries, glob characters in a path, realpath, the agent list, and placement
      `current`.

**Verify:** `bun test src/orca/worker-access.test.ts`

### Task 2: Wiring

**Dependencies:** Task 1
**Wave:** 2

**Files:**

- `src/orca/dispatch-prewarm.ts`: `prewarmTerminal` takes `command?: string`, defaulting to
  `agent`.
- `src/orca/dispatch-start.ts`: a `launchCommand?: string` option, passed to `prewarmTerminal`.
  The started result carries `workerAccess` when the pre-warmed start used it.
- `src/orca/mcp-tools-start.ts`: compute the launch from `deps.workerDirs?.()` and the
  placement, and output `worker_access`.
- `src/orca/mcp-tools-shared.ts`: `workerDirs` in the deps.
- `src/mcp/server.ts`: inject `workerDirs`.
- Tests: `dispatch-prewarm.test.ts`, `mcp-tools-start.test.ts`, `src/mcp/server.test.ts` (the
  wiring is present).

**Definition of Done:**

- [ ] Truth 3 holds, `bun test src/orca/ src/mcp/` passes, typecheck is clean, and
      `dispatch-start.ts` is 400 lines or fewer.

### Task 3: Prose

**Dependencies:** Task 2
**Wave:** 3

**Definition of Done:**

- [ ] `rg -n "SENTINAL_ORCA_WORKER_ALLOW_DIRS" targets/` matches all 4 files; hunk counts
      unchanged; `bun test src/cli/` passes.

**Files:** both `spec-master-execute` and both `spec-implement` files, then one parity
regeneration and `embed-assets`.

- In the pre-warm sentence, add: "Pre-warmed OpenCode workers can read the coordinator's
  checkout and the main checkout without a permission prompt (read-only; extra paths via
  `SENTINAL_ORCA_WORKER_ALLOW_DIRS`, `none` to turn it off). A worker that wasn't pre-warmed
  (the `--agent` fallback, `new-child`, other agents, `SENTINAL_ORCA_PREWARM_AGENTS=none`,
  Windows) may still ask; the user approves it in that worker's tab."
- Apply the edits symmetrically; the hunk counts must stay unchanged.

### Task 4: Dev docs

**Dependencies:** Task 2
**Wave:** 3

**Definition of Done:**

- [ ] `bunx prettier --check` passes on both files; they list every case that can still prompt
      and the bash limitation.

**Files:** `.sentinal/rules/sentinal-mcp-servers.md` (the pre-warm paragraph),
`.sentinal/skills/sentinal-orca-cli/SKILL.md` (facts rows: `OPENCODE_CONFIG_CONTENT` works via
`--command`, edit patterns are worktree-relative, the last match wins, "Allow always" is
session-only, Orca 1.4.218 notes).

### Task 5: Live check

**Dependencies:** Tasks 1–4
**Wave:** 4

Use `startTask` with the real runner in a fresh Orca worktree, with `launchCommand` built by
`opencodeLaunch` from the real coordinator and main paths. Brief the worker to read a file in
each checkout, attempt a write in each, write in its own worktree, then report through its
preamble. Expected: no "Permission required" on screen, both reads succeed, the two external
writes are refused (including one made through a `general` subagent), the own write succeeds,
and `worker_done` is accepted.

**Definition of Done:**

- [ ] All of the above recorded in the plan; no probe worktree, branch or file remains. Record the results
under "## Live Verification" and clean up.
