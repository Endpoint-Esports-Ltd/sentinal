---
name: sentinal-e2e-harness
description: |
  How to build/use the isolated E2E harness that installs & drives Sentinal (and
  the real opencode/claude binaries) in a temp HOME without touching the user's
  real ~/.claude, ~/.config/opencode, ~/.opencode, ~/.sentinal. Use when:
  (1) writing or extending tests under tests/e2e/, (2) validating a fresh build
  or RELEASE ARTIFACT before a release (`bun run pre-release`), (3) a test must
  install Sentinal / spawn opencode|claude / start the sidecar in isolation,
  (4) an E2E test unexpectedly wrote to a real config dir or leaked a process,
  (5) real-binary Layer B skips/fails on auth ("Not logged in"), (6) you need to
  observe real OpenCode plugin events or tool errors without credentials.
author: Claude Code
version: 1.2.0
---

# Isolated E2E Harness

## When to Use

Any test that must run Sentinal's real entrypoints (install, hooks, MCP server,
sidecar, or the real opencode/claude binaries) end-to-end WITHOUT mutating the
developer's real installs — or a pre-release gate against the actual artifact.

## The isolation model (the single enabling fact)

Every Sentinal path keys off `os.homedir()` / `XDG_CONFIG_HOME`; the installer
also spawns the real `claude` which resolves its registry via `CLAUDE_CONFIG_DIR`.
A temp `HOME` + these overrides fully isolates everything. `tests/e2e/harness/sandbox.ts`
already does this — **import it, don't rebuild it**:

```ts
import {
  createSandbox,
  assertNoRealEscape,
  snapshotRealDirs,
} from "./harness/sandbox.ts";
const sb = createSandbox(); // temp HOME + XDG_CONFIG_HOME + CLAUDE_CONFIG_DIR
sb.install("opencode"); // sentinal install <target> --bundled, in-sandbox
sb.run(["hook", "shared", "spec-stop-guard"], { stdin, cwd: sb.home });
sb.cleanup(); // kills sandbox procs (env-ownership-checked), rm -rf, THROWS on survivors
```

Sandbox env (all set by `createSandbox`): `HOME`, `XDG_CONFIG_HOME=$HOME/.config`,
`CLAUDE_CONFIG_DIR=$HOME/.claude` (REQUIRED — HOME alone does NOT redirect the
spawned `claude`), `SENTINAL_NO_AUTO_SETUP=1`, `CLAUDE_PLUGIN_DATA=""` (cleared —
the one var that can relocate the memory DB outside HOME),
`SENTINAL_HOME=$HOME/.sentinal` (pinned — see below), and
`SENTINAL_E2E_SANDBOX_ID=sentinal-e2e-<uuid>` (also exposed as `sb.id`; it is
how teardown and the escape check recognise this sandbox's processes and log
lines). NEVER set HOME to `/` or empty (root-guard: `homedir()`→`/`).

Layout (`tests/e2e/harness/`): `sandbox.ts` (createSandbox, binary resolution,
`assertEnvContained`; re-exports the rest — import everything from it),
`sandbox-procs.ts` (`killSandboxProcesses`), `real-escape.ts`
(`snapshotRealDirs` / `assertNoRealEscape` / `hashTree`).

## Rules that prevent escapes / flakes

- **Escape guarantee is structural first:** `assertEnvContained(env, home)` runs
  before every spawn (proves the process env stays inside the sandbox). The
  backstop `snapshotRealDirs()`/`assertNoRealEscape()` then checks the real
  dirs. Put `snapshotRealDirs()` in `beforeAll`, `assertNoRealEscape()` in
  `afterEach`.
- **The backstop checks ATTRIBUTABLE writes, so a live Sentinal can keep
  running** (`real-escape.ts`). Default mode: real `~/.sentinal/*.log` bytes
  appended after the snapshot must not name a sandbox HOME (or its realpath) or
  id; the real `memory.db` is opened read-only and the counts of rows keyed to
  a sandbox/tmpdir path or a test session id (`E2E_TEST_SESSION_IDS`) must not
  change; static user config (`~/.claude` settings/rules/commands/…,
  `~/.config/opencode` config, rc files, `~/.sentinal/config.json`) is
  content-hashed and `~/.sentinal/{bin,deps,models}` stat-fingerprinted.
  `SENTINAL_E2E_STRICT_ESCAPE=1` additionally fingerprints the WHOLE real trees
  (bin/deps/models stat-only) — only usable with no live Sentinal running.
