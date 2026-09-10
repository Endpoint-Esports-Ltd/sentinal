import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import type { HookInput } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";

const HOOK = join(import.meta.dir, "pre-compact.ts");

function makeInput(cwd: string): HookInput {
  return {
    session_id: "pre-compact-test",
    transcript_path: "",
    cwd,
    permission_mode: "default",
    hook_event_name: "PreCompact",
  };
}

describe("pre-compact — module-load guard (M10b)", () => {
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

  it("importing the module does NOT execute the hook (no compact-state written)", () => {
    // If main() runs at module load it writes .sentinal/compact-state.json
    // in input.cwd. A bare import must not.
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
    expect(existsSync(join(tmpDir, ".sentinal", "compact-state.json"))).toBe(
      false,
    );
  }, 30_000);
});

describe("processPreCompact (M10c)", () => {
  let tmpDir: string;
  let homeDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeDir = makeTmpDir();
    savedHome = process.env.SENTINAL_HOME;
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

  it("exports processPreCompact consumed by both entry points", async () => {
    const mod = await import("./pre-compact.js");
    expect(typeof mod.processPreCompact).toBe("function");
  });

  it("writes compact-state.json without a sidecar (direct fallback)", async () => {
    const { processPreCompact } = await import("./pre-compact.js");
    await processPreCompact(makeInput(tmpDir));

    const statePath = join(tmpDir, ".sentinal", "compact-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.cwd).toBe(tmpDir);
    expect(state.activePlan).toBeNull();
  }, 30_000);

  it("bumps the session heartbeat via a connected sidecar (dispatcher behaviour)", async () => {
    const mockTouch = mock(async (_id: string) => {});
    const mockRestore = mock(async (_cwd: string, _q?: string) => ({
      hasMemory: false,
      markdown: "",
    }));
    const connectSpy = spyOn(SidecarClient, "connect").mockImplementation(
      async () =>
        ({
          touchSession: mockTouch,
          restoreContext: mockRestore,
        }) as unknown as SidecarClient,
    );
    try {
      const { processPreCompact } = await import("./pre-compact.js");
      await processPreCompact(makeInput(tmpDir));
      expect(mockTouch).toHaveBeenCalledWith("pre-compact-test");
      expect(mockRestore).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
    }
  }, 30_000);
});
