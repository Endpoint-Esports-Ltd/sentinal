# OpenCode Plugin Writes `.sentinal/` to Filesystem Root Fix Plan

Created: 2026-04-09
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** When OpenCode is opened in a directory without a `.git/` folder, Sentinal's OpenCode plugin resolves `projectRoot` to `/` (filesystem root), then attempts to write `/.sentinal/compact-state.json` and `/.sentinal/event-buffer.json`. These writes fail with `EACCES: permission denied` because no user owns `/`.

**Trigger:** Launch OpenCode (`opencode`) in any directory where `worktree` or `directory` from OpenCode's plugin context resolves to the filesystem root (reproducible by running `opencode` from a directory with no git ancestor, depending on OpenCode's internal resolution).

**Root Cause:** `targets/opencode/plugins/sentinal.ts:285`:

```ts
const projectRoot = worktree || directory;
```

No sanitization, no writability check, no fallback chain. The plugin trusts OpenCode's `worktree`/`directory` values unconditionally. When OpenCode passes `/` (or an empty/falsy value), `projectRoot` becomes `/` and subsequent `join(projectRoot, ".sentinal", ...)` calls produce `/.sentinal/...`.

**Affected consumer sites in `targets/opencode/plugins/sentinal.ts`:**

- Line 656: `stateDir = join(projectRoot, ".sentinal")` (tool.execute.before handler)
- Line 839: `stDir = join(projectRoot, ".sentinal")` (session.created, writing compact-state)
- Line 876: `stateFile = join(projectRoot, ".sentinal", "compact-state.json")` (restore read)
- Line 950: `bufferPath = join(projectRoot, ".sentinal", "event-buffer.json")` (event buffer)

Plus `projectRoot` is passed to ~20+ sidecar/memory calls where it becomes the `projectPath` argument in the sidecar DB — polluting observation records with a `/` project path even when no write fails.

## Investigation

### Backward trace from symptom

1. User sees writes failing to `/.sentinal/compact-state.json`.
2. `targets/opencode/plugins/sentinal.ts:876` constructs that path via `join(projectRoot, ".sentinal", "compact-state.json")`.
3. `projectRoot` is defined once, at line 285: `const projectRoot = worktree || directory;`.
4. `worktree` and `directory` come straight from the OpenCode plugin `PluginInput` context (see `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:11-18`).
5. OpenCode's plugin API types declare both as non-optional `string`, but the SDK `Project` type (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:607`) marks `vcsDir` and `vcs` as **optional** — meaning a project CAN exist without git, and OpenCode's runtime must pick some value for `worktree` in that case.
6. Based on the user's reproducible bug report, OpenCode resolves `worktree` or `directory` to `/` when launched in a non-git directory.

### Working example for comparison

The Claude Code side has always handled this correctly. See `src/cli/commands/hook.ts:301-302`:

```ts
const gitRoot = await findGitRoot(input.cwd);
const searchDir = gitRoot ?? input.cwd;
// ... uses searchDir for .sentinal/ writes
```

And individual hooks `src/hooks/pre-compact.ts:20-21`, `src/hooks/post-compact-restore.ts:8-10`, `src/hooks/spec-stop-guard.ts:7` all use the same pattern. The OpenCode plugin never adopted this resolver — line 285 has been `worktree || directory` since the plugin was created.

### Comparison — differences between broken and working paths

| Aspect                  | Claude Code (`src/hooks/*.ts`)                               | OpenCode (`sentinal.ts:285`)                 |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Input                   | `input.cwd` (from stdin JSON)                                | `worktree` / `directory` (plugin context)    |
| Git resolution          | `findGitRoot(input.cwd)` via `git rev-parse --show-toplevel` | None                                         |
| Fallback when git fails | `?? input.cwd` (current dir)                                 | None                                         |
| Filesystem-root guard   | No, but `input.cwd` is never `/` in practice                 | None, and OpenCode CAN pass `/`              |
| Writability check       | No — writes just fail if broken                              | None                                         |
| Consumer sites          | 1 per hook (each hook is standalone)                         | 4 in single plugin file + many sidecar calls |

### Why the existing try/catch blocks don't save us

