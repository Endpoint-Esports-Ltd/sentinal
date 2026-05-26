/**
 * PostCompact Hook Tests
 *
 * Tests the PostCompact hook that verifies compacted context was restored
 * correctly after compaction by reading compact-state.json.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { processPostCompact } from "./post-compact.js";
import type { HookInput } from "../utils/hook-output.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(cwd: string): HookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/transcript.json",
    cwd,
    permission_mode: "default",
    hook_event_name: "PostCompact",
  };
}

function writeCompactState(dir: string, state: unknown): void {
  const sentinalDir = join(dir, ".sentinal");
  mkdirSync(sentinalDir, { recursive: true });
  writeFileSync(
    join(sentinalDir, "compact-state.json"),
    JSON.stringify(state, null, 2),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("processPostCompact", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("post-compact-test");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should return message with plan basename when compact-state.json has activePlan", async () => {
    writeCompactState(tmpDir, {
      activePlan: "/path/to/docs/plans/2026-04-20-my-feature.md",
      memoryContext: "some memory",
      timestamp: new Date().toISOString(),
      cwd: tmpDir,
    });

    const result = await processPostCompact(makeInput(tmpDir));

    expect(result).not.toBeNull();
    expect(result).toContain("Context compacted.");
    expect(result).toContain("2026-04-20-my-feature.md");
    expect(result).toContain("/spec");
  });

  it("should return 'No active plan found' message when compact-state.json is missing", async () => {
    // No .sentinal dir or compact-state.json written
    const result = await processPostCompact(makeInput(tmpDir));

    expect(result).not.toBeNull();
    expect(result).toContain("Context compacted.");
    expect(result).toContain("No active plan found");
  });

  it("should return 'No active plan found' gracefully when compact-state.json has invalid JSON", async () => {
    const sentinalDir = join(tmpDir, ".sentinal");
    mkdirSync(sentinalDir, { recursive: true });
    writeFileSync(join(sentinalDir, "compact-state.json"), "{ invalid json !!!");

    const result = await processPostCompact(makeInput(tmpDir));

    expect(result).not.toBeNull();
    expect(result).toContain("Context compacted.");
    expect(result).toContain("No active plan found");
  });
});
