# Isolated E2E Test Harness for OpenCode + Claude Code Implementation Plan

Created: 2026-07-17
Status: IN_PROGRESS
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** A layered E2E test harness that installs Sentinal into a fully isolated sandbox (temp `HOME`) and exercises its features end-to-end — never touching the real `~/.claude`, `~/.config/opencode`, `~/.opencode`, or `~/.sentinal`.

**Architecture:** A reusable **sandbox builder** (temp `HOME` + `XDG_CONFIG_HOME` + `SENTINAL_NO_AUTO_SETUP=1`, asserts zero escapes) plus two test layers: **Layer A (deterministic, default, CI-safe)** drives Sentinal's real entrypoints in-sandbox with NO LLM — `sentinal install`, real `HookInput` JSON through the compiled dispatcher, JSON-RPC against the MCP server, sidecar+memory round-trips. **Layer B (opt-in, `SENTINAL_E2E_REAL=1`, local-only)** copies the user's creds into the sandbox and drives the real `opencode run -p` / `claude -p` binaries headless, asserting the plugin/hooks actually fired via in-sandbox `~/.sentinal` state.

**Tech Stack:** Bun ≥1.0, `bun:test` (with `bunfig.toml` sqlite-vec preload), TypeScript. Real binaries: `opencode` (`~/.opencode/bin`), `claude` (`/opt/homebrew/bin`). No new deps.

## Scope

### In Scope

- **Sandbox builder** (`tests/e2e/harness/sandbox.ts`): create temp HOME/XDG dir; env map (`HOME`, `XDG_CONFIG_HOME=$HOME/.config`, `SENTINAL_NO_AUTO_SETUP=1`, cleared `CLAUDE_PLUGIN_DATA`); install Sentinal (bundled mode) via `sentinal install`; teardown; escape-assertion helper.
- **Layer A — deterministic E2E (default):**
  - **Install + activation:** `sentinal install opencode` + `install claude` into the sandbox; assert config/plugin/hooks/MCP assets land at the expected sandbox paths and parse.
  - **Hooks fire E2E:** pipe real `HookInput` JSON through the installed dispatcher (`sentinal hook <scope> <name>`) for `PreToolUse` tdd-guard, `PostToolUse` file-checker, `Stop` spec-stop-guard; assert outputs/exit codes.
  - **MCP tools E2E:** spawn the installed `sentinal mcp-server`, JSON-RPC `initialize` + `tools/list` + `tools/call` for `memory_search`, `spec_status`, `tdd_status`; assert responses.
  - **/spec workflow + stop-guard:** register a mini plan in-sandbox, transition status, assert the stop-guard blocks/soft-nudges correctly (session-aware).
  - **Sidecar + memory:** assert sidecar starts on the SANDBOX socket (`$HOME/.sentinal/sidecar.sock`), memory DB created in-sandbox, an observation round-trips via the MCP server.
- **Layer B — opt-in real-binary smoke (`SENTINAL_E2E_REAL=1`):** copy `~/.claude` creds + `~/.config/opencode/auth*` into the sandbox; run `opencode run --dangerously-skip-permissions -p "<trivial>"` and `claude -p --dangerously-skip-permissions "<trivial>"` in-sandbox; assert Sentinal fired (plugin.debug.log / sidecar state appears in the sandbox `~/.sentinal`). Skips cleanly (test `.skip`) when the flag is unset.
- **Runner wiring:** an `e2e` script; tests run under `bun test` so the sqlite-vec preload loads.

### Out of Scope

- Full TUI interaction / screenshot E2E (no Playwright against the terminal UIs).
- Testing OpenCode/Claude Code's OWN correctness — only Sentinal's behavior within them.
- npm-registry install mode (needs `~/.npmrc` scoped registry + network) — harness uses **bundled** mode only.
- Real-binary layer in CI (needs credentials; local-manual only).
- Cross-platform (Windows) — harness targets macOS/Linux like the rest of the suite.

## Context for Implementer

> Written for an implementer who has never seen this codebase.

**The single enabling fact:** every Sentinal runtime path and both installers resolve their base dir via `os.homedir()` or `XDG_CONFIG_HOME` — there is NO hardcoded absolute base dir. So overriding `HOME` (+ `XDG_CONFIG_HOME=$HOME/.config`) fully redirects EVERY write into the sandbox. Verified inventory:

