# E2E Release-Artifact Gate Implementation Plan

Created: 2026-07-17
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Extend the existing isolated E2E harness so it can validate a **specific release artifact** — a locally release-built `sentinal-<os>-<arch>` binary (default) or a downloaded+checksum-verified GitHub release asset — including the **native-dep / non-bundled release configuration** a real user gets, and expose it as a one-shot `bun run pre-release` gate to run before tagging.

**Architecture:** Three small, layered additions on top of the current harness (no rewrite): (1) `createSandbox()` gains a caller-supplied **binary override** (`SENTINAL_E2E_BINARY`) and configurable `install({bundled})` / `SENTINAL_NO_AUTO_SETUP` so the sandbox can run the exact release binary in the real config; (2) a **download-asset helper** that fetches a release asset + `checksums.txt` and verifies sha256 before use (private-repo, gated on `GITHUB_TOKEN`); (3) new `*.e2e.ts` gate tests (version-identity, release-config install, opt-in native-dep provisioning) + a `pre-release` script that release-builds, points the harness at the artifact, and runs the deterministic suite.

**Tech Stack:** Bun ≥1.0, `bun:test` (sqlite-vec preload via `bunfig.toml`), TypeScript. Release build: `scripts/release-build.mjs` (`bun build --compile --target=bun-<os>-<arch>`). No new deps.

## Scope

### In Scope

