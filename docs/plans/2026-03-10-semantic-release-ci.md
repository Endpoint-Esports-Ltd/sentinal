# Automated Semantic Release Pipeline

Created: 2026-03-10
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Replace the manual tag-push release workflow with fully automated semantic versioning using `semantic-release`. On every push to `main`, the pipeline analyzes Conventional Commit messages, determines the next version, updates `package.json` and a `VERSION` file, generates/updates `CHANGELOG.md`, creates a git tag, cross-compiles 4 platform binaries with the new version baked in, publishes the package to the private npm registry at `npm.cloud.endpoint.gg`, and publishes a GitHub Release with binary artifacts.

**References:** market research Parity Plan Task 12 (installer improvements — skipping devcontainers). Existing release workflow at `.github/workflows/release.yml`.

**Architecture:** Single GitHub Actions workflow triggered on `push` to `main`. Uses `semantic-release` with plugins for changelog generation, npm/git asset management, and a custom `exec` plugin to compile binaries. The `VERSION` file mirrors `package.json` version for consumers that prefer a flat file.

## Scope

### In Scope
- Replace manual `v*` tag-push workflow with `semantic-release` on `main` push
- `semantic-release` configuration (`.releaserc.json`)
- `CHANGELOG.md` generation and maintenance
- `VERSION` file creation and update (mirrors `package.json`)
- Cross-compilation of 4 platform binaries with semantic version injected
- Publish `@endpoint/sentinal` to private npm registry (`npm.cloud.endpoint.gg`)
- GitHub Release with binary artifacts + checksums
- Conventional Commits enforcement documentation

### Out of Scope
- macOS code signing (users codesign locally after download)
- Commit linting CI (commitlint) — can be added later
- Branch protection rules — organizational decision

## Context for Implementer

> Write for an implementer who has never seen the codebase.

**Current state:**
- Release workflow at `.github/workflows/release.yml` triggers on `v*` tag push
- Version lives in `package.json` (`"version": "1.2.0"`) — injected at compile time via `--define __SENTINAL_VERSION__`
- No `VERSION` file exists
- No `CHANGELOG.md` exists
- Commits already follow Conventional Commits (`feat:`, `fix:`, `chore:`)
- Tags: mix of `1.0.x` (no `v` prefix) and `v1.1.x+` (with prefix)
- Repository: `git@github.com:Endpoint-Esports-Ltd/sentinal.git`
- CI runner: `ubuntu-latest` with Bun cross-compilation for 4 targets
- Updater (`src/cli/commands/update.ts`) fetches from GitHub Releases API, expects asset names: `sentinal-{os}-{arch}`
- Binary version is injected as `__SENTINAL_VERSION__` compile-time constant

**Patterns to follow:**
- `package.json` scripts use Bun exclusively (not npm)
- GitHub Actions use `oven-sh/setup-bun@v2` for Bun
- Binary compilation: `bun build --compile --target=bun-{os}-{arch} src/cli/index.ts --outfile dist/sentinal-{os}-{arch} --define __SENTINAL_VERSION__="'X.Y.Z'"`
- Checksums generated with `sha256sum`
- GitHub Release created via `softprops/action-gh-release@v2` (will be replaced by `@semantic-release/github`)

**Gotchas:**
- `semantic-release` runs on Node.js, not Bun — use `actions/setup-node` alongside `setup-bun`
- `semantic-release` expects `GITHUB_TOKEN` for creating releases and pushing back to the repo
- `@semantic-release/npm` publishes to the private registry defined in `package.json` `publishConfig.registry` (`https://npm.cloud.endpoint.gg/`). Requires an `NPM_TOKEN` secret in the GitHub repo with write access to the private registry. The token is set via the `NPM_TOKEN` env var, which semantic-release uses to create a temporary `.npmrc` with auth.
- The `@semantic-release/exec` plugin runs shell commands for binary compilation
- `semantic-release` must push the version bump commit back to `main` — requires `contents: write` permission
- The `VERSION` file update must happen BEFORE binary compilation (so the version is available)
- Asset names must match what `src/cli/commands/update.ts:getAssetName()` expects
- The `[skip ci]` marker in the release commit message prevents infinite loops

## Progress Tracking

- [x] Task 1: Install and configure semantic-release
- [x] Task 2: Replace release workflow
- [x] Task 3: Create VERSION file and CHANGELOG.md
- [x] Task 4: Add release build script
- [x] Task 5: Verify and test

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: Install and Configure semantic-release

**Objective:** Add `semantic-release` and required plugins as dev dependencies, create `.releaserc.json` configuration.

**Dependencies:** None

**Files:**
- Modify: `package.json` — Add devDependencies
- Create: `.releaserc.json` — semantic-release configuration

**Key Decisions / Notes:**
- Install as devDependencies (not needed at runtime):
  - `semantic-release`
  - `@semantic-release/changelog` — generates/updates CHANGELOG.md
  - `@semantic-release/git` — commits version bump + changelog back to repo
  - `@semantic-release/exec` — runs shell commands for binary compilation