Two of the four consumer sites (lines 839 and 950) sit inside try/catch blocks that log and continue. But the initial `mkdirSync(stDir, { recursive: true })` at line 840 throws `EACCES` on `/` — the catch swallows it. The try/catch gives the _appearance_ of degradation, but the compact-state file never persists, and the user never sees a warning. Subsequent compactions silently lose memory context.

The other two sites are worse: line 656 is in `tool.execute.before` which runs on every tool call, so the plugin attempts and silently fails a write on every single edit; line 876 is a read (not a write) but uses the same broken `projectRoot` path.

### Why `src/project/context.ts:56` and `src/sidecar/observation-queue.ts:18` are unaffected

`RULES_GLOBS` in `src/project/context.ts:56` is for reading legacy rule paths (backward-compat), not writing. `QUEUE_DIR` in `src/sidecar/observation-queue.ts:18` uses `homedir()` — always the user's home, never project-relative. These stay untouched.

### Why a helper is the right factoring

The fix cannot go inline at line 285 cleanly because:

1. Writability checking (`accessSync(path, W_OK)`) requires importing `node:fs`.
2. Returning `null` + logging a warning is a complete state that should be tested in isolation.
3. The resolver should be pure (testable without spawning OpenCode) and inject its filesystem deps.

The plugin already uses `sentinal-helpers.ts` + `sentinal-helpers.test.ts` for exactly this kind of factored pure logic (see `getGrepHint`, `transitionTddState`). Adding `resolveProjectRoot()` follows the established pattern.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** OpenCode is launched in a directory where `worktree` and/or `directory` resolve to `/`, an empty string, a non-existent path, or a read-only path.

**Property P must hold:**

1. `resolveProjectRoot(worktree, directory)` returns `{ root: null, reason: "..." }`.
2. The OpenCode plugin logs a single warning via `client.app.log({ level: "warn", ... })` explaining that per-project state is disabled for this session.
3. No write is attempted to any `.sentinal/` path (no `mkdirSync`, no `writeFileSync`, no `readFileSync` on a `.sentinal/` path inside the unresolved project).
4. The session continues functioning — tool hooks still fire, sidecar queries still run (using a null/sentinel project path that the sidecar handles gracefully), but compact-state persistence is skipped for this session.
5. No uncaught errors reach OpenCode; the plugin initializes cleanly.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold** (i.e., OpenCode is launched in a normal project directory with either a git root or a writable working directory):

1. `resolveProjectRoot(worktree, directory)` returns `{ root: <the usual worktree or directory> }` — the exact same value the old code would have produced.
2. All four consumer sites (lines 656, 839, 876, 950) continue to write/read `.sentinal/compact-state.json` and `.sentinal/event-buffer.json` exactly as before.
3. All sidecar calls continue to pass the correct `projectRoot` as `projectPath`.
4. `bun test` existing suite continues to pass — no regressions.
5. `bun run build:opencode` continues to succeed.

## Fix Approach

**Files:** 3

1. `targets/opencode/plugins/sentinal-helpers.ts` — add `resolveProjectRoot()` pure function
2. `targets/opencode/plugins/sentinal-helpers.test.ts` — add unit tests for the helper
3. `targets/opencode/plugins/sentinal.ts` — replace line 285 with helper call; wrap all 4 consumer sites in `if (projectRoot)` guards

**Strategy:** Extract the resolver as a pure, dep-injected function in `sentinal-helpers.ts` so it can be tested without spawning OpenCode or relying on real filesystem state. The function takes `worktree` and `directory` as explicit inputs (with optional fs dep injection) and returns either the resolved path or `{ root: null, reason }`. The plugin's single call site uses the result to decide whether to skip per-project state writes for the session.

**`resolveProjectRoot()` specification:**

