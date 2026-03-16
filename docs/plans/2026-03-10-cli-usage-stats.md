# CLI Usage Stats Implementation Plan

**Status:** VERIFIED
**Type:** Feature
**Approved:** Yes
**Worktree:** Yes
**Date:** 2026-03-10

## Goal

Display persistent usage stats in the Claude Code CLI statusline, showing token consumption as % of Claude Max plan limits per model — giving users always-visible awareness of their remaining capacity.

## Scope

- **In scope:**
  - Parse Claude Code's JSONL conversation logs to calculate token usage per model
  - Show usage as % of Claude Max plan limits (configurable for Max 5x / Max 20x)
  - Create a `sentinal statusline` command for Claude Code's native statusline feature
  - Show: per-model usage % (Opus/Sonnet), context window %, plan tier
  - Add `sentinal usage` CLI command for detailed on-demand breakdown
  - Configurable plan tier via `sentinal config`
- **Out of scope:**
  - Web dashboard usage view
  - Custom CLI wrapper
  - Real-time API quota checks (we estimate from local logs)

## Architecture

**Claude Code's native statusline** runs a shell script that receives session JSON on stdin and outputs formatted text at the bottom of the CLI. We create `sentinal statusline` as that script.

**Usage calculation:** Parse JSONL logs from `~/.claude/projects/` to sum tokens per model over the current billing period. Compare against known Claude Max plan limits:

- Max 5x: 5x base usage (~equivalent to ~$100/mo of API usage)
- Max 20x: 20x base usage (~equivalent to ~$400/mo of API usage)

Since Anthropic doesn't publish exact token limits, we calculate based on equivalent API costs and show usage in dollar-equivalent terms with % of plan limit.

**Statusline format:**

```
⏱ Session: 10% (2h) | 📊 Opus: 4%, Sonnet: 6% (2d 4h) | 📋 Max 5x | 🧠 ctx: 10%
```

- `⏱ Session: ▓░░░░ 10% (2h)` — current session usage % with progress bar and session duration
- `Opus: 4%, Sonnet: 6% (2d 4h)` — weekly per-model usage % with time until weekly reset
- `Plan: Max 5x` — active plan tier
- `🧠 ▓░░░░ 10%` — context window usage % with progress bar
- Progress bars use `▓` (filled) and `░` (empty) for visual density at a glance

**Reset tracking:** Claude Max plans use rolling usage windows. We track the oldest conversation in the current window and calculate when it will age out. Configurable reset interval (default: 5h rolling for per-model, 7d rolling for weekly).

**Two display surfaces:**

1. **Statusline (persistent)** — Always visible. Shows current session %, per-model weekly usage % against plan limit, plan tier, and context window %.

2. **`sentinal usage` (on-demand)** — Detailed report: daily breakdown, monthly totals, per-model token counts, % of plan used, estimated remaining capacity.

**Integration:** `sentinal install` configures Claude Code's statusline setting automatically.

## Tasks

Done: 3 | Left: 0

### Task 1: Usage data module with plan limit tracking

- [ ] Create `src/sessions/usage-stats.ts` — parse JSONL logs to sum tokens by model and day
- [ ] Define plan limit constants (Max 5x, Max 20x) as API-cost-equivalent thresholds
- [ ] Functions: `getUsageSummary()` → { byModel: { opus: { tokens, costEquiv, pctOfLimit, resetsIn }, sonnet: {...} }, weeklyResetsIn, period, planTier }
- [ ] `getSessionUsage(transcriptPath)` → session-specific token counts
- [ ] `getDailyUsage(days)` → daily breakdown array
- [ ] Calculate reset countdowns: find oldest conversation in current rolling window, compute time until it ages out
- [ ] Configurable rolling window intervals (default: 5h per-model, 7d weekly) via config
- [ ] Cache results (5 min TTL) to avoid re-parsing on every statusline refresh
- [ ] Add `plan_tier` to sentinal config (default: `max_5x`, options: `max_5x`, `max_20x`)
- **Files:** create `src/sessions/usage-stats.ts`, modify `src/cli/config.ts`, modify `package.json` if deps needed
- **DoD:** Functions return usage data with % of plan limit, configurable plan tier

### Task 2: `sentinal statusline` command for Claude Code's native statusline

- [ ] Add `statusline` subcommand — reads Claude Code session JSON from stdin
- [ ] Extract context window % from session JSON
- [ ] Call usage-stats module to get current session % and per-model weekly usage % against plan limit
- [ ] Output formatted line with icons and progress bars: `⏱ Session: ▓░░░░ 10% (2h) | Opus: 4%, Sonnet: 6% (2d 4h) | Plan: Max 5x | 🧠 ▓░░░░ 10%`
- [ ] Keep execution fast (<500ms) — use cached data
- [ ] Update `sentinal install` to configure Claude Code's statusline setting to run `sentinal statusline`
- **Files:** create `src/cli/statusline.ts`, modify `src/cli/index.ts`, modify `src/cli/install.ts`
- **DoD:** Statusline shows persistent usage in Claude Code CLI after install

### Task 3: `sentinal usage` detailed CLI command

- [ ] Add `usage` subcommand for on-demand detailed report
- [ ] Show: per-model token counts and % of plan limit with visual bars
- [ ] Show: daily breakdown table (last 7 days default)
- [ ] Show: monthly total with remaining capacity estimate and reset countdowns
- [ ] Support `--days N` flag and `--json` flag
- **Files:** create `src/cli/usage.ts`, modify `src/cli/index.ts`
- **DoD:** `sentinal usage` prints formatted usage report with plan limit %

## Risks

- **Plan limits unknown:** Anthropic doesn't publish exact token limits for Max plans. Use API-cost-equivalent estimates and document as approximate. Allow users to override via config.
- **JSONL format changes:** Claude Code may change log format. Keep parser minimal and fail gracefully.
- **Statusline performance:** Must complete <500ms. File caching mitigates.
- **Billing period alignment:** May not perfectly align with Anthropic's billing cycle. Default to calendar month, allow config override.

## Goal Verification

1. Start Claude Code with plugin — see statusline with session %, model %, reset countdowns, and context %
2. Work in a session — see model usage %, reset timers, and context % update
3. Run `sentinal usage` — see daily breakdown with visual bars and remaining capacity
4. Change plan tier with `sentinal config set plan_tier max_20x` — see limits adjust
