# Dev Tools Available on This Machine

Tools installed beyond the usual git/bun/node stack. Prefer these over generic alternatives where noted — they're faster, give better output, or surface information the built-in tools can't.

## Semantic Code Search — `vexor`

`vexor` is a Python-based semantic file search CLI installed via `uv tool install "vexor[local]"`. Running with a local offline embedding model (`intfloat/multilingual-e5-small`, 384-dim) — **no API keys required**, everything stays on-device.

**The sentinal repo has a full-project index already built.** It covers `.ts`, `.md`, `.json`, `.mjs`, `.sh`, `.toml` files — **4,164 chunks across 349 files**. Full index time ~3:46 on M-series CPU; subsequent runs are incremental (only changed files re-embedded, see `INCREMENTAL_CHANGE_THRESHOLD = 0.5` in vexor's `services/index_service.py`).

**Exclusions applied** (copy-paste this command to re-index cleanly):

```bash
vexor index --path . --mode auto \
  --exclude-pattern '**/embedded-assets.ts' \
  --exclude-pattern '**/bun.lock' \
  --exclude-pattern '**/CHANGELOG.md' \
  --exclude-pattern '**/node_modules/**' \
  --exclude-pattern '**/dist/**' \
  --exclude-pattern '**/*.map' \
  --exclude-pattern '**/*.d.ts' \
  --exclude-pattern '**/sentinal.js' \
  --exclude-pattern 'targets/opencode/tests/fixtures/**' \
  --exclude-pattern 'targets/opencode/tests/run-checks.js' \
  --exclude-pattern '**/*.plan-review.json' \
  --exclude-pattern '**/*.spec-review.json' \
  --exclude-pattern '**/compact-state.json' \
  --exclude-pattern '**/project-memory.json'
```

Why these exclusions: `embedded-assets.ts` is an auto-generated 11k-line file (would dominate search noise); `CHANGELOG.md` is semantic-release output (99 chunks of version history); `sentinal.js` + `.d.ts` + `.map` are compiled outputs of `sentinal.ts`; `targets/opencode/tests/fixtures/` are NestJS test fixtures, not sentinal source.

**⚠️ Use `**/` glob prefix, not bare paths.** `--exclude-pattern 'src/foo.ts'` silently fails to match. `--exclude-pattern '**/foo.ts'` works. This is a vexor quirk — confirmed 2026-04-08.

> Note: Sentinal ships a separate rule (`targets/*/rules/research-tools.md`) instructing **end users** to install vexor. That rule is for user projects; this rule covers the dev experience of working on sentinal itself (where the index is pre-built and follows the exclusions above).

### Why NOT CoreML/GPU on Apple Silicon

Vexor's local embedding backend only exposes `cuda=True/False`. `onnxruntime` ships with `CoreMLExecutionProvider` on ARM Macs, but benchmarks against `multilingual-e5-small` (2026-04-08) showed it's **~1.16x faster on embedding only**, and embedding is ~10% of total indexing time (the rest is tree-sitter parsing, chunking, SQLite inserts running in 4 parallel workers). **Net impact of a full CoreML patch: <1.5% speedup on a 4-minute index run.** Not worth the maintenance burden of patching `LocalEmbeddingBackend`. Stick with CPU.

### When to use it over `rg`

| Need                                                | Tool                                    |
| --------------------------------------------------- | --------------------------------------- |
| **Find code by what it does** (intent, concept)     | `vexor search "..."`                    |
| **Find exact string/regex** (identifier, API name)  | `rg`                                    |
| **Follow an import graph**                          | `rg` + LSP `references` tool            |
| **Discover where a feature lives** in an unfamiliar area | `vexor search` then `rg` to pin down |
| **Plan a refactor** across ~100+ files              | `vexor search` to find all candidates   |

**Rule of thumb:** if you can write the exact token, use `rg`. If you'd have to guess five variants, use `vexor`.

### Usage patterns

```bash
# One-shot search (default: top 5, current dir)
vexor search "sidecar unix socket retry with http fallback"

# Script-friendly TSV output for piping
vexor search "hook readStdin denyExit" --path . --top 10 --format porcelain

# Limit to specific extensions (creates a NEW cache key — prefer auto mode)
vexor search "nestjs guard pattern" --ext .ts --top 5

# Re-index after big changes (only re-embeds changed files)
vexor index --path .

# See all cached indexes and clear them
vexor config --show-index-all
vexor config --clear-index-all
```

### Gotchas

- **Cache keys include every flag.** `vexor search "x"` and `vexor search "x" --ext .ts` use different indexes. Keep flags consistent or you'll trigger a re-index (slow).
- **`code` mode is TS/JS/Python only.** Markdown falls back to `outline`, everything else to `full`. The repo is indexed with `--mode auto` which routes automatically — just let it pick.
- **Python 3.14 + Bun interop:** vexor itself is Python (installed under `~/.local/bin/vexor`), not a Bun tool. It won't show up in `package.json` or lockfiles.

## Rust Power Tools

All installed via Homebrew. Use the specific tool when you want its value-add; fall back to standard Unix tools otherwise.

### `fd` — Fast File Finder

Replaces `find`. Respects `.gitignore` by default. Much faster and with saner syntax.

```bash
# Find TS files modified recently (excludes tests)
fd -e ts -E '*.test.ts' . src/

# Find files over 400 lines (Sentinal's warn threshold)
fd -e ts -E '*.test.ts' . src/ --exec wc -l | awk '$1 >= 400' | sort -rn

# Find all MCP tool definition files
fd "mcp-tools" src/
```

### `bat` — Cat with Highlights

Replaces `cat` when you want syntax highlighting, line numbers, or git-integration markers. Do NOT use it in pipes unless you add `--paging=never`.

```bash
bat --paging=never src/sidecar/client.ts
bat --line-range 50:100 src/hooks/file-checker.ts
rg 'SidecarClient' --type ts -l | xargs bat --paging=never
```

### `hyperfine` — Command Benchmarking

Critical for Sentinal: the `sentinal-hook-architecture` skill notes Claude Code hooks cost ~50-200ms per invocation. Use `hyperfine` to **measure** before/after a change, with statistical confidence (warmup runs, median, stddev).

```bash
# Benchmark a hook cold-start vs warm sidecar
hyperfine --warmup 3 \
  'echo "{}" | sentinal hook shared pre-edit-guide'

# Compare two implementations
hyperfine --warmup 3 \
  -n "old" 'sentinal mcp-server --version' \
  -n "new" './dist/sentinal mcp-server --version'

# Export JSON for spreadsheet analysis
hyperfine --warmup 3 'vexor search "foo"' --export-json bench.json
```

### `tokei` — Line-of-Code Counter

More accurate than `cloc`, faster, language breakdown built in. Good for baseline metrics and CI.

```bash
tokei src/                                          # src/ only
tokei . --exclude node_modules --exclude dist       # whole repo
tokei . --output json                               # machine-readable
```

### `delta` — Pretty Git Diffs

Wired as this repo's local pager (`git config --local core.pager delta`). Just use `git diff`, `git log -p`, `git show` normally — output will be syntax-highlighted with line numbers and navigable hunks.

```bash
git diff                  # uses delta automatically in this repo
git log -p -3             # same
# To bypass delta once:
git --no-pager diff
```

### `tldr` (tealdeer) — Fast Command Reference

Cache is pre-populated. Use for quick syntax reminders without leaving the terminal.

```bash
tldr fd
tldr hyperfine
tldr vexor
```

### Other tools (less critical but available)

- `dust` — visual `du` alternative, useful for finding bloat: `dust -d 2 -X node_modules`
- `sd` — saner `sed`: `sd 'oldPattern' 'newPattern' src/**/*.ts`
- `eza` — modern `ls`: `eza --tree --level=2 --git`
- `zoxide` — smart `cd` (requires shell init, not wired by default)

## Tool Preference Hierarchy

When Claude Code or OpenCode needs to explore/edit this repo, prefer in this order:

1. **MCP tools** — `sentinal_memory_search`, `sentinal_project_context`, built-in semantic search over observations
2. **`vexor search`** — for semantic intent-based code discovery when MCP memory doesn't have what's needed
3. **`rg` (ripgrep)** — for exact string/regex matches
4. **`fd`** — for file discovery by name/glob
5. **`bat`** — for previewing found files with highlighting
6. **Built-in Read/Grep/Glob tools** — always available as fallback

## Installation Record

Installed 2026-04-08 via:

```bash
brew install uv fd bat hyperfine tokei git-delta dust sd eza zoxide tealdeer
uv tool install "vexor[local]"
vexor local --setup --model intfloat/multilingual-e5-small
```

Git config (repo-local only):

```bash
git config --local core.pager delta
git config --local interactive.diffFilter 'delta --color-only'
git config --local delta.navigate true
git config --local delta.line-numbers true
git config --local merge.conflictStyle zdiff3
git config --local diff.colorMoved default
```