- **Harness binary override:** `SENTINAL_E2E_BINARY=<path>` → `entry()` runs that binary verbatim (else current behavior: `dist/sentinal` else `bun src`). (`sandbox.ts:75-77`)
- **Harness config knobs:** `createSandbox(opts?)` and `install(target, opts?)` let callers (a) run install WITHOUT `--bundled` and (b) NOT force `SENTINAL_NO_AUTO_SETUP=1`, so the release-config path is reachable. Defaults unchanged (backward-compatible with all existing e2e tests).
- **Version identity:** a gate test asserts `sentinal --version` (of the binary under test) equals an expected version — proving the harness is exercising the intended artifact, not a stale/dev build. (`index.ts:47-72`)
- **Release-config install test:** run the release-built binary (self-selects embedded/binary mode via `/$bunfs/`, so `--bundled` is unnecessary) and assert install + activation land correctly — the exact path a `curl install.sh` user gets. (`install.ts:562-584`)
- **Opt-in native-dep provisioning test (`SENTINAL_E2E_DEPS=1`):** unset `SENTINAL_NO_AUTO_SETUP`, let the release binary really provision `~/.sentinal/deps` from the network, then assert memory/embeddings work (the #1 thing that passes the bundled harness but fails a real user). Gated → never runs offline/by default. (`native-deps.ts`, `setup.ts`, `auto-setup.ts:32`, `self-heal.ts:98-129`)
- **Download-asset mode (`GITHUB_TOKEN` present):** a helper that resolves the latest (or a given tag's) release, maps `os/arch → sentinal-<os>-<arch>`, downloads the asset + `checksums.txt`, **verifies sha256 (hard-fail on mismatch)**, then the gate runs the harness against it. Gated → skips cleanly without a token. (Reference: `install.sh:42-94`; NOTE `install.sh` does NOT verify checksums — implement fresh.)
- **`pre-release` script:** `bun run pre-release` = release-build the current-platform binary → point the harness at `dist/sentinal-<os>-<arch>` → run the deterministic gate suite (Layer A behaviors + version-identity + release-config install). Offline, fast, no token.
- **Docs:** README "pre-release gate" subsection (local build default; `SENTINAL_E2E_DEPS=1` and download+token modes as opt-ins).

### Out of Scope

- Cross-platform artifact testing on ONE host (a Mac can't run `sentinal-linux-*`). The gate tests the CURRENT platform's artifact; other platforms are validated by running the gate on that platform's CI/host. (Documented.)
- Real `opencode`/`claude` LLM turns — that's the existing `SENTINAL_E2E_REAL` layer, unchanged.
- A network-free native-dep test — impossible via the real provisioner (`setup.ts` runs `bun add`/`npm install`); the native-dep test is therefore network-gated and opt-in.
- Auto-wiring the gate into `.releaserc.json`/CI (this plan delivers the runnable gate + docs; CI wiring is a follow-up decision).
- npm/source install mode (`~/.npmrc` scoped registry) — the release binary always installs embedded (`isBinaryMode()`), so npm mode is not the release path.

## Context for Implementer

> Written for an implementer who has never seen this codebase.

**The harness (built earlier this session) is the base — DO NOT rewrite it.** `tests/e2e/harness/sandbox.ts` exports `createSandbox()` → `{ home, env, run(args,{stdin,cwd}), install(target), exists(path), cleanup() }`, plus `assertEnvContained`, `snapshotRealDirs`, `assertNoRealEscape`, `hashTree`. All Layer A e2e files import it. The escape guarantee is structural (`assertEnvContained` — requires HOME/XDG_CONFIG_HOME/CLAUDE_CONFIG_DIR inside the sandbox) + content-hash backstop.

**Binary resolution today** (`sandbox.ts:75-77`):
```ts
function entry(): string[] {
  return existsSync(CLI_COMPILED) ? [CLI_COMPILED] : ["bun", CLI_SRC];
}
```
`CLI_COMPILED = REPO_ROOT/dist/sentinal` — the **dev** build (`build:cli`), NOT a release artifact. Add: if `process.env.SENTINAL_E2E_BINARY` is set and exists, return `[that]`.

**Two hardcoded values that block the release config:**
- `sandbox.ts:69` — `SENTINAL_NO_AUTO_SETUP: "1"` in the env. Disables both post-install `runAutoSetup` (`install.ts:179`) AND sidecar self-heal (`self-heal.ts:105`). The native-dep test needs it UNSET. Not enforced by `assertEnvContained`, so making it optional doesn't weaken isolation. Also `sandbox.ts:36` types it as a required (non-optional) field — relax to optional.
- `sandbox.ts:104` — `install()` always passes `--bundled`. A release binary self-selects embedded mode via `isBinaryMode()` (`install.ts:562-565,584` — `argv[1].startsWith("/$bunfs/")`), so `--bundled` is unnecessary (but harmless) for it. Make `install(target, { bundled = true })` configurable.

**Backward-compat is mandatory:** all 6 existing e2e files call `createSandbox()` / `install(target)` with no options. New options MUST default to today's behavior (bundled=true, NO_AUTO_SETUP=1) so nothing breaks. Verify by re-running the full existing e2e suite.

**Release build (`scripts/release-build.mjs`):** `bun run` it → produces `dist/sentinal-{linux,darwin}-{x64,arm64}` + `dist/checksums.txt` (sha256, **basename-keyed** — `cwd: DIST_DIR`), version baked via `--define __SENTINAL_VERSION__`. TARGETS at `release-build.mjs:22-27`. The current platform's artifact name: `sentinal-<os>-<arch>` where os∈{linux,darwin}, arch∈{x64,arm64} (map from `process.platform`/`process.arch`: `darwin`→darwin, `linux`→linux; `arm64`→arm64, `x64`→x64).

**Version identity (`src/cli/index.ts:44-73`):** `getVersion()` returns `__SENTINAL_VERSION__` (compiled release) or `package.json` version (source). `sentinal --version` prints it (commander `-v, --version`). A gate asserts `run(["--version"]).stdout.trim()` matches expected.

**Download reference (`scripts/install.sh:42-94`):** os/arch detection → `ASSET_NAME="sentinal-${OS}-${ARCH}"`; latest release via `GET /repos/Endpoint-Esports-Ltd/sentinal/releases/latest` with `Authorization: token $GITHUB_TOKEN`; asset by **id** with `Accept: application/octet-stream`. Repo is PRIVATE → token required. **`install.sh` does NOT verify checksums** — the gate's download helper must fetch `checksums.txt` and compare sha256 itself.

**Native-dep resolution (`src/memory/native-deps.ts:24-197`):** compiled binary externalizes `@xenova/transformers` + `sqlite-vec`; resolves them from `~/.sentinal/deps` (bundle path for transformers is the compiled-binary variant). Provisioning (`src/memory/setup.ts:199-329`, `bun add`/`npm install`, network) is triggered by `runAutoSetup("install")` post-install (`install.ts:178-179`) when `SENTINAL_NO_AUTO_SETUP` is unset, by `sentinal memory setup` (`cli.ts:326`), or by sidecar self-heal (compiled-only, `self-heal.ts:107-129`). `nativeDepsStatus()` (`native-deps.ts:180-197`) reports what's resolved.

**Runner conventions (from the harness build):** e2e files use `*.e2e.ts` / `*.spec-e2e.ts` (NOT `.test.ts`) so a bare `bun test` never discovers them; bun's DIRECTORY scan ALSO skips these suffixes, so the runner ENUMERATES explicit file paths. Explicit paths need a `./` prefix. Avoid `*/` inside block comments. The `SENTINAL_NO_AUTO_SETUP`/binary env threads via `sb.env`. Sentinal's TDD guard treats a new `.e2e.ts` as an impl file — set `tdd_set_state` RED_CONFIRMED (file_path=test_file_path=the file, spec_id) before writing each.

## Runtime Environment

- Build the artifact: `bun run release-build` (or the new `pre-release` script does it). Run the gate: `bun run pre-release`. Opt-in layers: `SENTINAL_E2E_DEPS=1 bun run pre-release` (native deps, network), `GITHUB_TOKEN=... bun run pre-release:download` (published asset).
- Tests run via explicit paths under `bun test` (sqlite-vec preload from `bunfig.toml`). Sandbox lands everything under a temp HOME; teardown kills sandbox procs + `rm -rf`.

## Assumptions

- The release binary self-selects embedded/binary install mode via `isBinaryMode()` (`/$bunfs/`), so running it directly reproduces the `install.sh` user path without `--bundled` — supported by `install.ts:562-584`. Tasks 3/5 depend on this.
- `sentinal --version` on a release binary returns the `--define`'d version — supported by `index.ts:47-72` + `release-build.mjs:47`. Task 2 depends on this.
- Native-dep provisioning needs network and cannot be made offline — supported by `setup.ts:104-268` (`bun add`/`npm install`). Task 6 is therefore network-gated.
- The repo is private; download requires `GITHUB_TOKEN` — supported by `install.sh:33-38`. Task 4 skips without a token.
- Making `SENTINAL_NO_AUTO_SETUP` / `--bundled` optional does not weaken the escape guard (`assertEnvContained` doesn't check them) — supported by `sandbox.ts:133-159`. Task 1 depends on this.
- `checksums.txt` keys are basenames (`sentinal-<os>-<arch>`, no `dist/` prefix) — supported by `release-build.mjs:62-66` (`cwd: DIST_DIR`). Task 4 depends on this.

## Testing Strategy

- **Unit-testable helpers get standard `*.test.ts` tests** (discovered by default `bun test`): the download/checksum-verify helper's pure parts (asset-name mapping, checksum parsing/compare) — no network — go in a normal `.test.ts` so they run in CI.
- **Sandbox option changes** are covered by extending `sandbox.spec-e2e.ts` (binary override honored; bundled/NO_AUTO_SETUP toggles; defaults unchanged) AND by re-running ALL existing e2e files unchanged (backward-compat proof).
- **Gate e2e files** (`*.e2e.ts`) assert observed behavior against the real release binary: version identity, release-config install lands assets, native-dep status (opt-in).
- **Escape assertion** on every gate test (`assertNoRealEscape`).
- **Timeouts:** generous (release-build + install + potential dep provisioning are slow); explicit per-`it`.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| New `createSandbox`/`install` options break the 6 existing e2e files | Med | High | Options default to CURRENT behavior (bundled=true, NO_AUTO_SETUP=1); Task 1 DoD re-runs the FULL existing e2e suite green before anything else. |
| Native-dep test hangs/downloads 150MB in a default run | Med | Med | Gated behind `SENTINAL_E2E_DEPS=1`; default/offline gate never triggers it; explicit long timeout when it does. |
| Download mode leaks a token or hits rate limits | Low | Med | Token from env only (never logged); skip-with-reason when absent; use the same asset-id/octet-stream flow as install.sh. |
| Checksum file format mismatch (basename vs path) | Med | Med | Task 4 parses basenames per `release-build.mjs:62`; unit test covers parsing with a fixture `checksums.txt`. |
| `pre-release` tests the wrong (dev) binary silently | Med | High | Task 2 version-identity test asserts `--version` == the release-built version; `pre-release` sets `SENTINAL_E2E_BINARY` to the release artifact explicitly (fails if absent). |
| Cross-platform confusion (testing linux artifact on mac) | Low | Low | Gate tests only the current-platform artifact; documented; asset-name derived from `process.platform`/`arch`; CI runs the gate on a linux runner for linux `run` coverage. |
| Native-dep test (Task 6) pollutes the developer's REAL ~/.sentinal/deps | Low | High | Provisioning writes under the sandbox HOME (`DEPS_DIR = join(homedir(), ...)`, HOME overridden). Task 6 explicitly snapshots the real `~/.sentinal/deps` and asserts it's byte-unchanged; opt-in + network-heavy so it never runs in the default gate. |

## Pre-Mortem

_Assume this plan failed after full execution. Most likely internal reasons:_

1. **The gate passes but tests the dev build, not the release artifact** (Task 2) → Trigger: `SENTINAL_E2E_BINARY` isn't actually honored by `entry()` (typo/precedence), so the harness silently falls back to `dist/sentinal`. Observable: the version-identity test would still pass IF dev and release versions match — so the test must ALSO assert the binary PATH under test is the release artifact (e.g. the gate checks the resolved entry path), not just the version string.
2. **Backward-compat break** (Task 1) → Trigger: a new required option or a changed default flips `SENTINAL_NO_AUTO_SETUP`/`--bundled` for existing tests, and the sidecar/memory e2e starts doing network provisioning or a different install path. Observable: an existing e2e file that was green now hangs or fails. Mitigation: default-preserving options + full-suite re-run as the Task 1 gate.
3. **Native-dep test is green-by-accident** (Task 6) → Trigger: it asserts only "install exit 0" or "a .sentinal file appeared" without actually confirming embeddings/memory work post-provisioning. Observable: the dep bundle is missing but the test passes. Mitigation: assert `nativeDepsStatus()` reports resolved OR a real `memory_save`+`memory_search` round-trip succeeds against the provisioned binary.

## Execution Waves

**Wave 1 — Harness capability (single task, gates everything):** Task 1 (binary override + config knobs, backward-compat). All gate tests depend on it.

**Wave 2 — Gate tests + download helper (parallel, no file overlap):** Task 2 (version-identity `release-identity.e2e.ts`), Task 3 (release-config install `release-install.e2e.ts`), Task 4 (download+checksum helper `release-asset.ts` + its `.test.ts`), Task 6 (native-dep `release-deps.e2e.ts`). Each is its own new file importing the Task 1 harness — no shared files → parallel. (Task 4's helper is imported by Task 5's script, not by the other gate tests, so no Wave-2 conflict.)

**Wave 3 — Runner + docs:** Task 5 (`pre-release` scripts in package.json + README section) — depends on all gate files + the download helper existing.

## Goal Verification

### Truths

1. `tests/e2e/harness/sandbox.ts` honors `SENTINAL_E2E_BINARY` — grep: `SENTINAL_E2E_BINARY` in `entry()`; a sandbox test proves a custom binary path is used.
2. `createSandbox`/`install` accept options that default to today's behavior — the FULL existing e2e suite (`install/hooks/mcp/spec-workflow/sidecar-memory/real-binary.e2e.ts` + `sandbox.spec-e2e.ts`) passes unchanged.
3. A version-identity gate test asserts `sentinal --version` (of the artifact under test) equals the expected release version AND that the resolved binary is the release artifact path — grep: `--version` + `SENTINAL_E2E_BINARY` in `release-identity.e2e.ts`.
4. A release-config install gate test runs the release binary and asserts install/activation assets land in the sandbox — grep: `release-install.e2e.ts` present, asserts `opencode.json`/plugin.
5. `tests/e2e/harness/release-asset.ts` downloads an asset + verifies sha256 against `checksums.txt`; its pure helpers are unit-tested in a `.test.ts` (asset-name mapping + checksum compare) that runs in the default suite.
6. A native-dep gate test (`SENTINAL_E2E_DEPS=1`) proves the release binary resolves native deps after real provisioning (`nativeDepsStatus` resolved OR a memory round-trip) — grep: `SENTINAL_E2E_DEPS` + `nativeDepsStatus`/`memory_` in `release-deps.e2e.ts`; skips cleanly without the flag.
7. `package.json` has `pre-release` (offline, local release-build) and a download variant — grep: `"pre-release"` in package.json; README documents them.
8. Default-suite exclusion is falsifiable both ways: a bare `bun test` DOES discover `release-asset.test.ts` (grep for a unique test name it defines) and does NOT execute any `.e2e.ts` sentinel test name (grep for a unique name defined only in a `release-*.e2e.ts` — it must be absent).
9. Cross-platform coverage is pinned: the offline `pre-release` gate validates only the current host's artifact; linux `run` coverage happens via CI running `bun run pre-release` on a linux runner (documented in README + this plan). The download mode covers linux download+checksum-integrity from any host but not execution.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `tests/e2e/harness/sandbox.ts` (modify) | Binary override + config knobs | `createSandbox(opts?)`, `install(target, opts?)` |
| `tests/e2e/harness/release-asset.ts` (new) | Download + checksum-verify a release asset | `assetNameFor()`, `verifyChecksum()`, `downloadReleaseAsset()` |
| `tests/e2e/harness/release-asset.test.ts` (new) | Unit tests for pure helpers | — |
| `tests/e2e/release-identity.e2e.ts` (new) | Version/identity gate | — |
| `tests/e2e/release-install.e2e.ts` (new) | Release-config install gate | — |
| `tests/e2e/release-deps.e2e.ts` (new) | Opt-in native-dep gate | — |
| `package.json` (modify) | `pre-release` runner scripts | — |
| `scripts/pre-release.mjs` (new, optional) | Orchestrate release-build → set env → run gate | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `tests/e2e/release-*.e2e.ts` | `tests/e2e/harness/sandbox.ts` | import | `import.*harness/sandbox` |
| `scripts/pre-release.mjs` | `dist/sentinal-<os>-<arch>` | `SENTINAL_E2E_BINARY` env | `SENTINAL_E2E_BINARY` |
| `tests/e2e/harness/release-asset.ts` | GitHub releases API | asset id + octet-stream | `releases/assets/` |
| `tests/e2e/harness/release-asset.ts` | `checksums.txt` | sha256 compare | `createHash\("sha256"\)` |
| `tests/e2e/release-identity.e2e.ts` | binary under test | `--version` | `"--version"` |

## Progress Tracking

- [x] Task 1: Harness binary override + config knobs (backward-compat) (Wave 1) — binaryPath override (throws on missing), autoSetup deletes NO_AUTO_SETUP, install bundled knob; existing e2e 32 pass/2 skip unchanged
- [x] Task 2: Version/identity gate test (Wave 2) — binaryPath===override + dev-fallback rejected + --version check
- [x] Task 3: Release-config install gate test (Wave 2) — bundled:false → embedded install; real ~/.claude untouched
- [x] Task 4: Download + checksum-verify asset helper (+ 17 unit tests, selectAssetIds) (Wave 2)
- [x] Task 6: Opt-in native-dep gate test (Wave 2) — real memory round-trip vs sb.binaryPath; real deps-dir isolation. Also: mcp-client honors SENTINAL_E2E_BINARY
- [x] Task 5: pre-release runner scripts + docs (Wave 3) — `bun run pre-release` builds real sentinal-darwin-arm64 + gate 35 pass; exclusion proven both ways
      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: Harness Binary Override + Config Knobs

**Objective:** Let the harness run a caller-supplied binary and reach the release configuration, WITHOUT breaking any existing e2e test.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `tests/e2e/harness/sandbox.ts`
- Modify: `tests/e2e/harness/sandbox.spec-e2e.ts` (add coverage)

**Key Decisions / Notes:**
- `entry()`: if `process.env.SENTINAL_E2E_BINARY` is set → **it MUST resolve to an existing file; if the file does NOT exist, THROW** (never silently fall back to the dev `dist/sentinal` — a bad path in `pre-release.mjs` would otherwise produce a green gate against the dev build, pre-mortem #1). If set+exists → return `[that]`. If unset → current logic (`dist/sentinal` else `bun src`). Expose the resolved path as `sandbox.binaryPath` so a gate test can assert WHICH binary is under test.
- `createSandbox(opts?: { autoSetup?: boolean })`: when `autoSetup === true`, **`delete env.SENTINAL_NO_AUTO_SETUP`** from the spread env (must DELETE, not merely skip setting — otherwise an inherited `SENTINAL_NO_AUTO_SETUP` from the developer's real shell survives the `...process.env` spread and makes Task 6 non-deterministic). Default (`false`/absent) keeps `SENTINAL_NO_AUTO_SETUP: "1"`. Relax the `SandboxEnv.SENTINAL_NO_AUTO_SETUP` field to optional (`sandbox.ts:36`) — isolation-safe since `assertEnvContained` (`sandbox.ts:133-159`) does not check it.
- `install(target, opts?: { bundled?: boolean })`: default `bundled = true` (unchanged); when `false`, omit `--bundled`.
- ⛔ Backward-compat: all existing callers pass no options → identical behavior. Re-run the full existing e2e suite as the gate.

**Definition of Done:**
- [ ] `SENTINAL_E2E_BINARY=<existing path>` makes `run()`/`install()` spawn that binary; `sandbox.binaryPath` === `resolve(SENTINAL_E2E_BINARY)`.
- [ ] `SENTINAL_E2E_BINARY=<nonexistent path>` → `createSandbox()`/`entry()` **THROWS** (no silent dev fallback) — covered by a `sandbox.spec-e2e.ts` case.
- [ ] `createSandbox({ autoSetup: true }).env.SENTINAL_NO_AUTO_SETUP` is `undefined` EVEN when `process.env.SENTINAL_NO_AUTO_SETUP` was set (delete-from-spread proven by a test that sets it first); default still sets `"1"`.
- [ ] `install(target, { bundled: false })` omits `--bundled`; default includes it.
- [ ] The FULL existing e2e suite passes unchanged (backward-compat proof).

**Verify:**
- `bun test ./tests/e2e/harness/sandbox.spec-e2e.ts`
- `bun test ./tests/e2e/harness/sandbox.spec-e2e.ts ./tests/e2e/install.e2e.ts ./tests/e2e/hooks.e2e.ts ./tests/e2e/mcp.e2e.ts ./tests/e2e/spec-workflow.e2e.ts ./tests/e2e/sidecar-memory.e2e.ts ./tests/e2e/real-binary.e2e.ts` (all green)

### Task 2: Version/Identity Gate Test

**Objective:** Prove the gate is exercising the intended artifact — not a stale/dev build.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/release-identity.e2e.ts`

**Key Decisions / Notes:**
- ⚠️ **`--version` alone is provably insufficient** (reviewer-confirmed): a LOCAL release build and the dev `dist/sentinal` are built from the SAME `package.json`, so `sentinal --version` is IDENTICAL for both. The `binaryPath` check is the ONLY thing that catches the dev-fallback trap.
- With `SENTINAL_E2E_BINARY` pointed at a release-built binary, assert (a) `sb.binaryPath === resolve(SENTINAL_E2E_BINARY)` AND **FAIL if `binaryPath` is the dev `dist/sentinal` (`CLI_COMPILED`) or the `bun src` fallback**, and (b) `sb.run(["--version"]).stdout.trim()` equals the expected version (`package.json` version for a local build, or env `SENTINAL_E2E_EXPECT_VERSION`).
- Gate the whole file on `SENTINAL_E2E_BINARY` being set (skip-with-reason otherwise) so it's a no-op in the plain `e2e` suite.

**Definition of Done:**
- [ ] When `SENTINAL_E2E_BINARY` is set: asserts `sb.binaryPath === resolve(SENTINAL_E2E_BINARY)` and HARD-FAILS if it resolved to the dev build / bun-src fallback.
- [ ] Asserts `--version` matches the expected release version.
- [ ] Skips cleanly (no-op) when unset. Escape assertion passes.

**Verify:** `SENTINAL_E2E_BINARY=$(pwd)/dist/sentinal bun test ./tests/e2e/release-identity.e2e.ts`

### Task 3: Release-Config Install Gate Test

**Objective:** Prove a real release binary installs + activates Sentinal in the sandbox (the `install.sh` user path).
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/release-install.e2e.ts`

**Key Decisions / Notes:**
- Point at the release binary via `SENTINAL_E2E_BINARY`; call `sb.install("opencode", { bundled: false })` (release binary self-selects embedded mode). Assert `<home>/.config/opencode/opencode.json` + plugin land, and Claude assets land, exactly like `install.e2e.ts` — but through the RELEASE binary. Assert no real escape.
- Gate on `SENTINAL_E2E_BINARY` set.

**Definition of Done:**
- [ ] Release binary install lands opencode.json+plugin (and Claude assets) in the sandbox.
- [ ] `--bundled` NOT required (release binary self-selects embedded).
- [ ] Skips when `SENTINAL_E2E_BINARY` unset; escape assertion passes.

**Verify:** `SENTINAL_E2E_BINARY=$(pwd)/dist/sentinal bun test ./tests/e2e/release-install.e2e.ts`

### Task 4: Download + Checksum-Verify Asset Helper

**Objective:** Fetch a published release asset and verify its sha256 before the gate runs against it.
**Dependencies:** None (pure helper; used by Task 5)
**Wave:** 2

**Files:**
- Create: `tests/e2e/harness/release-asset.ts`
- Create: `tests/e2e/harness/release-asset.test.ts` (unit — runs in default `bun test`)

**Key Decisions / Notes:**
- Pure helpers (no network, unit-tested): `assetNameFor(platform, arch)` → `sentinal-<os>-<arch>` (map darwin/linux, x64/arm64; throw on unsupported — mirror `install.sh:42-60`); `parseChecksums(text)` → `Map<basename, sha256>` (basename-keyed per `release-build.mjs:62`); `verifyChecksum(fileBytes, expectedSha)` → boolean via `createHash("sha256")`.
- **Asset-selection is ALSO a pure function + unit-tested** (reviewer should-fix — a bug picking `checksums.txt` as the binary or a partial-name match would ship silently): `selectAssetIds(releaseJson, assetName)` → `{ binaryId, checksumsId }` given a GitHub releases API JSON object. Unit-test it against a captured/fixture releases JSON (exact-name match, checksums.txt id, throws when the asset is missing) — no network.
- Network helper (gated on `GITHUB_TOKEN`, NOT unit-tested): `downloadReleaseAsset({ tag?, token, destDir })` → resolve release (latest or `tag`) via `GET /repos/Endpoint-Esports-Ltd/sentinal/releases/{latest|tags/<tag>}` with `Authorization: token`, call `selectAssetIds()`, download both by id with `Accept: application/octet-stream`, **verify sha256 (throw on mismatch)**, `chmod +x`, return the local path. Never log the token.

**Definition of Done:**
- [ ] `assetNameFor`, `parseChecksums`, `verifyChecksum`, **`selectAssetIds`** unit-tested (incl. unsupported-arch throw, checksum mismatch → false, asset-id selection against a fixture releases JSON incl. missing-asset throw) in a `.test.ts` that runs under default `bun test`.
- [ ] `downloadReleaseAsset` verifies sha256 and throws on mismatch (covered by a mismatch unit test using an in-memory fixture, not a real download).

**Verify:** `bun test tests/e2e/harness/release-asset.test.ts`

### Task 6: Opt-In Native-Dep Gate Test

**Objective:** Prove the release binary resolves its externalized native deps after real provisioning — the #1 thing the bundled harness misses.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Create: `tests/e2e/release-deps.e2e.ts`

**Key Decisions / Notes:**
- `it.skipIf(!process.env.SENTINAL_E2E_DEPS || !process.env.SENTINAL_E2E_BINARY)` — needs BOTH the release binary AND the opt-in flag (network + ~150MB). All sandbox/network work inside the skipped body.
- Create sandbox with `{ autoSetup: true }` (NO_AUTO_SETUP deleted), install via the release binary, let provisioning run (post-install `runAutoSetup` OR trigger `sentinal memory setup`).
- **The PRIMARY proof is a real `memory_save`+`memory_search` round-trip** (via the MCP client / `sb.run`) against the provisioned release binary — this forces the 384-dim `@xenova/transformers` embedding + `sqlite-vec` to actually load and run (pre-mortem #3). `nativeDepsStatus()` reporting both deps resolved is a SECONDARY sanity check, NOT a substitute (a stale/broken transformers bundle can report "resolved" but fail to embed).
- ⚠️ **Highest-blast-radius test** (unsets NO_AUTO_SETUP, runs real `bun add`/`npm install`). Provisioning writes to the SANDBOX `~/.sentinal/deps` because `DEPS_DIR = join(homedir(), ...)` and the sandbox overrides `HOME`. Assert this explicitly: (a) the provisioned bundle lives under `sb.home` (`sb.exists(join(sb.home, ".sentinal", "deps"))`), AND (b) snapshot the REAL `~/.sentinal/deps` (hash) before/after and assert unchanged — a HOME-resolution regression would otherwise silently pollute the developer's real deps dir.
- Long explicit timeout (e.g. 600_000 ms). Escape assertion passes.

**Definition of Done:**
- [ ] With `SENTINAL_E2E_DEPS=1` + `SENTINAL_E2E_BINARY`: a `memory_save`+`memory_search` round-trip SUCCEEDS against the provisioned release binary (PRIMARY), AND `nativeDepsStatus()` reports both deps resolved (secondary).
- [ ] The provisioned deps live under `sb.home/.sentinal/deps`; the REAL `~/.sentinal/deps` is byte-unchanged (explicit pre/post assertion).
- [ ] Skips cleanly without either flag; escape assertion passes.

**Verify:** `SENTINAL_E2E_DEPS=1 SENTINAL_E2E_BINARY=$(pwd)/dist/sentinal-<os>-<arch> bun test ./tests/e2e/release-deps.e2e.ts` (local, network)

### Task 5: pre-release Runner Scripts + Docs

**Objective:** One-shot gate to run before tagging.
**Dependencies:** Tasks 1-4, 6
**Wave:** 3

**Files:**
- Create: `scripts/pre-release.mjs`
- Modify: `package.json` (scripts)
- Modify: `README.md` (pre-release gate section)

**Key Decisions / Notes:**
- **CURRENT-platform only** (resolves the earlier open "decide" — per the approved offline default). `scripts/pre-release.mjs`: run `release-build.mjs`, compute the current-platform artifact path `dist/sentinal-<os>-<arch>` (from `process.platform`→{darwin,linux}, `process.arch`→{x64,arm64}), FAIL if it's missing, set `SENTINAL_E2E_BINARY` to it, then run the PINNED gate suite via explicit paths.
- **Run via `bun`, not `node`** (repo runtime is Bun; the spawned `bun test` must inherit the `bunfig.toml` sqlite-vec preload): `"pre-release": "bun scripts/pre-release.mjs"`. The script uses only Bun-compatible APIs (`Bun.spawnSync`/`Bun.spawn`).
- **Pinned gate file list** (falsifiable — the whole point of this plan is preventing silent omission): the exact explicit paths are the deterministic Layer A files + the two identity/install gate files:
  `./tests/e2e/harness/sandbox.spec-e2e.ts ./tests/e2e/install.e2e.ts ./tests/e2e/hooks.e2e.ts ./tests/e2e/mcp.e2e.ts ./tests/e2e/spec-workflow.e2e.ts ./tests/e2e/sidecar-memory.e2e.ts ./tests/e2e/release-identity.e2e.ts ./tests/e2e/release-install.e2e.ts`.
  The script MUST exit non-zero if `bun test` reports **0 tests run** for the suite (guards a mistyped `./path` silently running nothing).
- `package.json`: `"pre-release": "bun scripts/pre-release.mjs"`, `"pre-release:deps": "SENTINAL_E2E_DEPS=1 bun scripts/pre-release.mjs"`, `"pre-release:download": "bun scripts/pre-release.mjs --download"` (download mode requires `GITHUB_TOKEN`).
- **Cross-platform coverage is explicit** (should-fix): the offline gate on a given host only validates THAT host's artifact (a Mac cannot execute `sentinal-linux-*`). The download mode can fetch+checksum-verify a linux asset from a Mac but CANNOT run it (download+integrity only). **README + a Goal-Verification Truth pin where linux `run` coverage happens: CI must run `bun run pre-release` on a linux runner as the authoritative linux gate.**

**Definition of Done:**
- [ ] `bun run pre-release` release-builds the current-platform binary, FAILS if missing, points the harness at it, runs the PINNED gate suite green.
- [ ] `pre-release` exits non-zero if the gate suite reports 0 tests run.
- [ ] `pre-release:deps` and `pre-release:download` documented + wired; script runs via `bun`.
- [ ] Default-suite exclusion proven (Truth #8 method): a unit test in `release-asset.test.ts` IS discovered by bare `bun test`; no `.e2e.ts` sentinel test executes.
- [ ] README "Pre-release gate" section present, including the cross-platform/CI-linux caveat.

**Verify:** `bun run pre-release` (green) + `rg -n '"pre-release"' package.json`
