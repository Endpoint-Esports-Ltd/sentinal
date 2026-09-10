# Phase 1 — Permission-Semantics Spike (Task 2)

Date: 2026-08-07
Parent plan: `docs/plans/2026-08-07-worktree-runtime-isolation-phase-1.md`
Status: COMPLETE — all three questions answered with evidence.

Environments used: OpenCode **1.18.15** (`~/.opencode/bin/opencode`), Claude Code **2.1.205** (`/opt/homebrew/bin/claude`).

---

## Summary — what Task 6 must do

| Platform        | Verdict                    | Action                                                                 |
| --------------- | -------------------------- | ---------------------------------------------------------------------- |
| **OpenCode**    | ✅ Viable, top-level only  | Add `permission.bash` with `pkill*` / `killall*` → `ask`. **No per-agent duplication needed** — merge is confirmed. |
| **Claude Code** | ⛔ **Not deliverable**      | **Take D-P1-a's fallback branch: drop the CC default; document a manual opt-in snippet.** Amend master DoD item 9. |

The Claude Code half fails for a **different reason than D-P1-a anticipated**. D-P1-a expected the blocker to be `ask`-vs-`allow` precedence. Precedence is actually fine (Q2). The blocker is the **delivery vehicle**: Sentinal's only channel for Claude Code settings is a plugin-root `settings.json`, and Claude Code reads only two keys out of that file — `permissions` is not one of them (Q3). The branch outcome is the same, so **D-P1-a's fallback applies**.

---

## Q1 (R16) — Do per-agent `permission` blocks MERGE with or REPLACE the top-level `permission`?

### Verdict: **MERGE.** A top-level `permission.bash` reaches the `build` agent (the agent that runs `/spec`). No duplication required.

### Evidence — live resolution against a running OpenCode server

Isolated sandbox (`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` all redirected to a temp dir; nothing under the real `~/.config/opencode` was read or written). Project `opencode.json`:

```jsonc
{
  "permission": {
    "bash": { "*": "allow", "pkill*": "ask", "killall*": "ask" },
    "edit": { "*": "ask" }
  },
  "agent": {
    "build": { "permission": { "edit": "allow" } }   // <- declares NO bash key
  }
}
```

`opencode serve` + `GET /agent` returns the **fully resolved** `Agent.permission` for every agent. The `build` agent's resolved rules contained:

```json
{"permission": "bash", "pattern": "*",        "action": "allow"},
{"permission": "bash", "pattern": "pkill*",   "action": "ask"},
{"permission": "bash", "pattern": "killall*", "action": "ask"},
{"permission": "edit", "pattern": "*",        "action": "ask"},    // <- from top level
{"permission": "edit", "pattern": "*",        "action": "allow"}   // <- from agent.build
```

The same three `bash` rules appeared in **every** agent (`build`, `plan`, `general`, `explore`, `compaction`, `summary`, `title`). The agent's own `edit` rule did **not** displace the top-level `edit` rule — both are present. That is merge, not replace.

### Corollary — the resolved permission model is an ORDERED LIST, and **last match wins**

`Agent.permission` resolves to a flat, ordered array of `{permission, pattern, action}` rather than a map. Ordering is: built-in defaults → top-level config → per-agent config, with JSON object key order preserved within each block.

Last-match-wins is established by OpenCode's own built-in defaults, which are only coherent under that rule:

```json
{"permission": "read", "pattern": "*",              "action": "allow"},
{"permission": "read", "pattern": "*.env",          "action": "ask"},
{"permission": "read", "pattern": "*.env.*",        "action": "ask"},
{"permission": "read", "pattern": "*.env.example",  "action": "allow"}
```

`.env.example` matches all four patterns; the intended outcome is `allow`, which is the **last** match. Under first-match-wins the `*.env.example` exemption would be dead code.

