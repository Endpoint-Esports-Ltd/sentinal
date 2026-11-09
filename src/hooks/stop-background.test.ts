/**
 * stop-background — background-work awareness for the stop-guard.
 *
 * Contract: background work in flight means the stop is a yield (Claude Code
 * re-invokes the session when the task completes), so it suppresses the block
 * for every known ownership class — including the session's OWN in-progress
 * plan. Only an unknown ownership class still blocks (fail toward blocking).
 */

import { describe, it, expect } from "bun:test";
import {
  hasActiveBackgroundWork,
  shouldSuppressForBackground,
} from "./stop-background.js";
import type { HookInput } from "../utils/hook-output.js";

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    transcript_path: "",
    cwd: "/tmp",
    permission_mode: "auto",
    hook_event_name: "Stop",
    ...overrides,
  };
}

describe("hasActiveBackgroundWork", () => {
  it("returns true when background_tasks is a non-empty array", () => {
    expect(
      hasActiveBackgroundWork(input({ background_tasks: [{ id: "t" }] })),
    ).toBe(true);
  });

  it("returns true when session_crons is a non-empty array", () => {
    expect(
      hasActiveBackgroundWork(input({ session_crons: [{ id: "c" }] })),
    ).toBe(true);
  });

  it("returns false when both are empty arrays", () => {
    expect(
      hasActiveBackgroundWork(
        input({ background_tasks: [], session_crons: [] }),
      ),
    ).toBe(false);
  });

  it("returns false when both are absent", () => {
    expect(hasActiveBackgroundWork(input())).toBe(false);
  });

  it("returns false defensively when the field is not an array", () => {
    expect(
      hasActiveBackgroundWork(input({ background_tasks: "nope" as never })),
    ).toBe(false);
  });
});

describe("shouldSuppressForBackground", () => {
  it("suppresses a self-owned block when background work is present (the watcher loop)", () => {
    // The main thread waiting on a Monitor / background agent for its OWN plan
    // must be allowed to yield: the task notification brings it back. Nudging
    // here produced "Watching." → nudge → "Still watching." → nudge … per wait.
    expect(
      shouldSuppressForBackground({
        hasBackground: true,
        ownership: "self",
      }),
    ).toBe(true);
  });

  it("suppresses an orphaned block when background work is present", () => {
    expect(
      shouldSuppressForBackground({
        hasBackground: true,
        ownership: "orphaned",
      }),
    ).toBe(true);
  });

  it("suppresses a stale-owner block when background work is present", () => {
    expect(
      shouldSuppressForBackground({
        hasBackground: true,
        ownership: "stale-owner",
      }),
    ).toBe(true);
  });

  it("never suppresses when there is no background work", () => {
    expect(
      shouldSuppressForBackground({
        hasBackground: false,
        ownership: "orphaned",
      }),
    ).toBe(false);
  });

  it("does not suppress when ownership class is unknown/undefined (fail toward block)", () => {
    expect(
      shouldSuppressForBackground({
        hasBackground: true,
        ownership: undefined,
      }),
    ).toBe(false);
  });
});