- **Teardown is pidfile-first, env-matched** (`sandbox-procs.ts`). Sandbox
  sidecar/dashboard command lines do NOT contain the sandbox path (it is only in
  the env), so matching the command line leaked processes that recreated the
  deleted HOME. `killSandboxProcesses(home, id)` kills the pids in
  `<sandbox>/.sentinal/{sidecar,server}.pid` after proving via `ps eww` that
  their env carries this sandbox's `SENTINAL_E2E_SANDBOX_ID` / `HOME` /
  `SENTINAL_HOME` (a recycled pid or the user's real sidecar is never
  signalled), then strays found by the same env match; SIGTERM → grace →
  SIGKILL, rescanning for late respawns. `sb.cleanup()` throws if any survive.
- **A stale `dist/sentinal` is refused.** With `SENTINAL_E2E_BINARY` unset, the
  harness uses `dist/sentinal` only if its `--version` equals `package.json`'s
  AND it is newer than every non-test file under `src/`
  (`assertCompiledBinaryFresh`); otherwise it THROWS telling you to run
  `bun run build:cli` or set `SENTINAL_E2E_BINARY`. No `dist/sentinal` →
  `bun src/cli/index.ts`. (A months-old dist once made a failing test pass.)
  An explicit `SENTINAL_E2E_BINARY` is deliberately NOT freshness-checked.
- **Pre-install `sb.run` needs `{ cwd: sb.home }`** — the default cwd `<home>/work`
  only exists after `install()` (which `mkdir -p`s it). A missing cwd gives a
  misleading `ENOENT posix_spawn`.
- **Use `--bundled` install** (default) — avoids the `~/.npmrc` scoped-registry
  network requirement. A COMPILED binary self-selects embedded mode via
  `isBinaryMode()` (`/$bunfs/`), so `install(target,{bundled:false})` also works
  for release binaries.
- **MCP in-subprocess needs sqlite-vec:** prefer the compiled `dist/sentinal`
  (bundles sqlite-vec → `vec0` loads); the harness/mcp-client resolves it.

## Real-binary layer (opt-in, needs credentials) — auth reality

`SENTINAL_E2E_REAL=1` drives the real `opencode`/`claude`. Gate all setup inside
the skipped `it` bodies (green-by-skip when unset). Assert a Sentinal ARTIFACT
(`<home>/.sentinal/plugin.debug.log` / memory.db / sidecar pid), NOT the LLM
exit code — a full `opencode run` turn does NOT complete in a fresh sandbox HOME
even with `--pure` (OpenCode limitation, not a Sentinal bug).

Auth facts (verified):

- **OpenCode subscription OAuth is copyable:** `~/.local/share/opencode/auth.json`
  (XDG DATA dir — NOT `~/.config/opencode/`). Copy it into the sandbox and run
  `opencode run "msg" --model anthropic/claude-haiku-4-5` (message is POSITIONAL;
  `-p` is `--password`, NOT prompt; `--dangerously-skip-permissions` is not a `run` flag).
- **Claude subscription auth CANNOT be sandboxed:** it lives in the macOS Keychain
  (`"Claude Code-credentials"`), bound to the real profile; `claude -p` in a sandbox
  HOME reports "Not logged in". Gate the Claude case behind a PORTABLE credential
  (`ANTHROPIC_API_KEY` or `~/.claude/.credentials.json`) and skip otherwise. Docker
  does NOT help — a Linux container has no Keychain either.
- **Copied creds must be scrubbed in a `finally`** (fault-injection test proves it).

### OpenCode with NO credentials: fake model + `opencode serve`

To observe real plugin behaviour (hooks, events, tool errors) without any auth,
put a **local fake OpenAI-compatible chat server** behind a custom provider in
the sandbox `opencode.json`, and have it reply with scripted tool calls chosen
by a keyword in the prompt. Verified 2026-09-24 on OpenCode 1.18.32 — full turns
DO complete this way, unlike `opencode run` against a real provider above.