```ts
export interface ResolveProjectRootResult {
  root: string | null;
  reason?: string; // set when root is null, for logging
}

export function resolveProjectRoot(
  worktree: string | undefined,
  directory: string | undefined,
  opts?: {
    cwd?: () => string; // default: () => process.cwd()
    exists?: (p: string) => boolean; // default: existsSync
    isWritable?: (p: string) => boolean; // default: accessSync(p, W_OK) wrapper
  },
): ResolveProjectRootResult {
  const cwd = opts?.cwd ?? (() => process.cwd());
  const exists = opts?.exists ?? existsSync;
  const isWritable =
    opts?.isWritable ??
    ((p) => {
      try {
        accessSync(p, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });

  // Build candidate list in priority order
  const candidates: string[] = [];
  for (const c of [worktree, directory, cwd()]) {
    if (typeof c === "string" && c.length > 0 && !candidates.includes(c)) {
      candidates.push(c);
    }
  }

  for (const candidate of candidates) {
    // Reject filesystem root — can't create .sentinal there
    if (
      candidate === "/" ||
      candidate === "\\" ||
      /^[A-Z]:[\\/]?$/i.test(candidate)
    )
      continue;
    if (!exists(candidate)) continue;
    if (!isWritable(candidate)) continue;
    return { root: candidate };
  }

  return {
    root: null,
    reason:
      candidates.length === 0
        ? "No project root candidates provided (worktree, directory, and cwd all empty)"
        : `No writable project root found. Tried: ${candidates.join(", ")}`,
  };
}
```

**Plugin integration in `sentinal.ts`:**

```ts
const { root: projectRoot, reason: projectRootReason } = resolveProjectRoot(
  worktree,
  directory,
);
if (projectRoot === null) {
  // Log once and mark the session as "no project state"
  try {
    await client.app.log({
      body: {
        service: "sentinal",
        level: "warn",
        message: `[Sentinal] Per-project state disabled: ${projectRootReason}. Session will work, but compact-state and event-buffer will not persist.`,
      },
    });
  } catch {
    /* log unavailable */
  }
}
```

Then at each of the 4 consumer sites (lines 656, 839, 876, 950), add an early-skip guard:

```ts
if (projectRoot) {
  const stateDir = join(projectRoot, ".sentinal");
  mkdirSync(stateDir, { recursive: true });
  // ... existing logic
}
```

For sidecar calls that currently pass `projectRoot` (sessions, context restore, memory search, etc.), pass an empty string `""` when `projectRoot` is null — the sidecar already handles empty project paths as "session-scoped, no persistence" in several places. Alternatively, keep passing `projectRoot ?? ""` inline at each site. **Decision:** use `const projectRootForSidecar = projectRoot ?? ""` once, near the top, so sidecar calls stay readable.

**Type adjustment:** The local `projectRoot` variable changes type from `string` to `string | null`. TypeScript will flag every call site where it's passed as a non-nullable `string`, which helps find them all during implementation.

### Defense-in-depth layers

| Layer              | Purpose                                                     | Check                                                          |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Resolver (pure)    | Reject unusable candidates up front                         | Unit tests on `resolveProjectRoot` covering all fallback paths |
| Plugin integration | Short-circuit writes when no project root                   | Type system: `projectRoot: string \| null` forces guards       |
| Consumer sites     | Existing try/catch stays — now only wraps legitimate errors | Tests verify no write happens when root is null                |
| Warning log        | User visibility — no silent failures                        | Manual smoke test (OpenCode in `/tmp/no-git`)                  |

### What's explicitly NOT being fixed

- **OpenCode itself passing `/` as `worktree`:** That's upstream. Sentinal can't control it.
- **`src/project/context.ts:56` RULES_GLOBS:** Still `.claude/rules` / `.opencode/rules` for backward compat reading. Not related.
- **Claude Code hooks:** They already have the correct fallback pattern. No change.
- **Sidecar state in `~/.sentinal/`:** Uses `homedir()`, never project-relative. No change.
- **`resolveProjectRoot` returning cwd() as last resort always:** the helper's 3rd candidate IS `process.cwd()`, but it must still pass the writability check, so it won't paper over `cwd === "/"`.

## Progress

- [x] Task 1: Fix — write test for resolver + implement + wire into plugin
- [x] Task 2: Verify — full suite + tsc + build:opencode
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write unit tests for `resolveProjectRoot`, implement the function, then wire it into `sentinal.ts` replacing line 285 and guarding the 4 consumer sites.

**Files:**

- `targets/opencode/plugins/sentinal-helpers.test.ts` (modify — add `resolveProjectRoot` describe block)
- `targets/opencode/plugins/sentinal-helpers.ts` (modify — add `resolveProjectRoot` function)
- `targets/opencode/plugins/sentinal.ts` (modify — replace line 285 and add guards at lines 656, 839, 876, 950)

**TDD:**

