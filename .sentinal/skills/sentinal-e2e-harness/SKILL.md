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
  (5) real-binary Layer B skips/fails on auth ("Not logged in").
author: Claude Code
version: 1.0.0
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
import { createSandbox, assertNoRealEscape, snapshotRealDirs } from "./harness/sandbox.ts";
const sb = createSandbox();            // temp HOME + XDG_CONFIG_HOME + CLAUDE_CONFIG_DIR
sb.install("opencode");                // sentinal install <target> --bundled, in-sandbox
sb.run(["hook","shared","spec-stop-guard"], { stdin, cwd: sb.home });
sb.cleanup();                          // kills sandbox procs (PID-ownership-checked) + rm -rf
```

Sandbox env (all set by `createSandbox`): `HOME`, `XDG_CONFIG_HOME=$HOME/.config`,
`CLAUDE_CONFIG_DIR=$HOME/.claude` (REQUIRED — HOME alone does NOT redirect the
spawned `claude`), `SENTINAL_NO_AUTO_SETUP=1`, `CLAUDE_PLUGIN_DATA=""` (cleared —
the one var that can relocate the memory DB outside HOME). NEVER set HOME to `/`
or empty (root-guard: `homedir()`→`/`).

## Rules that prevent escapes / flakes

- **Escape guarantee is structural first:** `assertEnvContained(env, home)` runs
  before every spawn (proves the process env stays inside the sandbox). The
  content-hash backstop `snapshotRealDirs()`/`assertNoRealEscape()` catches
  nested-file rewrites mtime/entry-list would miss. Put `snapshotRealDirs()` in
  `beforeAll`, `assertNoRealEscape()` in `afterEach`.
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
# real dirs must be byte-unchanged; no sandbox procs leak:
pgrep -fl "sentinal-e2e-" ; ls -lad ~/.claude ~/.config/opencode
```

## When NOT to Use

- Pure unit tests (no install/spawn/isolation needed) — use a normal `*.test.ts`.
- Testing OpenCode/Claude Code's OWN correctness — only Sentinal's behavior in them.
- CI Claude real-binary runs — subscription auth can't be sandboxed; needs an API key.

## References

- `tests/e2e/harness/sandbox.ts` (createSandbox/assertEnvContained/hashTree/snapshotRealDirs)
- `tests/e2e/harness/release-asset.ts`, `scripts/pre-release.mjs`
- Sibling skill `sentinal-bun-e2e-discovery` (bun test file-discovery/runner gotchas)
- Memory: E2E harness build + Layer B live-verification + release-gate patterns (2026-07-17)