- Note: `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator`, `@semantic-release/npm`, and `@semantic-release/github` are included with `semantic-release` by default
- Configuration in `.releaserc.json`:
  ```json
  {
    "branches": ["main"],
    "tagFormat": "v${version}",
    "plugins": [
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      ["@semantic-release/exec", {
        "prepareCmd": "echo ${nextRelease.version} > VERSION && node scripts/release-build.mjs ${nextRelease.version}"
      }],
      "@semantic-release/npm",
      ["@semantic-release/git", {
        "assets": ["package.json", "VERSION", "CHANGELOG.md"],
        "message": "chore(release): v${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }],
      ["@semantic-release/github", {
        "assets": [
          {"path": "dist/sentinal-linux-x64", "label": "sentinal-linux-x64"},
          {"path": "dist/sentinal-linux-arm64", "label": "sentinal-linux-arm64"},
          {"path": "dist/sentinal-darwin-x64", "label": "sentinal-darwin-x64"},
          {"path": "dist/sentinal-darwin-arm64", "label": "sentinal-darwin-arm64"},
          {"path": "dist/checksums.txt", "label": "checksums.txt"}
        ]
      }]
    ]
  }
  ```
- Plugin execution order matters:
  1. `commit-analyzer` — determines release type from commits (feat=minor, fix=patch)
  2. `release-notes-generator` — generates release notes from commits
  3. `changelog` — writes/updates CHANGELOG.md
  4. `exec` — writes VERSION file + compiles binaries (prepare phase)
  5. `npm` — updates package.json version AND publishes to private registry (`npm.cloud.endpoint.gg` per `publishConfig`)
  6. `git` — commits package.json + VERSION + CHANGELOG.md back to main
  7. `github` — creates GitHub Release with binary assets

**Definition of Done:**
- [ ] devDependencies added to `package.json`
- [ ] `.releaserc.json` created with correct plugin chain
- [ ] `bun install` succeeds

**Verify:**
```bash
bun install && cat .releaserc.json
```

---

### Task 2: Replace Release Workflow

**Objective:** Replace the existing `.github/workflows/release.yml` (tag-push trigger) with a new workflow triggered on push to `main` that runs `semantic-release`.

**Dependencies:** Task 1

**Files:**
- Modify: `.github/workflows/release.yml` — Replace entirely

**Key Decisions / Notes:**
- Trigger: `push` to `main` branch (replaces `v*` tag trigger)
- Two jobs:
  1. `test` — Run `bun test` (gate)
  2. `release` — Run `semantic-release` (needs test to pass)
- `semantic-release` handles everything: version bump, tag, changelog, binary compilation (via exec plugin), GitHub Release
- Needs both `actions/setup-node@v4` (for semantic-release) and `oven-sh/setup-bun@v2` (for compilation)
- `fetch-depth: 0` required for full git history (commit analysis)
- Workflow structure:
  ```yaml
  name: Release
  
  on:
    push:
      branches: [main]
  
  permissions:
    contents: write
    issues: write
    pull-requests: write
  
  jobs:
    test:
      name: Test
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: latest }
        - run: bun install
        - run: bun test
  
    release:
      name: Release
      needs: test
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with:
            fetch-depth: 0
        - uses: actions/setup-node@v4
          with: { node-version: 22 }
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: latest }
        - run: bun install
        - name: Run semantic-release
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          run: npx semantic-release
  ```

- `NPM_TOKEN` must be added as a repository secret in GitHub Settings > Secrets > Actions. This is an auth token for `https://npm.cloud.endpoint.gg/` with publish rights to `@endpoint/sentinal`. semantic-release uses it to create a temporary `.npmrc` for authentication during `npm publish`.

**Definition of Done:**
- [ ] `.github/workflows/release.yml` replaced with semantic-release workflow
- [ ] Workflow triggers on push to main (not tag push)
- [ ] Test job gates the release job
- [ ] Both Node.js and Bun available in release job
- [ ] `NPM_TOKEN` secret documented as a prerequisite

**Verify:**
```bash
cat .github/workflows/release.yml  # verify trigger is push to main
```

---

### Task 3: Create VERSION File and CHANGELOG.md

**Objective:** Create initial `VERSION` file and `CHANGELOG.md` so semantic-release has files to update on first run.

**Dependencies:** None

**Files:**
- Create: `VERSION` — Contains current version string
- Create: `CHANGELOG.md` — Initial changelog header

**Key Decisions / Notes:**
- `VERSION` file: plain text, single line, no `v` prefix, no trailing newline: `1.2.0`
- `CHANGELOG.md`: minimal header — `@semantic-release/changelog` will prepend entries below it
- Both files must be committed and tracked in git (not gitignored)

**Definition of Done:**
- [ ] `VERSION` file exists with current version `1.2.0`
- [ ] `CHANGELOG.md` exists with header
- [ ] Both files committed to repo

