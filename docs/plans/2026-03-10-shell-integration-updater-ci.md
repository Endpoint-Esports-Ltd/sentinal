# Shell Integration + Auto-Updater + GitHub Actions CI/CD

Created: 2026-03-10
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: docs/plans/2026-03-09-market research-parity.md (Task 11)

## Summary

**Goal:** Add shell aliases/completions for the `sentinal` CLI, implement a binary-download auto-updater from GitHub Releases, and create a GitHub Actions CI/CD workflow that cross-compiles platform binaries on tag push.

**Architecture:**

- `sentinal completion bash|zsh|fish` outputs a shell script for tab-completions
- `sentinal shell-init` writes aliases, PATH, and completion eval to shell config files
- `sentinal update` downloads pre-built binaries from GitHub Releases to `~/.sentinal/bin/sentinal`
- `.github/workflows/release.yml` cross-compiles 4 platform binaries from a single runner via Bun's `--target` flag
- 24h update check cache stored in SQLite `settings` table

**Key Decisions:**

- Binary install location: `~/.sentinal/bin/sentinal`
- Update mechanism: Binary download from GitHub Releases (not git pull + rebuild)
- Cross-compilation: Single `ubuntu-latest` runner builds all 4 targets (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`)
- Completions: Roll-our-own (commander.js has no built-in support)
- Shell init markers: `# --- sentinal start ---` / `# --- sentinal end ---` for idempotent block management
- Version tag format: `vMAJOR.MINOR.PATCH` (e.g., `v1.0.9`). Pre-release tags excluded from comparison.
- GitHub repo: `Endpoint-Esports-Ltd/sentinal` (private)

## Implementation Tasks

### Task 1: Shell Completion Command

- [x] Create `src/cli/commands/completion.ts` — `sentinal completion bash|zsh|fish`
- [x] Introspect commander program to generate completion scripts
- [x] Bash: uses `complete -F`, Zsh: uses `compdef`, Fish: uses `complete -c`
- [x] Create `src/cli/commands/completion.test.ts`
- [x] Register in `src/cli/index.ts`

### Task 2: Shell Init Command

- [x] Create `src/cli/commands/shell-init.ts` — `sentinal shell-init`
- [x] Detect shell from `$SHELL` env var
- [x] Write to `~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`
- [x] Add: PATH export, `snt` alias, completion eval
- [x] Idempotent: marker-based block replacement (`# --- sentinal start ---` / `# --- sentinal end ---`)
- [x] Create `src/cli/commands/shell-init.test.ts`
- [x] Register in `src/cli/index.ts`

### Task 3: Semver Comparison Utility

- [x] Create `src/utils/semver.ts` — `parseSemver()`, `compareSemver()`, `isNewerVersion()`
- [x] Handle `vMAJOR.MINOR.PATCH` format, exclude pre-release tags
- [x] Create `src/utils/semver.test.ts`

### Task 4: Update Command

- [x] Create `src/cli/commands/update.ts` — `sentinal update [--check]`
- [x] `--check`: Fetch latest release from GitHub API, compare versions, print result
- [x] Default: Download platform-specific binary from release assets, replace `~/.sentinal/bin/sentinal`
- [x] Platform detection: `process.platform` + `process.arch` → asset name mapping
- [x] 24h check cache in SQLite settings (`last_update_check`, `latest_remote_version`)
- [x] Create `src/cli/commands/update.test.ts`
- [x] Register in `src/cli/index.ts`

### Task 5: Update Check on CLI Launch

- [x] Add non-blocking update check before `program.parse()` in `src/cli/index.ts`
- [x] Skip if running `sentinal update` itself
- [x] Skip if `--skip-update-check` global option is set
- [x] Skip if last check was <24h ago
- [x] Print one-line notice if newer version available

### Task 6: Installer Integration

- [x] Modify `src/cli/commands/install.ts` — call `shell-init` after successful install
- [x] Copy compiled binary to `~/.sentinal/bin/sentinal` if `dist/sentinal` exists

### Task 7: GitHub Actions Release Workflow

- [x] Create `.github/workflows/release.yml`
- [x] Trigger on `v*` tag push
- [x] Steps: checkout → setup Bun → install → test → cross-compile 4 binaries → create GitHub Release
- [x] Use `--target` for cross-compilation: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`
- [x] Use `--define __SENTINAL_VERSION__` for version injection
- [x] Attach all 4 binaries as release assets

### Task 8: Package.json Repository Field

- [x] Add `repository` field to `package.json`

### Task 9: Update Parent Plan

- [x] Mark Task 11 complete in parent plan

## Verify

```bash
bun test
sentinal completion bash | head -5
sentinal completion zsh | head -5
sentinal completion fish | head -5
sentinal shell-init --dry-run
sentinal update --check
sentinal --version
```
