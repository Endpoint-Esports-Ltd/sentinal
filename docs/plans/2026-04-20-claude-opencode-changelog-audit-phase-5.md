# Phase 5: Workspace + Permission Middleware

Created: 2026-04-20
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 3

> Awaiting detailed planning. Run `/spec <this-file>` to plan this phase.

## Summary

**Goal:** Strategic integrations that require Wave 1-2 infrastructure: native OpenCode workspace adaptor for spec worktrees, and Claude Code permission middleware that rewrites tool input and defers destructive actions.

**Context:** See master plan at `docs/plans/2026-04-20-claude-opencode-changelog-audit.md`. **Depends on:** Phase 4 (HTTP hooks) being stable — permission middleware needs the low-latency hook path.

## Scope Hint (to be expanded during planning)

### Section A: OpenCode Workspace Adaptor

- **Spike task first:** explore OpenCode's custom-workspace-adaptor SDK in a scratch plugin. If the API is not viable in 1 day, descope Section A entirely and keep only Section B.
- **Register "Sentinal Spec Worktree" adaptor** (2026-04-15) — appears in OpenCode's workspace creation UI. On selection, spins up isolated worktree + per-plan session.
- Integrate with `worktree_create` MCP tool (uses existing plan → slug → path mapping from `src/worktree/`).
- **Session restore across workspaces** (2026-04-16) — when creating the worktree adaptor, lift the initiating conversation into the new workspace session.
- **Workspace auth carryover** (2026-04-16) — verification only; no code needed beyond documentation.

### Section B: Permission Middleware

- **`permissionDecision: "defer"` on PreToolUse** (Claude Code 2.1.86) — in headless/CI mode, have `file-checker` and `tdd-guard` return `defer` instead of hard-deny, letting `-p --resume` re-evaluate with updated context.
- **`PermissionRequest` `updatedInput` rewrite** (Claude Code 2.0.54) — in `tool-redirect`, instead of denying `WebSearch` calls, rewrite them to use the `web-search` MCP tool.
- **`Elicitation`/`ElicitationResult` hooks** (Claude Code 2.1.76) — auto-answer common MCP elicitations (e.g., "yes, continue to next task") using spec workflow state.
- **New hook:** `src/hooks/permission-middleware.ts` consolidating these three features with clear extension points.

### Testing

- Spike verification: manual E2E workspace creation via OpenCode UI.
- Permission middleware: full bun:test coverage for all three behaviors (defer, rewrite, elicitation auto-answer).
- Headless smoke test: `opencode run --dangerously-skip-permissions -p "/spec <small task>"` should complete without prompts.

---

## Investigate During Planning (from 2026-05-26 re-audit, CC 2.1.117–2.1.142, OC 1.4.0–1.15.10)

These items were discovered after the original stub was written. Evaluate and incorporate during detailed planning.

### HIGH: `continueOnBlock` as alternative to `permissionDecision: "defer"` (CC 2.1.139)

CC 2.1.139 introduced `continueOnBlock: true` on PostToolUse hooks. When set, the rejection reason is fed back to Claude as context instead of hard-blocking — Claude can then self-correct. This is a **lighter-weight alternative** to `permissionDecision: "defer"` for soft-deny scenarios:

| Mechanism | When to use |
|-----------|-------------|
| `continueOnBlock: true` | Soft-deny — Claude should self-correct (e.g., file-length warnings, non-critical style issues) |
| `permissionDecision: "defer"` | Hard-deny with deferred resolution — CI/headless mode re-evaluates on `--resume` (e.g., TDD guard) |
| Hard block (exit 2) | Absolute block — cannot proceed (e.g., production DB access) |

During planning, classify each permission scenario into one of these three tiers.

### MEDIUM: `worktree.baseRef` setting (CC 2.1.133)

New Claude Code setting controls whether worktrees branch from `origin/<default>` (default, restored in 2.1.133) or local HEAD (`head`). Sentinal's `worktree_create` (both MCP tool and CLI) should read `worktree.baseRef` from Claude Code's settings and respect it. This also affects Section A (workspace adaptor) — the adaptor should pass the same base-ref logic.

Also note: CC 2.1.143 added `worktree.bgIsolation: "none"` for skipping worktree isolation on background tasks. The workspace adaptor should be aware of this setting.

### MEDIUM: OpenCode workspace adaptor API confirmed viable (OC 1.4.4+)

Good news for Section A — the spike is less risky than originally feared:

- **OC 1.4.4:** `WorkspaceAdaptor` plugin API exists
- **OC 1.14.20:** `WorkspaceAdaptor.create()` type includes `env` parameter (can pass `SENTINAL_*` vars)
- **OC 1.14.32:** Instance context bug fixed (was broken before this)
- **OC 1.14.42:** Workspace sync auto-discovers adaptor-backed workspaces

The spike should still verify the full flow end-to-end, but the API surface is confirmed present and functional.

### LOW: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (CC 2.1.143)

Stop hooks that block more than 8 times (configurable) now end the turn. If Section B's permission middleware includes stop-hook behavior, ensure it cannot trigger this cap. In practice Sentinal's stop guard blocks at most once per turn, so this is low risk.
