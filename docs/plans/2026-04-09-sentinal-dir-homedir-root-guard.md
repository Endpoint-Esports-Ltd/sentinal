# `SENTINAL_DIR` Writes to Filesystem Root When `HOME=/` Fix Plan

Created: 2026-04-09
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** `~/.config/opencode/plugins/sentinal.mjs:1792:7` throws `EACCES: permission denied, mkdir /.sentinal` on a remote machine running v1.27.1 (the fix from the previous bug `d1b3f29` is present).

**Trigger:** OpenCode is launched in an environment where `HOME=/` is set (or `HOME` is unset/empty, causing `os.homedir()` to return `/`). This is reproducible with `HOME=/ node -e "require('os').homedir()"` → `/`.

**Root Cause:** `targets/opencode/plugins/sentinal.ts:144`:
```ts
const SENTINAL_DIR = join(homedir(), ".sentinal");
```
`SENTINAL_DIR` is computed **once at module load time** using `homedir()`. When `HOME=/`, `homedir()` returns `/`, making `SENTINAL_DIR = "/.sentinal"`. Every subsequent call to `log()` hits:
```ts
if (!existsSync(SENTINAL_DIR)) mkdirSync(SENTINAL_DIR, { recursive: true });
```
— which attempts `mkdir /.sentinal` and fails with `EACCES`. This is separate from the `projectRoot` bug fixed in `d1b3f29` and was not covered by that fix.

**Affected sites in `sentinal.ts`:**
- Line 144: `SENTINAL_DIR = join(homedir(), ".sentinal")` — root constant computed at load time
- Line 150: `mkdirSync(SENTINAL_DIR, ...)` — inside `log()`, called constantly (unguarded)
- Lines 160, 172, 183, 314: `join(SENTINAL_DIR, ...)` — `autoStartProcess`, `stopProcess`, config reads — all produce bad paths but most have `existsSync` guards that silently bail; the `mkdirSync` in `log()` is the one that throws

**Also affected** (same root, same module):
- `src/sidecar/observation-queue.ts:18`: `QUEUE_DIR = join(homedir(), ".sentinal")` — same pattern, but the `writeQueue` call (`mkdirSync(dir, ...)`) only runs when there are queued observations to write, so it's a lower-priority site. The plugin calls `ObservationQueue.enqueue()` which only triggers `writeQueue` under load.

## Investigation

### Backward trace

1. User sees `mkdir /.sentinal` → EACCES at `sentinal.mjs:1792:7`.
2. Line 1792 in the CI-built v1.27.1 bundle (Linux x64) corresponds to the `mkdirSync(SENTINAL_DIR)` in `log()` — confirmed by comparing local bundle structure with source (`SENTINAL_DIR mkdirSync` is at line ~1454 in our local 2071-line bundle; CI build for a different platform produces a differently-sized bundle, consistent with line 1792 for the same construct).
3. `SENTINAL_DIR = join(homedir(), ".sentinal")` where `homedir()` uses `process.env.HOME` (Node.js `os.homedir()` behaviour: returns `process.env.HOME` on Unix if set, otherwise falls back to `passwd` entry).
4. When `HOME=/` or `HOME` is empty, `homedir()` returns `/`. Verified: `HOME=/ node -e "console.log(require('os').homedir())"` → `/`.
5. Previous fix (`d1b3f29`) only addressed `projectRoot` (the `worktree || directory` value from OpenCode context). `SENTINAL_DIR` is a **separate constant** computed from `homedir()`, untouched by that fix.

### Why v1.27.0 appeared not to have this

The `log()` function's `mkdirSync` is wrapped in a `try { ... } catch { /* non-fatal */ }` block. If `HOME=/` was also set when the earlier crash happened, the `EACCES` would have been **swallowed silently** — the user would see a different crash at the `projectRoot` sites (which were NOT in try/catch). Now that `projectRoot` writes are guarded, the `log()` crash has become the first unswallowed error.

Wait — re-reading line 150: the `mkdirSync` IS inside the `try { } catch {}` block of `log()`. So it should be swallowed. Let me re-examine:

```ts
function log(message: string): void {
  try {
    if (!existsSync(SENTINAL_DIR)) mkdirSync(SENTINAL_DIR, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `${ts} ${message}\n`);
  } catch {
    /* non-fatal — never crash the plugin for logging */
  }
}
```

The `log()` mkdirSync IS caught. So line 1792 is NOT `log()`.

### Re-investigation: what IS at line 1792?

The crash is at column 7 — `mkdirSync` call beginning. Our local bundle has `mkdirSync` at:
- Line 1297: `ObservationQueue.writeQueue` — inside `src/sidecar/observation-queue.ts` — NOT inside a try/catch in the plugin
- Line 1454: `log()` function — inside try/catch (swallowed)
- Line 1838: `if (projectRoot) { mkdirSync(stateDir)... }` — guarded ✓
- Line 1958: `if (projectRoot) { mkdirSync(stDir)... }` — guarded ✓

