/**
 * stop-background — bounded background-work awareness for the stop-guard.
 *
 * RED phase: fails until src/hooks/stop-background.ts exists.
 *
 * Contract: background work may suppress a stop-guard block ONLY when the block
 * is a WEAKER class (orphaned / stale-owner). It must NEVER suppress a block on
 * the session's OWN in-progress plan (block class "self").
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
    expect(hasActiveBackgroundWork(input({ background_tasks: [{ id: "t" }] }))).toBe(true);
  });

  it("returns true when session_crons is a non-empty array", () => {
    expect(hasActiveBackgroundWork(input({ session_crons: [{ id: "c" }] }))).toBe(true);
  });

  it("returns false when both are empty arrays", () => {
    expect(
      hasActiveBackgroundWork(input({ background_tasks: [], session_crons: [] })),
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
  it("does NOT suppress a self-owned block even with background work", () => {
    // The critical safety rule: never abandon the session's OWN in-progress plan.
    expect(
      shouldSuppressForBackground({
        hasBackground: true,
        ownership: "self",
      }),
    ).toBe(false);
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
      shouldSuppressForBackground({ hasBackground: false, ownership: "orphaned" }),
    ).toBe(false);
  });

  it("does not suppress when ownership class is unknown/undefined (fail toward block)", () => {
    expect(
      shouldSuppressForBackground({ hasBackground: true, ownership: undefined }),
    ).toBe(false);
  });
});
