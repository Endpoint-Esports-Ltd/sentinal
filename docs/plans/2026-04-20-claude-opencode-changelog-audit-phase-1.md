# Phase 1: UX + Settings Polish

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

**Goal:** Adopt the low-risk UX and settings items from the changelog audit (Sentinal fit: HIGH, all ≤1h–half-day).

**Context:** See master plan at `docs/plans/2026-04-20-claude-opencode-changelog-audit.md`.

## Scope Hint (to be expanded during planning)

Items from the audit attributed to this phase:
- Statusline `workspace.git_worktree` integration (Claude Code 2.1.97)
- Statusline `refreshInterval` setting (Claude Code 2.1.97)
- `hookSpecificOutput.sessionTitle` on UserPromptSubmit (Claude Code 2.1.94)
- `once: true` on `memory-restore` + `session-start` hooks (Claude Code 2.1.0)
- `plansDirectory` setting to align with `docs/plans/` (Claude Code 2.1.9)
- `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` env var in settings.json (2.1.74)
- `effort: xhigh` on spec-plan for Opus 4.7 + `effort: low` tuning on mechanical verify skills (2.1.80, 2.1.111)
- `${CLAUDE_PLUGIN_DATA}` variable adoption for memory DB location (2.1.78)
- Skill `paths:` frontmatter YAML list for language-specific rules (2.1.84)
- `claude plugin validate` in `package.json scripts` + CI (2.1.77)
- `opencode run --dangerously-skip-permissions` integration documentation (OpenCode 2026-04-08)
- macOS MDM guidance docs (OpenCode 2026-04-04)
- `opencode export --sanitize` + `/learn` cross-link (OpenCode 2026-04-15)
- `--agent` CLI override on session resume docs (OpenCode 2026-04-16)
- `.sentinal/` gitignore ergonomics note (OpenCode 2026-04-15)
- **Doc update:** add `targets/opencode/plugins/sentinal.ts` to the file-length-exempt list in `.sentinal/rules/sentinal-testing.md` (single-file plugin format is a platform constraint, not a code smell). Sync equivalent exemption to `src/utils/file-length.ts` if a hard-coded allowlist exists there.