- Launch: `env -i HOME=<tmp> XDG_CONFIG_HOME=… XDG_DATA_HOME=… XDG_STATE_HOME=…
XDG_CACHE_HOME=… PATH=… opencode serve --port <p>`. Drop inherited
  `OPENCODE` / `OPENCODE_PID` — they leak from the parent OpenCode session.
  Confirm from the server log that config loaded only from the temp home.
- Drive over HTTP: `POST /session/:id/message` (or `prompt_async`), `/abort`,
  `POST /permission/:id/reply` for ask/reject cases.
- Probe plugin: `$XDG_CONFIG_HOME/opencode/plugin/<name>.ts`, appending every
  `event`, `tool.execute.before` and `tool.execute.after` to a JSONL file.
- The exact custom-provider config was not recorded; take its shape from the
  installed SDK types (`sentinal-opencode-api-source` §1), not from memory.
- Record the PIDs you start (serve + fake server) and kill only those.

### Harness facts (fixed 2026-09-24)

- Each sandbox sets `SENTINAL_HOME=<sandbox HOME>/.sentinal` and asserts it
  stays inside the sandbox. Before that, sandboxes inherited the test runner's
  temp home and all shared one DB (`spec-workflow.e2e.ts` 0/4 → 3/4).
- ~~`assertNoRealEscape` hashes all of `~/.sentinal`~~ — replaced by the
  attributable-write check above (2026-09-24 hardening sweep, Task 8); the old
  hash tripped on every live sidecar write.
- `*.e2e.ts` and `*.spec-e2e.ts` are test files for both the TDD guard
  (`isTestFile`, `src/utils/tdd.ts`) and the file-length limit
  (`src/utils/file-length.ts`) — no manual `RED_CONFIRMED` needed.
- The user's real DB already held 5 `sessions` rows keyed to tmp paths from
  earlier escapes; the check compares counts, so pre-existing rows don't trip it.

## Release-artifact gate

`bun run pre-release` builds the current-platform `sentinal-<os>-<arch>` (as the
release pipeline does), sets `SENTINAL_E2E_BINARY`, and runs the pinned gate.

- `SENTINAL_E2E_BINARY=<path>` overrides the binary the harness runs; `sandbox.ts`
  THROWS if it's set-but-missing (no silent dev fallback). `sb.binaryPath` exposes it.
- **Version-identity trap:** dev + local-release share `package.json` version, so
  `--version` alone can't distinguish them — assert `sb.binaryPath === resolve(override)`.
- `createSandbox({ autoSetup: true })` DELETES `SENTINAL_NO_AUTO_SETUP` (for the
  opt-in native-dep test); native-dep provisioning needs network (~150MB).

## Verification

```bash
bun run e2e                              # deterministic Layer A, CI-safe
SENTINAL_E2E_REAL=1 bun run e2e:real     # + real binaries (local, needs creds)
bun run pre-release                      # release-artifact gate (current platform)
SENTINAL_E2E_STRICT_ESCAPE=1 bun run e2e # full real-tree check (no live Sentinal running)
# no sandbox procs leak (they are identified by env, not command line):
ps axeww | grep -c "SENTINAL_E2E_SANDBOX_ID=sentinal-e2e-" ; ls -lad ~/.claude ~/.config/opencode
```

## When NOT to Use

- Pure unit tests (no install/spawn/isolation needed) — use a normal `*.test.ts`.
- Testing OpenCode/Claude Code's OWN correctness — only Sentinal's behavior in them.
- CI Claude real-binary runs — subscription auth can't be sandboxed; needs an API key.

## References

- `tests/e2e/harness/sandbox.ts` (createSandbox/assertEnvContained/assertCompiledBinaryFresh)
- `tests/e2e/harness/sandbox-procs.ts` (killSandboxProcesses), `real-escape.ts`
  (snapshotRealDirs/assertNoRealEscape/hashTree)
- `tests/e2e/harness/release-asset.ts`, `scripts/pre-release.mjs`
- Sibling skill `sentinal-bun-e2e-discovery` (bun test file-discovery/runner gotchas)
- Memory: E2E harness build + Layer B live-verification + release-gate patterns (2026-07-17)
