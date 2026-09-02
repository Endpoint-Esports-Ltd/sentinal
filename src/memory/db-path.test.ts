/**
 * Database / Sidecar Path Resolution Tests (Task 6b — H6)
 *
 * The `SENTINAL_HOME` seam: one env var redirects the whole `~/.sentinal`
 * tree (DB, sidecar socket/port/pid) so that test runs can never write into
 * the real user store — pollution was observed arriving both via direct
 * `new MemoryStore()` and via the LIVE sidecar socket.
 *
 * Also pins:
 *  - unset-var behaviour is byte-identical to the pre-seam paths
 *  - the AUTHORITATIVE guard: during any test run (bunfig preload active),
 *    every one of these paths resolves OUTSIDE `os.homedir()/.sentinal`
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { getDbPath } from "./db-path.js";
import {
  getSidecarSocketPath,
  getSidecarPortPath,
  getSidecarPidPath,
} from "../sidecar/paths.js";

const REAL_SENTINAL_DIR = join(homedir(), ".sentinal");

/** Every path the seam must control, resolved fresh at call time. */
function allPaths(): Record<string, string> {
  return {
    db: getDbPath(),
    socket: getSidecarSocketPath(),
    port: getSidecarPortPath(),
    pid: getSidecarPidPath(),
  };
}

describe("SENTINAL_HOME seam", () => {
  // The preload sets SENTINAL_HOME for the whole run — save/restore it so
  // env mutations here never leak into other test files.
  let savedHome: string | undefined;
  let scratchHome: string;

  beforeEach(() => {
    savedHome = process.env.SENTINAL_HOME;
    scratchHome = mkdtempSync(join(tmpdir(), "sentinal-home-seam-"));
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.SENTINAL_HOME;
    } else {
      process.env.SENTINAL_HOME = savedHome;
    }
    rmSync(scratchHome, { recursive: true, force: true });
  });

  it("getDbPath() resolves under SENTINAL_HOME when set", () => {
    process.env.SENTINAL_HOME = scratchHome;
    expect(getDbPath()).toBe(join(scratchHome, "memory.db"));
  });

  it("every sidecar path resolves under SENTINAL_HOME when set", () => {
    process.env.SENTINAL_HOME = scratchHome;
    expect(getSidecarSocketPath()).toBe(join(scratchHome, "sidecar.sock"));
    expect(getSidecarPortPath()).toBe(join(scratchHome, "sidecar.port"));
    expect(getSidecarPidPath()).toBe(join(scratchHome, "sidecar.pid"));
  });

  it("unset-var behaviour is byte-identical to the pre-seam paths", () => {
    delete process.env.SENTINAL_HOME;
    expect(getDbPath()).toBe(join(REAL_SENTINAL_DIR, "memory.db"));
    expect(getSidecarSocketPath()).toBe(
      join(REAL_SENTINAL_DIR, "sidecar.sock"),
    );
    expect(getSidecarPortPath()).toBe(join(REAL_SENTINAL_DIR, "sidecar.port"));
    expect(getSidecarPidPath()).toBe(join(REAL_SENTINAL_DIR, "sidecar.pid"));
  });

  it("re-reads the env var on every call (no module-load caching)", () => {
    process.env.SENTINAL_HOME = scratchHome;
    const first = getDbPath();
    const other = mkdtempSync(join(tmpdir(), "sentinal-home-seam-b-"));
    try {
      process.env.SENTINAL_HOME = other;
      expect(getDbPath()).toBe(join(other, "memory.db"));
      expect(getDbPath()).not.toBe(first);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("test-run isolation guard (AUTHORITATIVE — never write to the real store)", () => {
  // These tests deliberately do NOT touch process.env: they assert the state
  // the bunfig.toml preload established for this very run. If they fail, the
  // suite is pointed at the real user store — the exact H6 bug.

  it("the preload set SENTINAL_HOME to a directory outside ~/.sentinal", () => {
    const home = process.env.SENTINAL_HOME;
    expect(home).toBeDefined();
    expect(home!.length).toBeGreaterThan(0);
    expect(home).not.toBe(REAL_SENTINAL_DIR);
    expect(home!.startsWith(REAL_SENTINAL_DIR + sep)).toBe(false);
  });

  it("during a test run, no DB or sidecar path resolves under ~/.sentinal", () => {
    for (const [name, path] of Object.entries(allPaths())) {
      expect(
        path.startsWith(REAL_SENTINAL_DIR + sep),
        `${name} → ${path}`,
      ).toBe(false);
    }
  });
});
