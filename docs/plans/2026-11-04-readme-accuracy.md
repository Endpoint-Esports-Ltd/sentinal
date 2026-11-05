# README Accuracy Update Implementation Plan

Created: 2026-11-04
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Make the README accurate again — starting with the curl install, which documents a
token the now-public repo no longer needs (and which `scripts/install.sh` still hard-requires) —
and remove the remaining "private repo" assumptions from the installer, updater and pre-release
tooling.

**Architecture:** `Endpoint-Esports-Ltd/sentinal` is public (verified 2026-11-04: unauthenticated
`GET /repos/…/releases/latest` and the raw `install.sh` URL both return 200; release v1.46.0 has
the four `sentinal-<os>-<arch>` assets plus `checksums.txt`). `install.sh` becomes token-optional
(token → authenticated API asset download as today; no token → public `browser_download_url`) and
gains SHA-256 verification against `checksums.txt`. `update-github.ts` error text and
`pre-release.mjs --download` / `release-asset.ts` stop assuming a private repo. The README is then
corrected section by section against the code.

**Tech Stack:** POSIX `sh`, Bun/TypeScript (`bun:test`), Markdown.

## Scope

### In Scope

- `scripts/install.sh`: token optional, sha256 verification, comments/messages updated.
- `src/cli/commands/update-github.ts`: 401/403/404 messages no longer say "private repo".
- `scripts/pre-release.mjs` + `tests/e2e/harness/release-asset.ts`: `--download` works without a
  token (token still used when set).
- `README.md`: fix every verified-wrong claim (audit list in "Context for Implementer"), keeping
  structure and approximate length.

### Out of Scope

- Changing which MCP servers Claude Code registers, or the tool-redirect behaviour (README only
  documents reality).
- Restructuring/trimming the README; `CHANGELOG.md`; `targets/*` shipped docs/rules.
- Changing `update-download.ts` download logic (already token-optional; only its stale comment at
  :100 may be reworded).

## Context for Implementer

- **Repo is public.** Verify any time: `curl -fsSL https://api.github.com/repos/Endpoint-Esports-Ltd/sentinal/releases/latest | grep tag_name`.
- **checksums.txt format** (`sha256  name`, two spaces), e.g.
  `a5ee…cd5  sentinal-darwin-arm64`. Public URL:
  `https://github.com/Endpoint-Esports-Ltd/sentinal/releases/download/<tag>/checksums.txt`.
- **Pattern to mirror for install.sh:** `src/cli/commands/update-download.ts:100-103` — token →
  `asset.url` + `Accept: application/octet-stream`; no token → `browser_download_url`.
  `tests/e2e/harness/release-asset.ts:61` `parseChecksums` shows the checksum parsing rules.
- **install.sh must stay POSIX `sh`** (it runs as `curl … | sh`; no bash-isms). Hash tool:
  `sha256sum` (Linux) else `shasum -a 256` (macOS); if neither exists, die (do not silently skip).
  Download to a temp file, verify, then `mv` into `~/.sentinal/bin/sentinal` so a failed check
  never replaces a working binary.