**Verify:**
```bash
cat VERSION && echo "" && head -5 CHANGELOG.md
```

---

### Task 4: Add Release Build Script

**Objective:** Create a `scripts/release-build.mjs` script that semantic-release's exec plugin calls to cross-compile all 4 platform binaries with the new version injected.

**Dependencies:** Task 1

**Files:**
- Create: `scripts/release-build.mjs` — Cross-compilation script
- Modify: `package.json` — Add `release:build` script (optional convenience alias)

**Key Decisions / Notes:**
- Script accepts version as first argument: `node scripts/release-build.mjs 1.3.0`
- Uses Node.js `child_process.execSync` (runs in Node.js context from semantic-release)
- Cross-compiles 4 targets using `bun build --compile --target=bun-{os}-{arch}`
- Generates `dist/checksums.txt` via `sha256sum`
- Creates `dist/` directory if it doesn't exist
- Script must be executable and use `#!/usr/bin/env node` shebang
- The exec plugin `prepareCmd` in `.releaserc.json` calls this:
  `echo ${nextRelease.version} > VERSION && node scripts/release-build.mjs ${nextRelease.version}`

**Definition of Done:**
- [ ] `scripts/release-build.mjs` created
- [ ] Script cross-compiles 4 binaries with version injected
- [ ] Script generates checksums.txt
- [ ] Local test: `node scripts/release-build.mjs 99.0.0-test` produces 4 binaries

**Verify:**
```bash
node scripts/release-build.mjs 99.0.0-test && ls -la dist/sentinal-* && cat dist/checksums.txt
```

---

### Task 5: Verify and Test

**Objective:** End-to-end verification that the pipeline configuration is correct and all existing tests still pass.

**Dependencies:** Tasks 1-4

**Files:** None (verification only)

**Key Decisions / Notes:**
- Verification steps:
  1. `npx semantic-release --dry-run --no-ci` — should show next version and planned actions
  2. `node scripts/release-build.mjs 99.0.0-test` — should produce 4 binaries
  3. `cat dist/checksums.txt` — should list 4 checksums
  4. `bun test` — all existing tests still pass
  5. Verify asset names in `.releaserc.json` match `src/cli/commands/update.ts:getAssetName()` expectations
  6. Verify `[skip ci]` in git commit message template prevents infinite loops
  7. Verify `tagFormat: "v${version}"` matches existing tag convention

**Definition of Done:**
- [ ] Dry run succeeds (or shows expected errors for missing GITHUB_TOKEN locally)
- [ ] 4 platform binaries compile with injected version
- [ ] Checksums generated
- [ ] All existing tests pass
- [ ] No breaking changes to update command's asset name expectations (`sentinal-{os}-{arch}`)

**Verify:**
```bash
npx semantic-release --dry-run --no-ci 2>&1 | tail -20
bun test
```

---

## Assumptions

- `GITHUB_TOKEN` (automatically provided by GitHub Actions) has sufficient permissions to push commits back to `main` and create releases — this is the default for `contents: write` permission
- `NPM_TOKEN` secret is configured in the GitHub repository with write access to `https://npm.cloud.endpoint.gg/` for the `@endpoint` scope. This must be set up manually before the first release.
- Conventional Commits format will continue to be followed — if not, `semantic-release` simply skips the release (safe no-op)
- Node.js and Bun can coexist in the same GitHub Actions job — both are just binary tools on PATH
- The `[skip ci]` marker in the release commit message prevents the version bump commit from triggering another release cycle
- Old tags without `v` prefix (1.0.5-1.0.9) won't confuse semantic-release since `tagFormat` requires the `v` prefix

## Testing Strategy

- **Local dry run:** `npx semantic-release --dry-run --no-ci` validates the plugin chain without making changes
- **Build verification:** `node scripts/release-build.mjs <version>` produces correct binaries locally
- **Integration:** First real push to `main` after setup triggers a release (ensure at least one `feat:` or `fix:` commit)
- **Regression:** All existing `bun test` tests continue passing

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `GITHUB_TOKEN` can't push to `main` (branch protection) | Medium | High | Use a PAT secret or adjust branch protection to allow GitHub Actions |
| Infinite CI loop (release commit triggers another run) | Low | Medium | `[skip ci]` in commit message; semantic-release handles this natively |
| semantic-release misreads old tags without `v` prefix | Low | Low | Only tags matching `v${version}` are considered — older tags ignored |
| Bun cross-compilation fails in CI | Low | High | Already proven working in current release.yml |
| semantic-release and Bun lockfile conflict | Low | Low | Both use `bun install`; semantic-release plugins are Node.js-only |
| `NPM_TOKEN` not set or expired | Medium | Medium | Release will succeed (GitHub Release created) but npm publish step fails. Fix: update the secret in GitHub repo settings |
| Private registry unreachable from CI | Low | Medium | npm publish fails but GitHub Release still created. Can re-publish manually with `npm publish` |
