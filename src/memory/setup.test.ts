/**
 * Memory Setup Tests
 *
 * Tests `sentinal memory setup` provisioning of ~/.sentinal/deps:
 * spawner selection (bun preferred, npm fallback), version pinning from the
 * root package.json, success/failure reporting, and the darwin Homebrew note.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SETUP_HINT } from "./native-deps.js";
import type { NativeDepsStatus } from "./native-deps.js";
import { readPinnedVersions, runMemorySetup } from "./setup.js";
import { runSetupCommand } from "./cli.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const okStatus: NativeDepsStatus = {
  transformers: true,
  sqliteVec: true,
  hint: null,
  errors: [],
};

const missingStatus: NativeDepsStatus = {
  transformers: false,
  sqliteVec: false,
  hint: SETUP_HINT,
  errors: ["transformers bare import: Cannot find module"],
};

interface SpawnCall {
  cmd: string[];
  cwd: string;
}

function recordingSpawner(opts: {
  calls: SpawnCall[];
  /** Commands (argv[0]) that throw on spawn (simulates ENOENT). */
  missing?: string[];
  /** Exit code returned for successful spawns. */
  exitCode?: number;
}) {
  return (cmd: string[], cwd: string): number => {
    if (opts.missing?.includes(cmd[0]!)) {
      throw new Error(`spawn ${cmd[0]} ENOENT`);
    }
    opts.calls.push({ cmd, cwd });
    return opts.exitCode ?? 0;
  };
}