- Sidecar socket/port/pid: `src/sidecar/paths.ts:17-27` → `join(homedir(), ".sentinal", ...)`.
- Memory DB: `src/memory/store.ts:43-49` → `join(homedir(), ".sentinal", "memory.db")`. **Gotcha:** `src/memory/config.ts:37-59` prefers `$CLAUDE_PLUGIN_DATA/sentinal.db` if set+writable — the sandbox env MUST clear/unset `CLAUDE_PLUGIN_DATA` (or point it in-sandbox) so the DB doesn't escape.
- Dashboard pid/bin: `src/dashboard/lifecycle.ts:16-18,136-149`. OpenCode plugin state: `targets/opencode/plugins/sentinal.ts:174`.
- **`HOME` must be a real temp dir — NEVER `/` or empty** (root-guard: `homedir()` returns `/`; see `src/sidecar/observation-queue.test.ts:249-250`).

**Installer facts (`src/cli/commands/install.ts`):**
- Flags: only `--local` (OpenCode → `$CWD/.opencode`) and `--bundled` (embedded `.mjs` instead of npm). **No `--dir`/`--dry-run`.** Positional target: `claude`/`claude-code`/`opencode`/`both`.
- OpenCode target dir: `resolveXdgConfig()` → `$XDG_CONFIG_HOME/opencode/` (`install.ts:617-624`). Writes `plugins/sentinal.mjs` (bundled mode, `:630-635`), `opencode.json` with `plugin:["./plugins/sentinal.mjs"]` (**the ONLY load path** — `.mjs` is not auto-loaded; `install.ts:896-917` `buildPluginList`) + `mcp.sentinal` (`:764-772`).
- Claude Code: writes `~/.claude/plugins/sentinal-marketplace/...` incl. `hooks/hooks.json` (`:528-530`), `.mcp.json` (`:516-526`), `settings.json`; **and SPAWNS the real `claude` binary** for `plugin marketplace add`/`install` (`:417-437`). ⚠️ **`HOME` alone does NOT sandbox this** — Claude Code resolves its plugin/marketplace registry via **`CLAUDE_CONFIG_DIR`**. The sandbox env MUST set `CLAUDE_CONFIG_DIR=$HOME/.claude`, and Task 2/5 must spike-verify the real registry is untouched before asserting; otherwise assert only the pre-spawn on-disk assets for Layer A and move real-`claude` activation to Layer B.
- **e2e file naming:** `bunfig.toml` has a GLOBAL preload and NO path scoping, so a bare `bun test` globs `**/*.test.ts` from repo root — any `*.e2e.ts` (still ends in `.test.ts`) WOULD run in the default suite. e2e files therefore use the `*.e2e.ts` / `*.spec-e2e.ts` suffix (NOT `.test.ts`) and are driven only by the explicit `bun run e2e` runner (`bun test tests/e2e/`). The sqlite-vec preload still applies (unconditional).
- ⚠️ **Explicit target** (`install opencode`/`install claude`) SKIPS `setupProjectSymlinks()`+`setupShellIntegration()` (`:270-274`), which otherwise touch `process.cwd()` + shell rc. Use explicit targets AND run in a throwaway cwd.
- `SENTINAL_NO_AUTO_SETUP=1` skips the 150MB semantic-search model download (`src/cli/commands/auto-setup.ts:32-37`) — set it always.
- Bundled mode avoids the `~/.npmrc` scoped-registry requirement (`install.ts:639-642`).

**Reference patterns:**
- CLI-subprocess-with-stdin-JSON test idiom: `src/cli/commands/hook.test.ts:6,30-45` — `Bun.spawnSync(["bun", CLI, "hook", "claude", "file-checker"], { stdin: <json> })`. The harness generalizes this against the INSTALLED sandbox binary/dispatcher.
- Fresh-HOME idiom + caveat: `.sentinal/skills/sentinal-ci-only-failures/SKILL.md:44-58` (`HOME=$(mktemp -d) bun test ...`; fake HOME empties Bun cache → subprocess tests may need longer timeouts).
- Temp dir helper: `src/test-helpers.ts:16-23` `makeTmpDir()`.
- Headless invocation string (shipped): `opencode run --dangerously-skip-permissions -p "..."` (`src/cli/embedded-assets.ts:20563`). `claude -p --dangerously-skip-permissions "..."` confirmed via `claude --help`.

**How to build the sandbox `sentinal` binary:** `bun run build:cli` → `dist/sentinal` (compiled). The harness uses this compiled binary (matches what users install) OR `bun src/cli/index.ts` for speed. Bundled OpenCode plugin: `bun run build:opencode` → `targets/opencode/dist/sentinal.mjs` (embedded into the binary via `embed-assets`).

## Runtime Environment

- Build harness deps: `bun run build:cli` (compiled `dist/sentinal`) + `bun run build:all` (plugin/hooks). Tests: `bun test tests/e2e/`. Real layer: `SENTINAL_E2E_REAL=1 bun test tests/e2e/`.
- Sandbox lifecycle: create temp HOME → set env → `dist/sentinal install <target>` → run assertions → `stopSidecar`/kill sandbox procs → `rm -rf` temp HOME.
- Sidecar in-sandbox: `$HOME/.sentinal/sidecar.{sock,port,pid}`; kill by pid file before teardown.

