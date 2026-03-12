# Sidecar Test Isolation Fix Plan

Created: 2026-03-12
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: Yes
Type: Bugfix

## Summary

**Symptom:** Two `withSidecarOrDirect` tests in `client.test.ts` fail when a real sidecar is running locally — they expect the "direct" fallback but instead get "from-sidecar".
**Trigger:** Developer has sentinal sidecar running (normal during development), then runs `bun test`.
**Root Cause:** `src/sidecar/client.ts:52-78` — `tryConnect()` reads global paths (`~/.sentinal/sidecar.sock` and `~/.sentinal/sidecar.port`) to discover a running sidecar. The `withSidecarOrDirect` tests at lines 254-269 call `connect()` without mocking these paths, so the live sidecar is found and the fallback is never taken.

## Investigation

- `lifecycle.test.ts` already solves this by mocking `getSidecarSocketPath`/`getSidecarPortPath` via `spyOn` on `./server.js` re-exports.
- `client.ts` imports paths from `./paths.js` directly, so the same mock pattern applies — spy on the `paths.js` module exports.
- The `SidecarClient` describe block (lines 25-250) is not affected because it creates its own test sidecar and uses `buildForTest()` to point at it directly, bypassing `connect()`.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** A live sidecar is running while tests execute
**Property P must hold:** `withSidecarOrDirect` tests use mocked paths pointing at an empty temp dir, so `connect()` returns `null` and the direct fallback is taken.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** No sidecar running (CI environment)
**Existing behavior preserved:** Tests pass as before — `connect()` returns `null` because no socket/port files exist.

## Fix Approach

**Files:** `src/sidecar/client.test.ts`
**Strategy:** In the `withSidecarOrDirect` describe block, add `beforeEach`/`afterEach` that mock the path getters from `./paths.js` to point at a temp directory (no socket or port file), following the exact pattern from `lifecycle.test.ts:42-45`. This ensures `connect()` cannot discover the live sidecar.
**Tests:** The existing 2 failing tests become the regression tests — they will pass once the mock is in place.

## Progress

- [x] Task 1: Fix
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Add path mocks to the `withSidecarOrDirect` describe block so `SidecarClient.connect()` is isolated from any running sidecar.
**Files:** `src/sidecar/client.test.ts`
**TDD:** Existing tests already fail (RED) → add mocks → verify they pass (GREEN)
**Verify:** `bun test src/sidecar/client.test.ts`

### Task 2: Verify

**Objective:** Full test suite passes, no regressions
**Verify:** `bun test --timeout 30000`