describe("memory setup", () => {
  let depsDir: string;

  beforeEach(() => {
    depsDir = mkdtempSync(join(tmpdir(), "sentinal-setup-"));
  });

  afterEach(() => {
    rmSync(depsDir, { recursive: true, force: true });
    // Bun gotcha: `process.exitCode = undefined` does NOT clear a previously
    // set exit code (unlike Node) — assign 0 or the whole `bun test` run
    // exits 1 despite all tests passing (broke CI for e4927d5/01d1507).
    process.exitCode = 0;
  });

  describe("readPinnedVersions", () => {
    it("should read sqlite-vec and @xenova/transformers versions from the root package.json", () => {
      const rootPkg = JSON.parse(
        readFileSync(
          join(import.meta.dir, "..", "..", "package.json"),
          "utf-8",
        ),
      ) as { dependencies: Record<string, string> };

      const versions = readPinnedVersions();
      expect(versions.sqliteVec).toBe(rootPkg.dependencies["sqlite-vec"]!);
      expect(versions.transformers).toBe(
        rootPkg.dependencies["@xenova/transformers"]!,
      );
    });
  });

  describe("runMemorySetup — fast no-op, lock, and bundling", () => {
    it("should fast no-op without spawning when deps resolve and the bundle is fresh", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
        bundleFreshFn: () => true,
      });

      expect(result.ok).toBe(true);
      expect(result.report).toContain("Already provisioned");
      expect(calls).toHaveLength(0);
    });

    it("should skip when another setup holds a live lock", async () => {
      const calls: SpawnCall[] = [];
      writeFileSync(
        join(depsDir, ".setup.lock"),
        JSON.stringify({ pid: process.pid, time: Date.now() }),
      );

      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => missingStatus,
        bundleFreshFn: () => false,
      });

      expect(result.ok).toBe(false);
      expect(result.report).toContain("already running");
      expect(calls).toHaveLength(0);
    });

    it("should ignore a stale lock (older than 10 minutes)", async () => {
      const calls: SpawnCall[] = [];
      writeFileSync(
        join(depsDir, ".setup.lock"),
        JSON.stringify({
          pid: 999999,
          time: Date.now() - 11 * 60 * 1000,
        }),
      );

      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
        bundleFreshFn: () => false,
        bundleBuilder: async () => ({
          ok: true,
          bundler: "bun" as const,
          report: ["Bundled (test)"],
        }),
      });

      expect(result.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(0); // install ran despite stale lock
    });

    it("should release the lock after completion", async () => {
      await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls: [] }),
        statusFn: async () => okStatus,
        bundleFreshFn: () => false,
        bundleBuilder: async () => ({
          ok: true,
          bundler: "bun" as const,
          report: [],
        }),
      });
      expect(existsSync(join(depsDir, ".setup.lock"))).toBe(false);
    });

    it("should run the bundle builder after install and include its report", async () => {
      const calls: SpawnCall[] = [];
      let builderDepsDir: string | null = null;
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
        bundleFreshFn: () => false,
        bundleBuilder: async (o) => {
          builderDepsDir = o.depsDir ?? null;
          return {
            ok: true,
            bundler: "bun" as const,
            report: ["Bundled @xenova/transformers 2.17.2 via bun."],
          };
        },
      });

      expect(builderDepsDir as string | null).toBe(depsDir);
      expect(result.report).toContain("Bundled @xenova/transformers");
    });

    it("should surface bundle failure in the report without crashing", async () => {
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls: [] }),
        statusFn: async () => okStatus,
        bundleFreshFn: () => false,
        bundleBuilder: async () => ({
          ok: false,
          bundler: null,
          report: ["Bundling failed — semantic search needs bun"],
        }),
      });

      expect(result.report).toContain("Bundling failed");
    });
  });

  describe("runMemorySetup", () => {
    it("should write a private package.json into the deps dir", async () => {
      const calls: SpawnCall[] = [];
      await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
      });

      const pkgPath = join(depsDir, "package.json");
      expect(existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        private: boolean;
      };
      expect(pkg.private).toBe(true);
    });

    it("should prefer bun add with the deps dir as cwd", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
      });

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd[0]).toBe("bun");
      expect(calls[0]!.cmd[1]).toBe("add");
      expect(calls[0]!.cwd).toBe(depsDir);
      expect(result.report).toContain("bun");
    });

    it("should pin package versions from the root package.json", async () => {
      const calls: SpawnCall[] = [];
      await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
      });

      const versions = readPinnedVersions();
      expect(calls[0]!.cmd).toContain(`sqlite-vec@${versions.sqliteVec}`);
      expect(calls[0]!.cmd).toContain(
        `@xenova/transformers@${versions.transformers}`,
      );
    });

    it("should fall back to npm install --prefix when bun is unavailable", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls, missing: ["bun"] }),
        statusFn: async () => okStatus,
      });

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd[0]).toBe("npm");
      expect(calls[0]!.cmd[1]).toBe("install");
      expect(calls[0]!.cmd).toContain("--prefix");
      expect(calls[0]!.cmd).toContain(depsDir);
      expect(result.report).toContain("npm");
    });

    it("should fail with an actionable message when neither bun nor npm spawns", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls, missing: ["bun", "npm"] }),
        statusFn: async () => okStatus,
      });

      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
      expect(result.report).toContain("bun");
      expect(result.report).toContain("npm");
    });

    it("should fail when the install exits non-zero", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls, exitCode: 1 }),
        statusFn: async () => okStatus,
      });

      expect(result.ok).toBe(false);
      expect(result.report.toLowerCase()).toContain("fail");
    });

    it("should fail with the setup hint when deps are still missing after install", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => missingStatus,
      });

      expect(result.ok).toBe(false);
      expect(result.report).toContain("MISSING");
    });

    it("should report both deps as available on success", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
      });

      expect(result.ok).toBe(true);
      expect(result.report).toContain("@xenova/transformers");
      expect(result.report).toContain("sqlite-vec");
      expect(result.report).toContain("OK");
    });

    it("should mention brew install sqlite on darwin when custom sqlite fails to load", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
        platformName: "darwin",
        sqliteLoader: () => false,
      });

      expect(result.report).toContain("brew install sqlite");
    });

    it("should not mention brew on linux", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => okStatus,
        platformName: "linux",
        sqliteLoader: () => false,
      });

      expect(result.report).not.toContain("brew install sqlite");
    });

    it("should explain the compiled-binary limitation when the deps-dir import fails", async () => {
      const calls: SpawnCall[] = [];
      const result = await runMemorySetup({
        depsDir,
        spawner: recordingSpawner({ calls }),
        statusFn: async () => ({
          transformers: false,
          sqliteVec: true,
          hint: "Run: sentinal memory setup",
          errors: [
            "transformers deps dir import: Cannot find module '@huggingface/jinja'",
          ],
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.report).toContain("compiled sentinal binaries");
      expect(result.report).toContain("bun");
    });
  });

  describe("runSetupCommand (CLI wiring)", () => {
    it("should return the report and leave exitCode unset on success", async () => {
      const output = await runSetupCommand({
        depsDir,
        spawner: recordingSpawner({ calls: [] }),
        statusFn: async () => okStatus,
      });

      expect(output).toContain("Memory Setup");
      // afterEach resets exitCode to 0 (Bun can't reset to undefined), so
      // "unset" here means "not a failure code".
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("should set a non-zero exit code on failure", async () => {
      const output = await runSetupCommand({
        depsDir,
        spawner: recordingSpawner({ calls: [], missing: ["bun", "npm"] }),
        statusFn: async () => okStatus,
      });

      expect(output.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    });
  });
});
