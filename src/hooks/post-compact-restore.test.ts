import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
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

/**
 * Task 11 — compact-state is a WORKSPACE write, never an identity key.
 *
 * `.sentinal/compact-state.json` is per-session-per-checkout. Resolving it
 * through `resolveProjectIdentity` would redirect every linked worktree at the
 * MAIN checkout's file, leaking one worktree's active plan into another.
 *
 * A real `git worktree` is required: a hand-made directory would let a
 * main-checkout resolver pass by accident.
 */
describe("post-compact-restore — worktree-local state file (Task 11)", () => {
  let tmpDir: string;

  /** Create a temp git repo with an initial commit. */
  function initRepo(dir: string): void {
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
      cwd: dir,
    });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# Test\n");
    Bun.spawnSync(["git", "add", "."], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir });
  }

  async function captureRestore(cwd: string): Promise<string> {
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
      await processPostCompactRestore(makeInput(cwd));
    } finally {
      stdoutSpy.mockRestore();
    }
    return writes.join("");
  }

  beforeEach(() => {
    // realpathSync pre-applied: on macOS /var symlinks to /private/var.
    tmpDir = realpathSync(makeTmpDir());
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("reads the WORKTREE's compact-state, not the main checkout's", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);

    const wtPath = join(tmpDir, "wt-a");
    Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature"], {
      cwd: repoDir,
    });

    // Both checkouts have state. Only the worktree's may be restored.
    writeState(repoDir, "/plans/MAIN-CHECKOUT.md");
    writeState(wtPath, "/plans/WORKTREE.md");

    const out = await captureRestore(wtPath);

    expect(out).toContain("/plans/WORKTREE.md");
    expect(out).not.toContain("/plans/MAIN-CHECKOUT.md");
  }, 30_000);

  it("resolves from a SUBDIRECTORY of the worktree to that worktree's root", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);

    const wtPath = join(tmpDir, "wt-b");
    Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature-b"], {
      cwd: repoDir,
    });
    const subDir = join(wtPath, "src", "deep");
    mkdirSync(subDir, { recursive: true });

    writeState(repoDir, "/plans/MAIN-CHECKOUT.md");
    writeState(wtPath, "/plans/WORKTREE.md");

    const out = await captureRestore(subDir);

    expect(out).toContain("/plans/WORKTREE.md");
    expect(out).not.toContain("/plans/MAIN-CHECKOUT.md");
  }, 30_000);

  it("stays silent when only the MAIN checkout has state (no cross-worktree leak)", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);

    const wtPath = join(tmpDir, "wt-c");
    Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature-c"], {
      cwd: repoDir,
    });

    writeState(repoDir, "/plans/MAIN-CHECKOUT.md");

    expect(await captureRestore(wtPath)).toBe("");
  }, 30_000);

  /**
   * The genuine RED for Task 11.
   *
   * `findGitRoot` returns `null` for a blank cwd, and the old
   * `join(gitRoot ?? input.cwd, ...)` then produced the RELATIVE path
   * `.sentinal/compact-state.json`, silently resolved against whatever
   * directory the hook process happened to be started in. That reads a
   * SUBDIRECTORY's state file instead of the checkout root's.
   *
   * `resolveWorkspaceRoot` guarantees a non-empty ABSOLUTE checkout root for
   * every degenerate input, which is exactly the hole this closes.
   */
  it("resolves an absolute checkout root even when input.cwd is blank", async () => {
    initRepo(tmpDir);
    const subDir = join(tmpDir, "packages", "app");
    mkdirSync(subDir, { recursive: true });

    writeState(tmpDir, "/plans/CHECKOUT-ROOT.md");
    writeState(subDir, "/plans/STRAY-SUBDIR.md");

    const origCwd = process.cwd();
    let out: string;
    try {
      process.chdir(subDir);
      out = await captureRestore("");
    } finally {
      process.chdir(origCwd);
    }

    expect(out).toContain("/plans/CHECKOUT-ROOT.md");
    expect(out).not.toContain("/plans/STRAY-SUBDIR.md");
  }, 30_000);
});