The CI-built Linux x64 bundle line numbers differ from our local macOS build. But the relative ordering is preserved. Line 1792 in a larger/smaller bundle most likely corresponds to `ObservationQueue.writeQueue`'s `mkdirSync` (line 1297 local) — which is **not** inside a try/catch and **not** guarded.

### Root cause (revised, high confidence)

**`src/sidecar/observation-queue.ts:57`**:
```ts
function writeQueue(entries: ObservationPayload[]): void {
  const queuePath = getQueuePath();
  const dir = dirname(queuePath);
  mkdirSync(dir, { recursive: true });   // ← UNGUARDED, no try/catch
  writeFileSync(queuePath, JSON.stringify(entries), "utf-8");
}
```
`getQueuePath()` returns `join(QUEUE_DIR, QUEUE_FILE)` where `QUEUE_DIR = join(homedir(), ".sentinal")`. When `HOME=/`, `QUEUE_DIR = "/.sentinal"` and `dir = "/.sentinal"` → `mkdirSync("/.sentinal")` → EACCES, uncaught.

`writeQueue` is called from `ObservationQueue.enqueue()`, which is called from the plugin's `tool.execute.after` handler when `analyzeEvent` returns a high-confidence observation. This runs after every tool call — the first tool call in the session after the `session.created` event triggers observation capture and hits `writeQueue`.

### Working example

`log()` already has the right pattern — it wraps `mkdirSync(SENTINAL_DIR)` in a try/catch. The fix for `writeQueue` follows the same pattern: wrap in try/catch, silently bail on EACCES.

### Why `existsSync` guards elsewhere don't help

`autoStartProcess`, `stopProcess`, and config reads all check `existsSync(path)` before proceeding. `writeQueue` does NOT — it unconditionally calls `mkdirSync` to ensure the directory exists, then writes. This is correct behaviour for a normal HOME but breaks when HOME=/`.

## Behavior Contract

### Fix Property (C => P)

**Condition C:** `HOME=/` (or otherwise unset/invalid), causing `homedir()` to return `/`, so `QUEUE_DIR = "/.sentinal"`.

**Property P:**
1. `ObservationQueue.writeQueue` catches the `EACCES` from `mkdirSync("/.sentinal")` and returns without writing.
2. The plugin's `tool.execute.after` handler continues normally — observation is silently dropped (same as the existing `ObservationQueue` cap behaviour for overflow).
3. No uncaught error propagates to OpenCode.

### Preservation Property (!C => unchanged)

**When `HOME` is valid** (normal case):
1. `writeQueue` behaves exactly as before — `mkdirSync` succeeds, queue file is written.
2. All `ObservationQueue` methods work identically.
3. Full test suite passes.

## Fix Approach

**Files:** 1
- `src/sidecar/observation-queue.ts` — wrap `mkdirSync` + `writeFileSync` in `writeQueue` in try/catch

**Strategy:** Wrap the `mkdirSync` + `writeFileSync` block in `writeQueue` in a try/catch that swallows EACCES (and any other fs error). The queue is a best-effort persistence layer — losing an observation is safer than crashing the plugin. The existing `readQueue` already has a try/catch for its `readFileSync`. `writeQueue` should match.

**Secondary hardening (same file):** `QUEUE_DIR` is computed at module load time using `homedir()`. Add a guard: if `QUEUE_DIR === "/" || QUEUE_DIR.length <= 1`, treat the queue as disabled and make `writeQueue` a no-op. This prevents the mkdirSync attempt entirely.

**Tests:** `src/sidecar/observation-queue.test.ts` — add a test that calls `ObservationQueue.enqueue()` with a fake HOME=/ scenario (inject bad `getQueuePath` result) and verifies no throw.

## Progress

- [x] Task 1: Fix — add try/catch to `writeQueue` + QUEUE_DIR guard + regression test
- [x] Task 2: Verify — full suite + tsc + build:opencode
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Wrap `writeQueue` in try/catch, add QUEUE_DIR root guard, add regression test.

**Files:**
- `src/sidecar/observation-queue.ts` (modify)
- `src/sidecar/observation-queue.test.ts` (modify — add regression test)

**TDD:**
1. **RED:** In `observation-queue.test.ts`, add a test that stubs `getQueuePath` to return `"/.sentinal/observations.json"` (or equivalent invalid path), calls `ObservationQueue.enqueue(payload, log)`, and asserts it does NOT throw.

   Run: `bun test src/sidecar/observation-queue.test.ts` — MUST FAIL (unguarded mkdirSync throws).

2. **GREEN:** In `observation-queue.ts`:
   - Add QUEUE_DIR root guard: if `homedir()` returns `/` (or length ≤ 1), `QUEUE_DIR` falls back to a temp path or `writeQueue` becomes a no-op.
   - Wrap the `mkdirSync` + `writeFileSync` block in `writeQueue` in try/catch (log the error via optional `log` param if available, swallow otherwise).

   Run tests — MUST PASS.

**Verify:**
```bash
bun test src/sidecar/observation-queue.test.ts
bun run build:opencode
```

### Task 2: Verify

**Objective:** Full suite + tsc + opencode build.

**Verify:**
```bash
bun test
bun run build:opencode
```
