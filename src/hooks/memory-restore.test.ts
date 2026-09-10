import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import type { HookInput } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";

const HOOK = join(import.meta.dir, "memory-restore.ts");

function makeInput(cwd: string): HookInput {
  return {
    session_id: "memory-restore-test",
    transcript_path: "",
    cwd,
    permission_mode: "default",
    hook_event_name: "SessionStart",
  };
}

describe("memory-restore — module-load guard (M10b)", () => {
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

  it("importing the module does NOT execute the hook (no DB created)", () => {
    // If main() runs at module load it opens a MemoryStore, creating
    // memory.db under SENTINAL_HOME. A bare import must not.
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
    expect(existsSync(join(homeDir, "memory.db"))).toBe(false);
  }, 30_000);
});

describe("processMemoryRestore (M10c)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("exports processMemoryRestore consumed by both entry points", async () => {
    const mod = await import("./memory-restore.js");
    expect(typeof mod.processMemoryRestore).toBe("function");
  });

  it("is sidecar-first: delegates restoreContext to a connected client (dispatcher behaviour)", async () => {
    const mockRestore = mock(async (_cwd: string, _q?: string) => ({
      hasMemory: false,
      markdown: "",
    }));
    const connectSpy = spyOn(SidecarClient, "connect").mockImplementation(
      async () => ({ restoreContext: mockRestore }) as unknown as SidecarClient,
    );
    try {
      const { processMemoryRestore } = await import("./memory-restore.js");
      await processMemoryRestore(makeInput(tmpDir));
      expect(mockRestore).toHaveBeenCalledTimes(1);
      expect(mockRestore.mock.calls[0]?.[0]).toBe(tmpDir);
    } finally {
      connectSpy.mockRestore();
    }
  }, 30_000);
});
