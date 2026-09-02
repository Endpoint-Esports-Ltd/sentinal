import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import type { HookInput } from "../utils/hook-output.js";
import * as lifecycleModule from "../sidecar/lifecycle.js";

const HOOK = join(import.meta.dir, "session-end.ts");

function makeInput(cwd: string): HookInput {
  return {
    session_id: "session-end-test",
    transcript_path: "",
    cwd,
    permission_mode: "default",
    hook_event_name: "SessionEnd",
  };
}

describe("session-end — module-load guard (M10b)", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    } catch {}
  });

  it("importing the module does NOT execute the hook (event buffer survives)", () => {
    // If main() runs at module load, it consumes stdin and deletes
    // .sentinal/event-buffer.json in input.cwd. A bare import must not.
    const bufferPath = join(tmpDir, ".sentinal", "event-buffer.json");
    mkdirSync(join(tmpDir, ".sentinal"), { recursive: true });
    writeFileSync(bufferPath, "{}");

    const input = JSON.stringify(makeInput(tmpDir));
    const result = Bun.spawnSync(
      [
        "bun",
        "-e",
        `await import(${JSON.stringify(HOOK)}); console.log("IMPORT_OK");`,
      ],
      {
        stdin: Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SENTINAL_HOME: homeDir },
      },
    );

    expect(result.stdout.toString()).toContain("IMPORT_OK");
    expect(existsSync(bufferPath)).toBe(true);
  }, 30_000);
});

describe("processSessionEnd (M10c)", () => {
  let tmpDir: string;
  let homeDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeDir = makeTmpDir();
    savedHome = process.env.SENTINAL_HOME;
    // Fresh SENTINAL_HOME → deterministic empty store (0 active sessions)
    // and an isolated sidecar pidfile location.
    process.env.SENTINAL_HOME = homeDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    } catch {}
  });

  it("exports processSessionEnd consumed by both entry points", async () => {
    const mod = await import("./session-end.js");
    expect(typeof mod.processSessionEnd).toBe("function");
  });

  it("cleans up the event buffer and completes without a sidecar", async () => {
    const { processSessionEnd } = await import("./session-end.js");
    const bufferPath = join(tmpDir, ".sentinal", "event-buffer.json");
    mkdirSync(join(tmpDir, ".sentinal"), { recursive: true });
    writeFileSync(bufferPath, "{}");

    await processSessionEnd(makeInput(tmpDir));

    expect(existsSync(bufferPath)).toBe(false);
  }, 30_000);

  it("no-ops cleanly on empty input (missing cwd must not throw)", async () => {
    // The dispatcher does not wrap processSessionEnd in a catch-all like the
    // standalone entry does — an empty `{}` hook input must resolve cleanly
    // through BOTH entry points (live-smoke contract).
    const { processSessionEnd } = await import("./session-end.js");
    await processSessionEnd({} as HookInput);
  }, 30_000);

  it("NEVER calls stopSidecarProcess — review-mandated carve-out (H1: the sidecar owns its own lifecycle)", async () => {
    // Even with ZERO active sessions (fresh SENTINAL_HOME store) — the exact
    // branch where the old dispatcher stopped the sidecar — the extracted
    // hook must not. Post-v1.36.2 H1 the sidecar shuts itself down
    // session-aware; a hook-side stop is redundant and racy with other
    // live sessions.
    const stopSpy = spyOn(lifecycleModule, "stopSidecarProcess");
    try {
      const { processSessionEnd } = await import("./session-end.js");
      await processSessionEnd(makeInput(tmpDir));
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      stopSpy.mockRestore();
    }
  }, 30_000);
});