**Consequence for Task 6:** within the `bash` object, `"*"` must come **first** and the specific `pkill*` / `killall*` entries **after** it. Reversing the key order would silently neuter the defaults. (Task 6 omits `"*": "allow"` entirely so as not to override a user's own broad bash policy — the built-in `{"permission":"*","pattern":"*","action":"allow"}` already sits at position 0, and `pkill*: ask` lands after it.)

> ⚠️ **The parenthetical above was an INFERENCE when written — this run used `"*": "allow"`, not the wildcard-less map that actually shipped.** It has since been measured directly. See `## Spike Findings` in the phase plan (`2026-08-07-worktree-runtime-isolation-phase-1.md`) for the follow-up `GET /agent` run against the exact shipped config.
>
> **Outcome: the inference was correct and the shipped config is safe** — `build`/`plan`/`general`/`explore` resolve benign bash to `allow` and only `pkill*`/`killall*` to `ask`. Adding `"*": "allow"` would have been strictly worse: it flips `compaction`/`summary`/`title` from OpenCode's built-in `deny` to `allow`. Both outcomes are now pinned by `tests/e2e/permission-defaults.e2e.ts` (live resolution) and `src/cli/permission-defaults.test.ts` (input shape).

### Type-surface confirmation

`~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`:

- `Config.permission.bash?: ("ask"|"allow"|"deny") | { [key: string]: "ask"|"allow"|"deny" }` (~line 1161)
- `AgentConfig.permission.bash?: <same union>` (~line 857)
- Resolved `Agent.permission.bash: { [key: string]: ... }` — **non-optional**, i.e. every agent always resolves a bash policy.

**Plan assumption "OpenCode's `permission.bash` accepts `"ask"` — asserted from docs, NOT verified" is now VERIFIED.**

---

## Q2 (L3) — Does a Claude Code `ask` rule take precedence over the bare `"Bash"` entry in `permissions.allow`?

### Verdict: **YES.** `ask` beats `allow` unconditionally, regardless of specificity. This was never the blocker.

### Evidence — official documentation

`https://docs.claude.com/en/docs/claude-code/permissions`, section *Manage permissions*:

> Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome, and rule specificity doesn't change the order.
>
> [...] The same precedence applies between ask and allow: **a matching ask rule prompts even when a more specific allow rule also matches the same call.**

`https://docs.claude.com/en/docs/claude-code/settings`, *Permission settings* table:

> `ask` — Array of permission rules to ask for confirmation upon tool use. Example: `[ "Bash(git push *)" ]`

So `permissions.ask` is a real key, and `Bash(pkill:*)` in `ask` would prompt even with the bare `"Bash"` sitting in `allow` at `settings.json:11`. **Narrowing the bare `"Bash"` entry would have been unnecessary** — D-P1-a's instruction not to touch it was right for an additional reason.

Two useful side findings:

- **`ask` survives `bypassPermissions` mode.** "Skips permission prompts, **except those forced by explicit `ask` rules**". So the backstop is not defeated by a permissive session mode.
- **Compound-command coverage is better than the master plan's Residual Risk assumes — on Claude Code.** "Claude Code is aware of shell operators [...] A rule must match each subcommand independently", and "A deny or ask rule matches past any leading assignment". So `git status && pkill -f foo` **would** prompt on Claude Code. Bare `xargs` is also stripped before matching. `sh -c "pkill ..."` still would not. This is moot for Sentinal today because of Q3, but it should not be mis-stated in the docs.

---

## Q3 (R12) — Does the shipped CC `settings.json` land under `MARKETPLACE_DIR`, and does an update revert a user's edit?

### Verdict: **Yes it lands there, yes an update reverts it — and worse: Claude Code does not read `permissions` from that file at all.**

### Q3a — where it lands (plain code read)

- `src/cli/commands/install.ts:355` — `const pluginDir = join(MARKETPLACE_DIR, "plugins", PLUGIN_NAME);`
- `src/cli/commands/install.ts:514` — `writeFileSync(join(pluginDir, "settings.json"), EMBEDDED_CC_SETTINGS_JSON);` (binary mode)
- `src/cli/commands/install.ts:388` — `copyDirRecursive(claudeTarget, pluginDir, …)` (source mode) — same destination.
- `src/cli/commands/install.ts:346-347` — `if (existsSync(MARKETPLACE_DIR)) rmSync(MARKETPLACE_DIR, { recursive: true, force: true });` runs **before** the directory is recreated, on **every** install/update.

Observed on this machine: `~/.claude/plugins/sentinal-marketplace/plugins/sentinal/settings.json` exists.

⇒ **Any user edit to that file is unconditionally destroyed on the next update.** R12's worst case is confirmed for Claude Code. The only user-owned file Sentinal touches is `~/.claude/settings.json`, and `configureStatusline()` (`install.ts:469-499`) writes exactly one key into it — `statusLine`. Permissions are never merged there.

### Q3b — the file is not a permissions channel at all

`https://docs.claude.com/en/docs/claude-code/plugins-reference`, *File locations reference*:

> | **Settings** | `settings.json` | Default configuration applied when the plugin is enabled. **Only the `agent` and `subagentStatusLine` keys are currently supported** |

`permissions`, `env`, `plansDirectory`, `statusLine`, `alwaysThinkingEnabled`, `respectGitignore` and `spinnerTipsOverride` are **all** outside that two-key allowlist. Adding `permissions.ask` to `targets/claude-code/settings.json` would be **inert** — it would satisfy a `target-assets` presence test while changing nothing at runtime.

**Corroborating code evidence:** `configureStatusline()` exists precisely because the plugin `settings.json`'s `statusLine` key does not apply — Sentinal already had to write it into the user's own `~/.claude/settings.json` separately. That is exactly the behaviour the two-key allowlist predicts.

> ⚠️ **Out-of-scope defect noticed, not fixed here.** The same finding implies the whole `permissions.allow` list and the `env` block in `targets/claude-code/settings.json` are already inert today. That is a pre-existing issue independent of this plan and should be filed separately rather than folded into Phase 1. (`claude plugin validate ./targets/claude-code --strict` also currently fails on unrelated malformed YAML frontmatter in `commands/spec.md` — likewise pre-existing and out of scope.)

### Q3c — OpenCode's revert semantics (different, and actionable)

OpenCode's installer does **not** wipe; it deep-merges via `deepMergeAdditive` (`install.ts:919-936`, called at `:819`):

```ts
if (!(key in result)) result[key] = source[key];              // absent  -> re-added
else if (bothPlainObjects) recurse;
// else: target has a value (scalar or mismatched type) — keep it
```

Therefore, for the installed `opencode.json`:

| User action                                      | Survives an in-place update? |
| ------------------------------------------------ | ---------------------------- |
| **Deletes** the `"pkill*"` key                   | ❌ **No** — key absent ⇒ re-added from source |
| **Deletes** the whole `"bash"` object            | ❌ **No** — same reason      |
| **Changes** the value to `"allow"` (or `"deny"`) | ✅ **Yes** — key present, scalar ⇒ target wins |

⇒ **The documented opt-out must say "set the value to `allow`", NOT "delete the line".** A deletion silently reverts on the next `sentinal install`. This directly contradicts the phrasing D4a/R12 assumed ("a one-line removal"), and is the single most important thing for Task 4's user-facing documentation to get right.

---

## Decision recorded per D-P1-a

**Branch taken: the fallback.** The Claude Code default is **dropped**. `targets/claude-code/settings.json` is left unchanged (no `permissions.ask` added), because it would be inert. A manual opt-in snippet for the user's own `~/.claude/settings.json` is documented in `targets/*/rules/verification.md` instead.

Consequences that must be carried out (Task 6):

1. Only OpenCode gets a native prompt from the shipped defaults → record in the phase's Residual Risk.
2. **Master DoD item 9 must be amended** — it currently demands the prompt fire "on each platform ... with the shipped default config", and says "if this cannot pass, revisit D4 rather than softening this item". Dropping the CC half is softening it, so the master is amended explicitly rather than silently diverged from.
3. The user-facing opt-out text must use "change to `allow`", not "delete".
