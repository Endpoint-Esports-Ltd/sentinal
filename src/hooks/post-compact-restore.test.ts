import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import type { HookInput } from "../utils/hook-output.js";

const HOOK = join(import.meta.dir, "post-compact-restore.ts");

function makeInput(cwd: string): HookInput {
  return {
    session_id: "post-compact-test",
    transcript_path: "",
    cwd,
    permission_mode: "default",
    hook_event_name: "SessionStart",
  };
}

function writeState(cwd: string, activePlan: string | null): void {
  mkdirSync(join(cwd, ".sentinal"), { recursive: true });
  writeFileSync(
    join(cwd, ".sentinal", "compact-state.json"),
    JSON.stringify({
      activePlan,
      memoryContext: null,
      timestamp: new Date().toISOString(),
      cwd,
    }),
  );
}

describe("post-compact-restore — module-load guard (M10b)", () => {
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

  it("importing the module does NOT execute the hook (no hint emitted)", () => {
    // If main() runs at module load it prints the restore hint for the
    // primed compact-state.json. A bare import must not.
    writeState(tmpDir, "/some/plan.md");
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
    expect(result.stdout.toString()).not.toContain(
      "Session restored after compaction",
    );
  }, 30_000);
});

describe("processPostCompactRestore (M10c)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("exports processPostCompactRestore consumed by both entry points", async () => {
    const mod = await import("./post-compact-restore.js");
    expect(typeof mod.processPostCompactRestore).toBe("function");
  });

  it("emits the restore hint including the active plan", async () => {
    writeState(tmpDir, "/some/plan.md");
    const writes: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const { processPostCompactRestore } =
        await import("./post-compact-restore.js");
      await processPostCompactRestore(makeInput(tmpDir));
    } finally {
      stdoutSpy.mockRestore();
    }
    const out = writes.join("");
    expect(out).toContain("Session restored after compaction");
    expect(out).toContain("/some/plan.md");
  }, 30_000);

  it("is a silent no-op when no compact-state exists", async () => {
    const writes: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const { processPostCompactRestore } =
        await import("./post-compact-restore.js");
      await processPostCompactRestore(makeInput(tmpDir));
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(writes.join("")).toBe("");
  }, 30_000);
});