## Assumptions

- All Sentinal paths key off `homedir()`/`XDG_CONFIG_HOME` with no absolute escapes — supported by the 38-callsite `homedir(` inventory + existing fresh-HOME hardening (`sidecar/server.ts:296-303`, `memory/store.ts:44-47`). All tasks depend on this.
- `CLAUDE_PLUGIN_DATA` is the only env that can relocate the DB outside HOME — supported by `memory/config.ts:38`. Task 1 must clear it in the sandbox env.
- Bundled-mode install needs no network (embedded assets) once `SENTINAL_NO_AUTO_SETUP=1` — supported by `install.ts:630-635` + `auto-setup.ts:32-37`. Tasks 2-6 depend on this.
- The compiled `dist/sentinal` exists (or `bun src/cli/index.ts` works) as the install/dispatch entrypoint — supported by `package.json:39,43-44`. Task 2 depends on this.
- Real binaries `opencode`/`claude` support headless `-p` (+ `--dangerously-skip-permissions`) — CONFIRMED via `claude --help` and shipped `opencode run -p` strings. Task 8 (opt-in) depends on this.
- Claude Code auth lives under `~/.claude` (copyable) or via provider env; OpenCode auth under `~/.config/opencode/auth*` — Task 8 spike confirms the exact files that make `-p` authenticate in-sandbox.

## Testing Strategy

