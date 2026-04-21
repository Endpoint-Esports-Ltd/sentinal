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