- **Testing install.sh hermetically:** put a fake `curl` (and optionally `uname`) script first on
  `PATH`, set `HOME` to a temp dir, `SHELL=/bin/zsh`, run `sh scripts/install.sh`, and assert on
  exit code / files. The fake curl inspects its args (URL, `-H` headers, `-o` path) and serves
  canned JSON / bytes / checksums, and logs its argv to a file so the test can assert that **no
  `Authorization` header is sent when no token is set**. Use `Bun.spawn` / `spawnSync` with an
  explicit env (never inherit the developer's `GITHUB_TOKEN`). Test file location:
  `scripts/install.test.ts` (bun discovers `**/*.test.ts`). Give spawning tests an explicit
  timeout (3rd arg to `it`), per `.sentinal/rules/sentinal-testing.md`.
- **TDD guard** applies to `src/**` implementation files: write the failing test first, then set
  `RED_CONFIRMED` (`tdd_set_state`) before editing.
- **Formatting:** run `quality_report` with `file:` on each touched TS/MD file
  (`docs/**` is prettier-ignored; `README.md` is not — run `bunx prettier --write README.md`).
- **README audit (verified by exploration on 2026-11-04 — re-check each against code while
  editing; evidence file:line in parentheses):**
  - Quick Install (L9-25): token not needed; step 6 is wrong — `install.sh` does not provision
    deps; `sentinal install` does (`src/cli/commands/install.ts:123` → `runAutoSetup`).
  - Features (L48-61): TDD guard only active with an active /spec plan
    (`src/hooks/tdd-guard.ts:64-73`); dashboard is started by session-start hook / OpenCode plugin
    init, not by `sidecar start` (`hook.ts:47-56`, `sidecar.ts`); MCP servers: OpenCode configures
    all 5 globally, Claude Code registers only `sentinal` globally — context7/web-search/grep-mcp/
    web-fetch are on the plan-reviewer/spec-reviewer (and research, minus web-fetch) agents
    (`targets/claude-code/.mcp.json`, `targets/claude-code/agents/*.md` frontmatter); LSP: vtsls
    for Claude Code, `typescript-language-server` for OpenCode.
  - Requirements (L63-67): Bun is not required for the compiled binary (no Bun check in
    `install-claude.ts:75-100`; OpenCode checks Bun only in npm mode `install-opencode.ts:76-83`);
    Node ≥18 enforced for Claude Code; macOS/Linux x64/arm64 only; `bun` or `npm` needed for
    `memory setup` (`src/memory/setup.ts:5-11`), Homebrew SQLite on macOS for vector search.
  - CLI (L69-143): add `hook`, `worktree status|merge|cleanup|abandon-orphan|ensure`,
    `memory update|delete|decay|maintain`, global `--skip-update-check`, `sidecar start --port`,
    `uninstall --local`; `worktree diff`/`abandon` take a worktree **ID**; `--bundled` writes
    `plugins/sentinal.mjs` and is OpenCode/npm-mode only; `sidecar status` shows PID + transport
    (no port); `memory prune` default `90d`.
  - Installation (L160-189): Claude installer checks Node ≥18, `claude`, `sentinal` on PATH (no
    Bun), writes `statusLine` into `~/.claude/settings.json` (with `.bak`); OpenCode installer
    overwrites global `AGENTS.md`; `--local` writes `<cwd>/.opencode/`, `<cwd>/opencode.json`,
    appends `<cwd>/AGENTS.md`.
  - Updating (L202-227): no token needed (optional, raises the 60 req/h limit); SHA-256 vs
    `checksums.txt` + `--version` smoke test with rollback (`update-download.ts:133-165`);
    reinstall detects installed artifacts, OpenCode reinstalled globally (project-local installs
    not refreshed — `update-reinstall.ts:39,70-75`).
  - Semantic memory (L247-264): setup uses `bun add`/`npm install --prefix`; self-heal only for
    **missing** deps, only in compiled binaries, re-inits vectors in the running sidecar
    (`src/memory/self-heal.ts:9-12,104-109,144-146`); `SENTINAL_NO_AUTO_SETUP` also disables
    self-heal.
  - Project structure (L287-342): no `checkers/typescript`; MCP = 49 tools/8 domains; add
    `src/orca/`, `src/runtime/`, `src/git/`; dashboard `routes/` + `views/`; `hooks/dist/` is not
    what runs (hooks run via the `sentinal` binary); commands incl. `/pause`, `/quick` (+ CC
    `spec-*` phase commands); agents incl. CC `research`, OpenCode `spec-task`; rules = 5
    `standards-*` + other always-loaded rules per target (count them).
  - Sidecar (L360): also a 1 s budget for `/retire` (`src/sidecar/client.ts:44-72`).
  - CC hook table (L372-389): context-monitor thresholds 90/95% (`src/sessions/context-display.ts:45-57`);
    prompt-context injects spec state only; spec-stop-guard nudges on IN_PROGRESS/COMPLETE, soft
    by default, hard with `SENTINAL_STOP_GUARD_HARD=1`; session-end stops the dashboard only;
    file-checker `.ts`/`.tsx` only; tdd-tracker also on `PostToolUseFailure`; add
    PostToolUseFailure (tool-failure-observer), StopFailure, ConfigChange, InstructionsLoaded,
    CwdChanged, FileChanged, PostCompact, TaskCreated rows (`targets/claude-code/hooks/hooks.json`).
  - OpenCode table (L391-415): installed plugin is `plugins/sentinal.mjs` (bundle) or the npm
    export; `tool.execute.after` runs **no tsc**; add `experimental.chat.system.transform`,
    `message.part.updated`/`session.updated` events, `sentinal_tdd_status` native tool (verify
    line refs in `targets/opencode/plugins/sentinal.ts`). Runtime: say "OpenCode's plugin
    runtime; the plugin avoids Bun-only APIs (DB via sidecar)" — do NOT assert Node vs Bun.
    Sub-agents differ per target.
  - File edit flow (L417-428): `ng build --dry-run` is Claude Code only (`src/checkers/angular.ts:22`);
    companion-test check is file-checker PostToolUse; RED gate is the PreToolUse tdd-guard.
  - Framework detection (L434-438): framework by `angular.json`/`.angular.json`/`nest-cli.json`
    (`src/checkers/detect.ts:27-53`); `bun.lockb` too.
  - Coding standards (L465-509): path activation is Claude Code only (OpenCode rules always load);
    widen globs to match `targets/claude-code/rules/standards-*.md` frontmatter.
  - /spec (L534-539): PENDING → IN_PROGRESS → COMPLETE → VERIFIED; plan-reviewer runs in
    planning, spec-reviewer in verification.
  - Pre-release (L773): `:download` no longer needs a token (after Task 3).
  - Architecture/dev (L793-828): Memory = 9 MCP tools; Claude Code hooks run through the installed
    `sentinal` binary, so testing hook changes needs `bun run build:cli` + the new binary;
    checkers called from `src/hooks/file-checker.ts`.
  - Settings (L844-898): CC `env` also has `DISABLE_AUTO_COMPACT`; OpenCode plugin entry is
    `./plugins/sentinal.mjs` or `@endpoint/sentinal/opencode-plugin`; LSP written only on fresh
    config; `sentinal` MCP entry always overwritten; JSONC comments stripped (`.bak` kept);
    `permission`/`agent` merged and `.sentinal/rules/*.md` added to `instructions`
    (`src/cli/commands/install-opencode-config.ts`).

## Assumptions

- The repo stays public — verified by unauthenticated API/raw requests — Tasks 1-5.
- Unauthenticated `GET /repos/…/releases/assets/<id>` with `Accept: application/octet-stream`
  works for public repos (GitHub docs; redirects to a signed URL) — Task 3.
- `browser_download_url` and `releases/download/<tag>/checksums.txt` are public — verified by
  fetching checksums.txt — Task 1.
- The audit list is accurate; each item is re-verified against code before editing — Tasks 4, 5.

## Testing Strategy

- Unit: `scripts/install.test.ts` (fake curl on PATH): no-token path succeeds without an
  `Authorization` header and uses `browser_download_url`; token path sends the header and uses the
  API asset URL; checksum mismatch exits non-zero and leaves no binary at `~/.sentinal/bin/sentinal`.
- Unit: `update-github.test.ts` asserts the no-token 404 message does not mention "private";
  `release-asset.test.ts` asserts no `Authorization` header when token is absent.
- Manual: run the real `install.sh` with `HOME=$(mktemp -d)` and no token against GitHub;
  confirm `~/.sentinal/bin/sentinal --version` prints `1.46.0` (or latest).
- README: grep-based Truths below; `bunx prettier --check README.md`.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| install.sh bash-ism breaks `curl \| sh` on dash | Med | High | Test with `sh` (and `dash` if present); `sh -n` syntax check |
| Fake-curl test diverges from real curl args | Med | Med | Plus a manual live run in a temp HOME |
| Unauthenticated rate limit (60/h) hit in CI/tests | Low | Low | Unit tests are hermetic; token still honoured when set |
| README "fixes" introduce new inaccuracies | Med | Med | Re-verify each claim against code at edit time; spec-reviewer check |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **The grep-based JSON parsing in install.sh picks the wrong asset's URL** (Task 1) → Trigger:
   in the test fixture with multiple assets, the downloaded URL is not the one ending in
   `/sentinal-<os>-<arch>`.
2. **Checksum verification fails on macOS because `shasum` output/format differs** (Task 1) →
   Trigger: the live manual run in a temp HOME exits with a mismatch on a genuine binary.
3. **README edits drift from code because line refs in the audit were stale** (Tasks 4-5) →
   Trigger: an audit item's cited file:line does not contain the claimed behaviour when re-checked.

## Execution Waves

**Wave 1** — code fixes (parallel): Tasks 1, 2, 3 touch disjoint files.
**Wave 2** — README install/update sections (Task 4): documents Task 1-3 behaviour.
**Wave 3** — README remaining sections (Task 5): same file as Task 4, so sequential.

## Goal Verification

### Truths

1. `README.md` Quick Install contains `curl -fsSL https://raw.githubusercontent.com/Endpoint-Esports-Ltd/sentinal/main/scripts/install.sh | sh` and no `Authorization: token` / `repo` scope requirement (`grep -n "Authorization: token" README.md` → no hits).
2. `env -u GITHUB_TOKEN -u GH_TOKEN HOME=$(mktemp -d) sh scripts/install.sh` exits 0 and installs a binary whose `--version` matches the latest release.
3. `scripts/install.sh` contains `checksums.txt` and a `sha256sum`/`shasum -a 256` check; a mismatch exits non-zero (unit test).
4. `grep -rniE "private repo|requires GITHUB_TOKEN|needs GITHUB_TOKEN|repo' scope" scripts/install.sh scripts/pre-release.mjs src/cli/commands/update-github.ts tests/e2e/harness/release-asset.ts` → no hits (includes `pre-release.mjs:15` header comment).
5. `grep -n "28 tool\|6 MCP tools\|65/75/85\|checkers/typescript\|, tsc) " README.md` → no hits.
6. `bun test scripts/install.test.ts src/cli/commands/update-github.test.ts tests/e2e/harness/release-asset.test.ts` passes; `bunx prettier --check README.md` passes.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `scripts/install.sh` | Token-optional, checksum-verified installer | `curl … \| sh` entry |
| `scripts/install.test.ts` | Hermetic installer tests | — |
| `src/cli/commands/update-github.ts` | Public-repo-correct error text | `fetchLatestRelease` |
| `tests/e2e/harness/release-asset.ts` | Token-optional release download | `downloadReleaseAsset` |
| `scripts/pre-release.mjs` | `--download` without token | — |
| `README.md` | Accurate user docs | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `scripts/install.sh` | GitHub release | public download URL | `browser_download_url` |
| `scripts/install.sh` | `checksums.txt` | integrity check | `checksums\.txt` |
| `scripts/pre-release.mjs` | `release-asset.ts` | optional token | `downloadReleaseAsset` |
| `README.md` | `scripts/install.sh` | Quick Install | `scripts/install.sh \| sh` |

## Progress Tracking

- [x] Task 1: install.sh token-optional + sha256 verification + tests (Wave 1)
- [x] Task 2: update-github.ts public-repo error messages (Wave 1)
- [x] Task 3: pre-release --download / release-asset token-optional (Wave 1)
- [x] Task 4: README install, requirements, update, semantic-memory sections (Wave 2)
- [x] Task 5: README remaining sections (CLI, structure, hooks, OpenCode, MCP, standards, dev, settings) (Wave 3)

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: install.sh token-optional + sha256 verification

**Objective:** `curl … install.sh | sh` works with no token on a public repo, still uses a token
when set, and refuses a binary that fails SHA-256 verification.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `scripts/install.sh`
- Create: `scripts/install.test.ts`

**Key Decisions / Notes:**

- Token: `TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"`; never die when empty. Build curl auth args only
  when set (POSIX: use `set --` or an `if` around two curl invocations — no arrays).
- No token: parse `browser_download_url` ending in `/$ASSET_NAME"` and `/checksums.txt"` from the
  release JSON. Token: keep asset-id download via API with `Accept: application/octet-stream`
  (and fetch `checksums.txt` the same way).
- Download to `$BIN_DIR/.sentinal.download.$$`; register `trap 'rm -f "$TMP_BIN"' EXIT INT TERM`
  so a failed download or Ctrl-C never leaves it behind. Verify by **string comparison** — do NOT
  use `sha256sum -c`/`shasum -c` (they look up the asset's filename, not the temp file): extract
  the expected hash with `awk -v n="$ASSET_NAME" '$2==n {print $1}'` from `checksums.txt`,
  compute `sha256sum "$TMP_BIN"` or `shasum -a 256 "$TMP_BIN"` and take field 1, compare
  lowercased. Then `chmod +x` + `mv` over `$BIN_PATH`; on mismatch die (trap deletes temp).
  Missing entry or no hash tool → die with a clear message.
- **Stale token fallback:** if a token is set and the authenticated release fetch returns
  401/403, warn ("token rejected, retrying unauthenticated") and retry once without it, then use
  the public `browser_download_url` path.
- Never emit an empty header (`-H ''`) when no token is set.
- Update header comment / usage, error messages (no "repo scope"/"private"), mention optional
  token for rate limits.
- Pattern: `src/cli/commands/update-download.ts:100-103`.

**Definition of Done:**

- [ ] `sh -n scripts/install.sh` passes; script uses no bash-isms
- [ ] Test: no-token run exits 0, sends no `Authorization` header, downloads via `browser_download_url`
- [ ] Test: token run sends `Authorization: token …`
- [ ] Test: checksum mismatch exits non-zero, `~/.sentinal/bin/sentinal` is absent, and no
      `.sentinal.download.*` temp file remains
- [ ] Test: a rejected token (fake curl returns 401 for authenticated requests) falls back to the
      unauthenticated path and succeeds
- [ ] Fake curl fails the test on any empty `-H ''` argument; a fake `uname` pins the platform
      (e.g. Darwin/arm64) so the expected asset is host-independent
- [ ] **Manual only (not in the automated suite — network + 60 req/h limit):** live run in a temp
      HOME without token installs the latest release binary

**Verify:**

- `bun test scripts/install.test.ts`
- `env -u GITHUB_TOKEN -u GH_TOKEN HOME=$(mktemp -d) SHELL=/bin/zsh sh scripts/install.sh`

### Task 2: update-github.ts public-repo error messages

**Objective:** `sentinal update` error text stops telling users the repo is private / a token is required.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/update-github.ts` (messages at ~:95-110)
- Modify: `src/cli/commands/update-download.ts` (comment at :100 only)
- Test: `src/cli/commands/update-github.test.ts`

**Key Decisions / Notes:**

- `fetchLatestRelease(fetchFn)` already accepts an injectable fetch — test by stubbing a 404/403
  response and capturing `console.error` (spyOn). 403 without token → mention rate limit and that
  `GITHUB_TOKEN`/`GH_TOKEN` raises it; 404 → "no releases published yet"; with token 401/403 →
  token invalid/expired.

**Definition of Done:**

- [ ] New tests fail first, then pass
- [ ] No "private" in `update-github.ts` messages
- [ ] `quality_report` clean on both files

**Verify:**

- `bun test src/cli/commands/update-github.test.ts`

### Task 3: pre-release --download / release-asset token-optional

**Objective:** `bun run pre-release:download` works without a token; token used when set.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `tests/e2e/harness/release-asset.ts` (`token?: string`; only add `Authorization` when set; header comment)
- Modify: `scripts/pre-release.mjs` (drop the hard token requirement at ~:167-170; update the
  header comment at ~:15 that says `--download` needs GITHUB_TOKEN)
- Test: `tests/e2e/harness/release-asset.test.ts`

**Key Decisions / Notes:**

- Follow the existing monkeypatched-fetch test pattern in `release-asset.test.ts:124` to assert
  headers with and without a token.

**Definition of Done:**

- [ ] Test asserts no `Authorization` header when token absent, present when set
- [ ] `pre-release.mjs` no longer throws without a token
- [ ] `bun run typecheck` clean

**Verify:**

- `bun test tests/e2e/harness/release-asset.test.ts`

### Task 4: README — install, requirements, updating, semantic memory

**Objective:** Correct README L1-264: Quick Install (token-free curl, real installer steps incl.
checksum verification, optional token note), Supported Assistants, Features, Requirements,
Installation (Claude/OpenCode/both), Updating, Semantic Memory.
**Dependencies:** Tasks 1, 2, 3
**Wave:** 2

**Files:**

- Modify: `README.md`

**Key Decisions / Notes:**

- Use the audit items for these sections in "Context for Implementer"; re-verify each in code.
- Keep the macOS Gatekeeper note. Remove/adjust stale transition notes only if verifiably wrong.
- Mention pre-release `:download` token-optional (L773) here too, since it follows Task 3.

**Definition of Done:**

- [ ] Truth 1 holds
- [ ] Every audit item for L1-264 and L773 addressed
- [ ] `bunx prettier --check README.md` passes

**Verify:**

- `grep -n "Authorization: token\|repo. scope" README.md` (no hits)

### Task 5: README — remaining sections

**Objective:** Correct README L265-902: CLI list, project structure, sidecar, CC hook table,
OpenCode events/comparison, file edit flow, framework detection, coding standards, /spec, MCP
servers, architecture/dev, settings.
**Dependencies:** Task 4
**Wave:** 3

**Files:**

- Modify: `README.md`

**Key Decisions / Notes:**

- CLI block sits at L69-143 but is handled here (Task 4 leaves it untouched) to keep Task 4 focused.
- Count rule files / commands / agents with `ls` rather than trusting the audit numbers.
- Describe MCP config per target as-is (no code changes).

**Definition of Done:**

- [ ] Truth 5 holds
- [ ] Every remaining audit item addressed
- [ ] `bunx prettier --check README.md` passes

**Verify:**

- `grep -n "28 tool\|6 MCP tools\|65/75/85\|checkers/typescript" README.md` (no hits)

## Verification Notes

- spec-reviewer (1 should_fix, 3 suggestions) — fixed: README said the `research` agent lacks
  web-fetch (it has all four); 403-with-token messages in `update-github.ts` / `install.sh` now
  mention the rate limit too (new test); `release-asset.test.ts` header tests use `mkdtempSync`
  + cleanup. Not changed (by design, documented): checksums come from the same release, so they
  detect corruption/truncation, not a tampered release — same model as `sentinal update`.
- Live check: `env -u GITHUB_TOKEN -u GH_TOKEN HOME=$(mktemp -d) sh scripts/install.sh` installed
  v1.46.1 with checksum verified; no temp files left.
- Deviation: the plan cited v1.46.0; the latest release is now v1.46.1 (no impact).