- **The harness IS the test.** Layer A tests are the primary deliverable — deterministic `bun:test` files under `tests/e2e/` that build a sandbox, install, and assert. Each asserts real Sentinal behavior (exit codes, JSON-RPC responses, files-on-disk, sidecar state) — never mocks Sentinal itself.
- **Escape guarantee is PRIMARY-structural, snapshot-secondary:** the real proof of non-escape is that every spawned process's env has `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` resolving inside the sandbox (`assertEnvContained`). As defense-in-depth, `assertNoRealEscape()` snapshots **recursive content hashes** of the real `~/.claude`, `~/.config/opencode`, `~/.opencode`, `~/.sentinal`, `~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`, `~/.npmrc`, and `$CLAUDE_CONFIG_DIR`, asserting unchanged. (mtime/entry-list alone is insufficient — misses nested-file and identical-mtime rewrites.) A unit test proves the backstop detects a nested-file content change.
- **Default-suite exclusion is a first-class DoD:** e2e files are named `*.e2e.ts`/`*.spec-e2e.ts` (not `.test.ts`) and Task 7 asserts a bare `bun test` runs NONE of them.
- **Layer B** is `it.skipIf(!process.env.SENTINAL_E2E_REAL)` — AND all sandbox construction / cred-copy live INSIDE the skipped bodies (or a `beforeAll` that early-returns when the flag is unset), so skip is truly zero-cost/binary-free.
- **Timeouts:** every sandbox/install/subprocess test gets an explicit generous timeout (fresh HOME empties Bun cache; installs + sidecar cold start are slow). Per `sentinal-test-timing` + `sentinal-ci-only-failures` skills.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| A stray absolute path escapes the sandbox and mutates real installs | Low | High | Task 1 escape-assertion snapshots real dirs before/after EVERY e2e test; clear `CLAUDE_PLUGIN_DATA`; explicit install targets (skip symlink/shell setup); throwaway cwd. |
| Fresh HOME empties Bun cache → install/subprocess tests time out (5s default) | High | Med | Explicit ≥60-120s timeouts on all harness tests (sentinal-test-timing skill). |
| Claude Code install spawns real `claude` and needs auth even for `plugin install` | Med | Med | Verify in Task 5 whether `claude plugin marketplace add/install` needs auth; if so, gate the Claude-activation assertions behind the real-layer flag or assert asset-on-disk only (which doesn't need the CLI). |
| sqlite-vec `vec0` module fails to load in harness (no preload) | Med | High | Run under `bun test` (bunfig.toml preload) OR replicate `src/memory/test-preload.ts`. Task 6 verifies. |
| Real-binary layer can't authenticate in sandbox HOME | Med | Med (opt-in only) | Task 8 spike: copy creds vs env passthrough; if neither authenticates, the layer stays skipped and documents the limitation — does NOT block Layer A. |
| Sidecar/dashboard procs from a sandbox leak past teardown | Med | Med | Teardown kills by sandbox pid files (`$HOME/.sentinal/*.pid`) before `rm -rf`; test uses `afterEach`/`afterAll` with best-effort kill. |
| Harness pollutes the real repo cwd via symlink setup | Low | Med | Use explicit install targets (skips `setupProjectSymlinks`); run installs with a temp cwd. |

## Pre-Mortem

_Assume this plan failed after full execution. Most likely internal reasons:_

1. **Silent escape** (Task 1/2) → Trigger: an install writes into the real `~/.sentinal` because a spawned child didn't inherit the sandbox env (env not threaded to a nested spawn). Observable: the escape-assertion snapshot detects a real-dir mtime change. Mitigation: thread the full sandbox env through EVERY spawn (install, hook, mcp-server, sidecar) and assert it.
2. **MCP JSON-RPC handshake wrong** (Task 4) → Trigger: the harness sends malformed `initialize`/`tools/call` framing and every MCP assertion fails uniformly. Mitigation: reuse the exact stdio JSON-RPC framing the SDK expects; validate against `bun run mcp` locally first; keep one low-level "list tools" smoke before deeper calls.
3. **Layer B green-by-accident** (Task 8) → Trigger: real-binary test "passes" because it skipped (flag unset) OR because the binary ran but Sentinal never actually loaded, and the assertion only checked exit 0. Mitigation: the assertion MUST check a Sentinal-specific artifact in the sandbox (`~/.sentinal/plugin.debug.log` or a fresh sidecar pid), not just the binary's exit code; and log clearly when skipped.

## Execution Waves

**Wave 1 — Sandbox core:** Task 1 only (the `sandbox.ts` builder + escape assertion). Everything else imports it.

**Wave 2 — Deterministic layers (parallel, no file overlap):** Tasks 2 (install+activation), 3 (hooks), 4 (MCP), 5 (/spec+stop-guard), 6 (sidecar+memory). Each is its own `tests/e2e/*.e2e.ts` file importing the Task 1 harness — no shared files → parallelizable. (Task 5 and 6 both touch spec/memory state but in separate sandbox instances, so no on-disk conflict.)

**Wave 3 — Opt-in real layer:** Task 8 (real-binary smoke) — depends on Task 1 harness + the assertion patterns proven in Wave 2.

**Wave 4 — Runner + docs:** Task 7 (e2e script + README section) — depends on all test files existing.

**Note on task numbers vs execution order:** numeric task order ≠ execution order (Task 8 runs in Wave 3, before Task 7 in Wave 4). Follow the Wave labels, not the numbers.

**Escape-assertion concurrency caveat:** the backstop real-dir hash snapshot assumes NO concurrent real Sentinal/Claude/OpenCode activity during the e2e run (a background real sidecar writing `~/.sentinal` would trip a spurious escape failure). The PRIMARY structural env guarantee (`assertEnvContained`) is immune to this. Run e2e in a quiescent environment; scope the backstop to the specific files the install path can touch to reduce false positives.

## Goal Verification

### Truths

1. `tests/e2e/harness/sandbox.ts` exists and exports a sandbox builder — grep: `export.*createSandbox` (or chosen name) + `XDG_CONFIG_HOME` + `SENTINAL_NO_AUTO_SETUP`.
2. Running `bun test tests/e2e/` with no real binaries needed passes Layer A and the real `~/.sentinal`/`~/.claude`/`~/.config/opencode` are byte-unchanged (escape-assertion test present) — grep: `SENTINAL_E2E` absent from Layer A; an escape-assertion test asserts real-dir immutability.
3. An install-activation test asserts `<sandbox>/.config/opencode/opencode.json` contains `plugin` pointing at `sentinal.mjs` and `mcp.sentinal` — grep-verifiable in the test.
4. A hooks test pipes `HookInput` JSON through the sandbox dispatcher and asserts an exit code / output for spec-stop-guard, tdd-guard, file-checker.
5. An MCP test JSON-RPC-calls `tools/list` against the sandbox `sentinal mcp-server` and asserts `memory_search`/`spec_status`/`tdd_status` are present.
6. A sidecar/memory test asserts the sidecar socket is created under the SANDBOX `.sentinal/` and an observation round-trips.
7. Layer B tests use `it.skipIf(!process.env.SENTINAL_E2E_REAL)` and, when enabled, assert a Sentinal artifact appears in the sandbox `~/.sentinal` after a real `opencode`/`claude -p` run — grep: `SENTINAL_E2E_REAL` + `skipIf`.
8. `package.json` has an `e2e` script and `README`/docs describe running it — grep: `"e2e"` in package.json.
9. A bare `bun test` (default suite) runs NONE of the `tests/e2e/*.e2e.ts` files (they use the `.e2e.ts`/`.spec-e2e.ts` suffix, not `.test.ts`) and still exits 0 — Task 7 asserts this by running `bun test` and confirming no e2e file executed. The e2e layer runs only via `bun run e2e`.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `tests/e2e/harness/sandbox.ts` | Isolated sandbox builder + escape assertion | `createSandbox()`, `assertNoRealEscape()`, `SandboxEnv` |
| `tests/e2e/harness/mcp-client.ts` | Minimal stdio JSON-RPC MCP client for tests | `McpTestClient` (initialize/listTools/callTool) |
| `tests/e2e/install.e2e.ts` | Install + activation coverage | — |
| `tests/e2e/hooks.e2e.ts` | Hooks-fire coverage | — |
| `tests/e2e/mcp.e2e.ts` | MCP tools coverage | — |
| `tests/e2e/spec-workflow.e2e.ts` | /spec + stop-guard coverage | — |
| `tests/e2e/sidecar-memory.e2e.ts` | Sidecar + memory coverage | — |
| `tests/e2e/real-binary.e2e.ts` | Opt-in real opencode/claude smoke | — |
| `package.json` (`e2e` script) | Runner entry | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `tests/e2e/*.e2e.ts` | `tests/e2e/harness/sandbox.ts` | import | `import.*harness/sandbox` |
| `tests/e2e/mcp.e2e.ts` | `tests/e2e/harness/mcp-client.ts` | import | `import.*mcp-client` |
| `tests/e2e/install.e2e.ts` | `dist/sentinal` (or `src/cli/index.ts`) | spawn install | `install.*opencode\|claude` |
| `tests/e2e/hooks.e2e.ts` | sandbox `sentinal hook` dispatcher | spawn + stdin JSON | `hook.*(shared\|claude)` |
| `tests/e2e/real-binary.e2e.ts` | env flag | conditional skip | `SENTINAL_E2E_REAL` |

## Progress Tracking

- [x] Task 1: Sandbox builder + escape assertion (Wave 1) — 9/9 green; real dirs verified untouched; runner needs `./tests/e2e/` path prefix (bun quirk)
- [x] Task 2: Install + activation e2e (Wave 2) — CLAUDE_CONFIG_DIR redirect verified (real ~/.claude untouched); network-free install proven
- [x] Task 3: Hooks-fire e2e (Wave 2) — file-checker/spec-stop-guard/tdd-guard through real dispatcher
- [x] Task 4: MCP tools e2e + SDK client (Wave 2) — 28 tools, memory_search works in-subprocess
- [x] Task 5: /spec workflow + stop-guard e2e (Wave 2) — owner-blocks/live-allows/stale-blocks
- [x] Task 6: Sidecar + memory e2e (Wave 2) — sandbox socket + memory round-trip, no leaks
- [ ] Task 8: Opt-in real-binary smoke layer (Wave 3)
- [ ] Task 7: Runner script + docs (Wave 4)
      **Total Tasks:** 8 | **Completed:** 0 | **Remaining:** 8

## Implementation Tasks

### Task 1: Sandbox Builder + Escape Assertion

**Objective:** A reusable harness that creates a fully isolated temp `HOME`, produces the complete sandbox env map (including `CLAUDE_CONFIG_DIR`), installs Sentinal (bundled) into it, and provides a STRUCTURAL escape guarantee that no spawned process was ever pointed outside the sandbox.
**Dependencies:** None
**Wave:** 1

**Files:**
- Create: `tests/e2e/harness/sandbox.ts`
- Create: `tests/e2e/harness/sandbox.spec-e2e.ts` (NOT `.test.ts` — must be excluded from default `bun test` discovery; run via the explicit e2e runner)

**Key Decisions / Notes:**
- `createSandbox()`: `mkdtempSync(join(tmpdir(),"sentinal-e2e-"))` as HOME; env =
  `{ ...process.env, HOME, XDG_CONFIG_HOME: join(HOME,".config"), CLAUDE_CONFIG_DIR: join(HOME,".claude"), SENTINAL_NO_AUTO_SETUP: "1", CLAUDE_PLUGIN_DATA: "" }`.
  - **`CLAUDE_CONFIG_DIR` is REQUIRED** (must-fix from review): the installer spawns the real `claude` binary for `plugin marketplace add/install` (`install.ts:417-437`), and Claude Code resolves its plugin/marketplace registry via `CLAUDE_CONFIG_DIR`, NOT `HOME` alone. Without it, the spawned `claude` could mutate the user's REAL plugin registry.
  - Also override shell rc + npm targets so the shell-init / npmrc paths can't escape: point `HOME` (covers `~/.bashrc`/`~/.zshrc`/`~/.npmrc`) — but ALSO snapshot them (below) as defense-in-depth.
- Return `{ home, env, run(args, {cwd}), install(target), cleanup() }`. `run` spawns the compiled `dist/sentinal` (or `["bun","<repo>/src/cli/index.ts"]`, matching `hook.test.ts:6`) with the FULL sandbox env + a throwaway temp cwd. **Every** spawn in the harness (install, hook, mcp-server, sidecar, real binaries) MUST go through `run`/the env map — verify `install.ts`'s `run()` helper threads `process.env` (it uses `Bun.spawnSync` without resetting env → inherits; the harness passes env explicitly).
- **Escape guarantee is STRUCTURAL (primary), snapshot is backstop (secondary):**
  - PRIMARY: `assertEnvContained(env)` — assert `env.HOME`, `env.XDG_CONFIG_HOME`, `env.CLAUDE_CONFIG_DIR` all resolve INSIDE the sandbox root, and that the harness never spawns a process with an env lacking them. This is the real proof of non-escape.
  - BACKSTOP: `assertNoRealEscape()` — snapshot **recursive content hashes** (not mtime) of the real `~/.claude`, `~/.config/opencode`, `~/.opencode`, `~/.sentinal`, PLUS `~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`, `~/.npmrc`, and the real `$CLAUDE_CONFIG_DIR` if set; assert unchanged on teardown. Catches nested-file rewrites and identical-mtime rewrites the entry-list/mtime approach misses.
- NEVER set HOME to `/` or empty (root-guard: `homedir()`→`/`).
- `cleanup()` (see Task 6 for the hardened kill): SIGTERM sandbox sidecar/dashboard by `$HOME/.sentinal/*.pid` ONLY after verifying the pid's argv/cwd points into the sandbox (guard PID reuse), poll for removal then SIGKILL, then grep for any surviving process referencing the sandbox HOME path and kill it, then `rm -rf` HOME. Register a process exit/SIGINT handler that scrubs the sandbox even on abnormal exit.

**Definition of Done:**
- [ ] `createSandbox().env` includes `CLAUDE_CONFIG_DIR=<home>/.claude`, cleared `CLAUDE_PLUGIN_DATA`, `SENTINAL_NO_AUTO_SETUP=1`, real temp HOME (never `/`).
- [ ] `assertEnvContained` proves every harness spawn's env HOME/XDG/CLAUDE_CONFIG_DIR resolves inside the sandbox (primary guarantee).
- [ ] `assertNoRealEscape()` uses recursive content hashes over the EXPANDED path set (incl. `~/.bashrc`, `~/.npmrc`, `$CLAUDE_CONFIG_DIR`); a unit test proves it DETECTS a nested-file content change (not just a new top-level entry).
- [ ] `install("opencode")` lands assets under `<home>/.config/opencode/`.
- [ ] `cleanup()` verifies pid ownership before kill and scrubs on abnormal exit.
- [ ] Explicit generous timeout (≥120s) on install.

**Verify:**
- `bun test tests/e2e/harness/sandbox.spec-e2e.ts` (via the e2e runner path)

### Task 2: Install + Activation E2E

**Objective:** Prove `sentinal install opencode` and `install claude` land the correct activation assets in the sandbox and they parse/point correctly.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/install.e2e.ts`

**Key Decisions / Notes:**
- OpenCode (bundled): assert `<home>/.config/opencode/opencode.json` exists, `plugin` array contains `./plugins/sentinal.mjs`, `mcp.sentinal.command` present; assert `plugins/sentinal.mjs` file exists and is non-empty; assert `rules/`, `commands/`, `skills/` populated.
- **`claude` spawn safety SPIKE (do FIRST):** with the sandbox env (incl. `CLAUDE_CONFIG_DIR=<home>/.claude`) and the escape-assertion active, run the Claude install once and confirm the REAL `~/.claude/plugins` registry is byte-unchanged. If `CLAUDE_CONFIG_DIR` successfully redirects the spawned `claude`, assert full activation. **If it does NOT redirect** (real registry would be touched), Layer A MUST NOT spawn real `claude` — assert only the pre-spawn on-disk assets (`hooks.json`/`.mcp.json`/`settings.json`, written before the CLI spawn) and move the `claude plugin marketplace add/install` activation entirely into Layer B (`SENTINAL_E2E_REAL`).
- **Network-freeness guard:** run the bundled OpenCode install with network egress blocked (e.g. `HTTPS_PROXY`/`HTTP_PROXY` pointed at an unreachable host, or a no-network shim) and assert it still succeeds — proving the `SENTINAL_NO_AUTO_SETUP=1` + `--bundled` path makes CI-safe determinism a TESTED fact, not an assumption. (Note: `src/cli/commands/update.ts` has live `fetch()` — assert the install path exercised does NOT hit it.)
- End with `assertNoRealEscape()`.

**Definition of Done:**
- [ ] opencode.json plugin+mcp assertions pass in-sandbox.
- [ ] `claude` spike recorded: either full Claude activation asserted (registry redirected) OR asset-only + activation deferred to Layer B, with the real `~/.claude` proven byte-unchanged.
- [ ] Bundled OpenCode install succeeds with network blocked (determinism guard).
- [ ] Escape assertion passes.

**Verify:** `bun test tests/e2e/install.e2e.ts`

### Task 3: Hooks-Fire E2E

**Objective:** Feed real `HookInput` JSON through the sandbox dispatcher and assert real Sentinal hook behavior.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/hooks.e2e.ts`

**Key Decisions / Notes:**
- Use the `hook.test.ts:30-45` spawn idiom but with the sandbox binary + env. Cases: (a) `Stop` spec-stop-guard with an in-sandbox IN_PROGRESS plan owned by the session → soft-context exit 0 (or block per env); (b) `PreToolUse` tdd-guard on an impl file with no test → block; (c) `PostToolUse` file-checker on a >600-line file → block/warn. Assert exit codes + stdout JSON shape.
- Seed sandbox `docs/plans` + `.sentinal` state as needed via the harness.

**Definition of Done:**
- [ ] At least 3 hook events assert correct exit code + output through the real dispatcher.
- [ ] Escape assertion passes.

**Verify:** `bun test tests/e2e/hooks.e2e.ts`

### Task 4: MCP Tools E2E + Test JSON-RPC Client

**Objective:** Drive the installed `sentinal mcp-server` over stdio JSON-RPC and assert tool availability + a round-trip call.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/harness/mcp-client.ts` (thin wrapper around the SDK client — see note)
- Create: `tests/e2e/mcp.e2e.ts`

**Key Decisions / Notes:**
- **Use `@modelcontextprotocol/sdk` (1.27.1, already a dep) `Client` + `StdioClientTransport`** pointed at the spawned sandbox `sentinal mcp-server` (with the sandbox env). Do NOT hand-roll JSON-RPC framing — that's the single most likely uniform false-failure (Pre-Mortem #2). The wrapper just constructs the transport with `{ command, args:["mcp-server"], env: sandbox.env }` and exposes `listTools()`/`callTool()`.
- Assert `tools/list` includes `memory_search`, `spec_status`, `tdd_status`; call `spec_status` (no side effects) and `memory_search` (empty result OK) and assert well-formed responses.

**Definition of Done:**
- [ ] SDK `Client` completes `initialize` + `listTools()` against the sandbox server (no hand-rolled framing).
- [ ] Named tools present; one `callTool` returns a valid result.
- [ ] Escape assertion passes.

**Verify:** `bun test tests/e2e/mcp.e2e.ts`

### Task 5: /spec Workflow + Stop-Guard E2E

**Objective:** Exercise the plan lifecycle + session-aware stop-guard in the sandbox.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/spec-workflow.e2e.ts`

**Key Decisions / Notes:**
- Register a mini plan in the sandbox (`sentinal register-plan` or the MCP `spec_register`), move it to IN_PROGRESS, then drive the `Stop` hook for the OWNING session (blocks/soft-nudges) vs a DIFFERENT live session (allows) — proving the session-aware stop-guard end-to-end through the installed binary.
- Reuse the ownership/liveness behavior; assert via exit codes + additionalContext JSON.

**Definition of Done:**
- [ ] Owning session `Stop` → surfaces block/soft-context; different-live-session `Stop` → allows (exit 0, no context).
- [ ] Escape assertion passes.

**Verify:** `bun test tests/e2e/spec-workflow.e2e.ts`

### Task 6: Sidecar + Memory E2E

**Objective:** Prove the sidecar starts on the SANDBOX socket and memory round-trips in-sandbox.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/sidecar-memory.e2e.ts`

**Key Decisions / Notes:**
- Must run via the e2e runner (`bun test tests/e2e/`) so the `bunfig.toml` sqlite-vec preload loads (else `vec0` fails). Trigger sidecar autostart (via an MCP call or a hook), assert `<home>/.sentinal/sidecar.sock` (or `.port`/`.pid`) exists in-SANDBOX; save an observation via `memory_save` MCP tool and read it back via `memory_search`/`memory_get`.
- **Hardened teardown (PID-reuse safe):** read the sandbox `.sentinal/*.pid`; before killing, verify the process's argv/cwd references the sandbox HOME (guard against a reused PID naming an unrelated host process); SIGTERM → poll for socket/pid removal (short timeout) → SIGKILL; as a backstop, grep running processes for the unique sandbox HOME path and kill survivors. Fold this into the Task 1 `cleanup()`.

**Definition of Done:**
- [ ] Sidecar state files appear under the sandbox `.sentinal/`, never the real one.
- [ ] An observation saved via MCP is retrievable via MCP in the same sandbox.
- [ ] Escape assertion passes; teardown verifies PID ownership before kill and leaves no process referencing the sandbox HOME.

**Verify:** `bun test tests/e2e/sidecar-memory.e2e.ts`

### Task 8: Opt-In Real-Binary Smoke Layer

**Objective:** When `SENTINAL_E2E_REAL=1`, drive the real `opencode`/`claude` binaries headless in the sandbox (with copied creds) and assert Sentinal actually fired.
**Dependencies:** Task 1
**Wave:** 3

**Files:**
- Create: `tests/e2e/real-binary.e2e.ts`

**Key Decisions / Notes:**
- `it.skipIf(!process.env.SENTINAL_E2E_REAL)` — AND **all sandbox construction + cred access live INSIDE the skipped `it` bodies** (or a `beforeAll` that early-returns when the flag is unset). NO module-level sandbox build, cred read, or binary reference — so a flag-unset run is truly zero-cost, binary-free, cred-free (must-fix combined with the default-discovery exclusion).
- **Credential strategy — prefer env-passthrough (spike):** first try `ANTHROPIC_API_KEY` / provider env vars passed through to the sandboxed process (no creds on disk). ONLY if env-passthrough doesn't authenticate, fall back to copying `~/.claude` creds + `~/.config/opencode/auth*` into the sandbox.
- **Failure-safe cred cleanup:** cred copy + run + assert inside a `try/finally`; the `finally` deletes copied creds and `rm -rf`s the sandbox EVEN IF the test throws; register an unref'd `process.on("exit"/"SIGINT")` scrubber. A fault-injection case proves creds are removed on throw.
- When enabled: install Sentinal into the sandbox, then run `opencode run --dangerously-skip-permissions -p "say hi"` and `claude -p --dangerously-skip-permissions "say hi"` with the sandbox env.
- **Assertion must prove Sentinal loaded**, not just binary exit 0: assert `<home>/.sentinal/plugin.debug.log` (OpenCode) exists/updated OR a fresh sidecar pid appeared in-sandbox after the run. Log clearly when skipped.

**Definition of Done:**
- [ ] Flag UNSET: `bun test tests/e2e/real-binary.e2e.ts` is green-by-skip with NO sandbox build, NO cred access, NO binary spawn (asserted).
- [ ] When enabled locally: real `opencode -p` run produces a Sentinal artifact in the sandbox `~/.sentinal`; assertion checks the artifact, not just exit code.
- [ ] Copied creds (if any) removed even when the test body throws (fault-injection case proves it); env-passthrough preferred when it authenticates.
- [ ] Escape assertion passes.

**Verify:** `SENTINAL_E2E_REAL=1 bun test tests/e2e/real-binary.e2e.ts` (local, authenticated) and `bun test tests/e2e/real-binary.e2e.ts` (skips).

### Task 7: Runner Script + Docs

**Objective:** Wire an `e2e` script and document how to run both layers.
**Dependencies:** Tasks 2-6, 8
**Wave:** 4

**Files:**
- Modify: `package.json` (add `"e2e": "bun run build:cli && bun test tests/e2e/"` and `"e2e:real": "SENTINAL_E2E_REAL=1 bun run e2e"`)
- Modify: `README.md` (short "E2E test harness" section: what it isolates, how to run Layer A / Layer B, the credential-copy caveat)

**Key Decisions / Notes:**
- e2e files use the `*.e2e.ts` / `*.spec-e2e.ts` suffix so a bare `bun test` never discovers them (✓ verified: `bun test` runs 0 e2e files). **RUNNER FINDING (Wave 2):** bun's DIRECTORY scan also skips these suffixes (it requires a `.test.`/`.spec.`/`_test_`/`_spec_` token with dots), so `bun test tests/e2e/` finds nothing. The runner MUST enumerate files via shell-glob → explicit paths: `bun test ./tests/e2e/harness/*.spec-e2e.ts ./tests/e2e/*.e2e.ts` (explicit paths run regardless of the token rule; sqlite-vec preload still applies). Verified: all 25 tests pass via this form.
- `e2e` builds the CLI first so the sandbox installs the compiled binary users actually get.

**Definition of Done:**
- [ ] `bun run e2e` builds CLI + runs Layer A green.
- [ ] **Falsifiable exclusion:** a bare `bun test` (no args) runs ZERO `tests/e2e/` files — proven by running `bun test` and asserting no e2e file executed (e.g. compare file/test counts, or `bun test 2>&1 | rg -c "tests/e2e/"` == 0).
- [ ] `bun run e2e:real` documented for local authenticated runs.
- [ ] README section present.

**Verify:** `bun run e2e` (Layer A green) + `bun test 2>&1 | rg -c "tests/e2e/"` returns 0 + `rg -n '"e2e"' package.json`
