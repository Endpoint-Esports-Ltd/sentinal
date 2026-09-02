/**
 * Sidecar Start Guard Tests (module seam)
 *
 * The start decision (M2a) and wx start lock (M2d) live in
 * lifecycle-start.ts (split from lifecycle.ts under the 400-line rule).
 * Behavioral coverage is in lifecycle.test.ts via the lifecycle.js
 * re-exports; this file pins the module seam itself.
 */

import { describe, it, expect, afterEach, mock, spyOn } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import * as pathsModule from "./paths.js";
import {
  assessSidecarStart,
  autoStartSidecarAsync,
  getSidecarStartLockPath,
  SIDECAR_BOOT_GRACE_MS,
  START_LOCK_STALE_MS,
} from "./lifecycle-start.js";

describe("lifecycle-start module seam", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    mock.restore();
  });

  it("exports the start guard API with sensible thresholds", () => {
    expect(typeof assessSidecarStart).toBe("function");
    expect(typeof autoStartSidecarAsync).toBe("function");
    expect(SIDECAR_BOOT_GRACE_MS).toBeGreaterThan(0);
    expect(START_LOCK_STALE_MS).toBeGreaterThan(0);
  });

  it("decides 'start' with no pidfile and derives the lock path from the pid dir", async () => {
    tmpDir = makeTmpDir();
    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(
      join(tmpDir, "sidecar.pid"),
    );
    const decision = await assessSidecarStart();
    expect(decision).toEqual({ action: "start", cleanedStale: false });
    expect(getSidecarStartLockPath()).toBe(join(tmpDir, "sidecar.start.lock"));
  });
});
