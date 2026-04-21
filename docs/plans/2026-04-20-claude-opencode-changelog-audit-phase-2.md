# Phase 2: Claude Code Lifecycle Hooks

Created: 2026-04-20
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 1

> Awaiting detailed planning. Run `/spec <this-file>` to plan this phase.

## Summary

**Goal:** Add 7 new Claude Code hook handlers + refactor 2 existing hooks to use the proper return fields, materially expanding Sentinal's lifecycle coverage.

**Context:** See master plan at `docs/plans/2026-04-20-claude-opencode-changelog-audit.md`.

## Scope Hint (to be expanded during planning)

New hook handlers (each in `src/hooks/<name>.ts` + test):
- **StopFailure** (Claude Code 2.1.78) — fires when a turn ends from API error; persist partial progress, notify dashboard, avoid marking task "complete" when model bailed
- **ConfigChange** (2.1.49) — fires on `settings.json` + `.sentinal/rules/*.md` changes; feed memory system on rules edits, warn if Sentinal hooks get disabled mid-session
- **InstructionsLoaded** (2.1.69) — fires when CLAUDE.md / rules auto-load; record which rules loaded per session (powers `/sync` decisions)
- **CwdChanged** (2.1.83) — invalidate project-context cache on cwd change
- **FileChanged** (2.1.83) — invalidate TDD tracker state when tests modified externally
- **PostCompact** (2.1.76) — verify compacted context was restored correctly; re-inject critical rules if missing
- **TaskCreated** (2.1.84) — track background tasks in the dashboard

Refactors of existing hooks:
- `pre-edit-guide` → replace stdout-hint pattern with structured `additionalContext` return (2.1.9/2.1.110)
- `memory-observer` / `spec-stop-guard` → consume `last_assistant_message` field directly + include `agent_id`/`agent_type` in memory attribution (2.1.47 / 2.1.69)

All hooks must have dual-target parity: if OpenCode has an equivalent event (`session.*`, `tool.execute.*`, experimental hooks), add the mapping in `targets/opencode/plugins/sentinal.ts` importing the shared logic from `src/hooks/`.