1. **RED:** In `sentinal-helpers.test.ts`, add a `describe("resolveProjectRoot", ...)` block with the following cases using injected fs fakes:
   - `worktree="/repo", directory="/repo"` where `/repo` exists and is writable → returns `{ root: "/repo" }`
   - `worktree="/", directory="/"` with cwd stub returning `/` → returns `{ root: null, reason: /No writable.../ }`
   - `worktree="/", directory="/home/user/myproj"` where `/home/user/myproj` is writable → returns `{ root: "/home/user/myproj" }`
   - `worktree="", directory=""` with cwd stub returning `/home/user` writable → returns `{ root: "/home/user" }`
   - `worktree=undefined, directory=undefined` with cwd stub returning `""` → returns `{ root: null }`
   - `worktree="/readonly-path"` where exists=true but isWritable=false, directory writable → falls through to directory
   - `worktree="/no-exist"` where exists=false, directory writable → falls through to directory
   - Windows edge: `worktree="C:\\"`, directory=`"C:\\Users\\me\\proj"` → returns directory (reject drive-root)

   Run: `bun test targets/opencode/plugins/sentinal-helpers.test.ts` — MUST FAIL (function doesn't exist yet).

2. **GREEN:** Add `resolveProjectRoot` to `sentinal-helpers.ts` with the signature from the spec above. Import `existsSync`, `accessSync`, `constants` from `node:fs`. Run tests — MUST PASS.

3. **Wire into plugin:** In `sentinal.ts`:
   - Line 285: replace `const projectRoot = worktree || directory;` with:
     ```ts
     const { root: projectRoot, reason: projectRootReason } =
       resolveProjectRoot(worktree, directory);
     ```
   - Immediately after, add the warning log block (inside the outer async function, once the client is available — so probably deferred to just after sidecar connect, or logged synchronously via the `log` helper if client.app.log isn't ready yet).
   - At line 656 (tool.execute.before `stateDir`): wrap the `mkdirSync` + `writeFileSync` block in `if (projectRoot) { ... }`.
   - At line 839 (session.created compact-state write): wrap in `if (projectRoot) { ... }`.
   - At line 876 (session.created compact-state read): wrap in `if (projectRoot && existsSync(stateFile)) { ... }` — the existsSync check already exists, just add the projectRoot guard.
   - At line 950 (event-buffer write): wrap in `if (projectRoot) { ... }`.
   - For sidecar calls that take `projectRoot` as a non-nullable string (e.g. `sidecar.createSession({ projectPath: projectRoot, ... })`), either:
     (a) pass `projectRoot ?? ""` (simplest, lets sidecar handle empty), or
     (b) skip the sidecar call entirely when `projectRoot` is null.
     **Choice:** pass `projectRoot ?? ""` — existing sidecar handlers already tolerate empty project paths for ephemeral sessions.
   - TypeScript compiler will flag every remaining `projectRoot` usage that needs a guard or null-coalesce; fix each one the compiler complains about.

**Verify:**

```bash
bun test targets/opencode/plugins/sentinal-helpers.test.ts
bun run build:opencode    # must succeed
```

### Task 2: Verify

**Objective:** Full suite + tsc + opencode build + manual smoke test.

**Verify:**

```bash
bun test                        # full suite — no regressions
npx tsc --noEmit                # type check clean (ignoring preexisting rootDir errors unrelated to this change)
bun run build:opencode          # plugin bundle builds
```

**Manual smoke test:**

```bash
mkdir -p /tmp/sentinal-no-git-smoke && cd /tmp/sentinal-no-git-smoke
# Confirm no git ancestor
git rev-parse --show-toplevel 2>&1   # should error "not a git repository"
# Launch OpenCode — must NOT create /.sentinal or crash
opencode
```

Inside OpenCode:

1. Check the OpenCode log panel for a single `[Sentinal] Per-project state disabled: ...` warning.
2. Verify no file was created at `/.sentinal/compact-state.json` (`ls /.sentinal 2>&1` should say "No such file or directory").
3. Verify a file was not created at `/tmp/sentinal-no-git-smoke/.sentinal/compact-state.json` either (since cwd isn't a project either — though this depends on what OpenCode passes).
4. Run a tool (e.g. Edit a file) — the session continues normally, no errors in the OpenCode log.
5. Trigger compaction (or wait for auto-compaction) — no crash, warning still visible, session resumes.
