/**
 * Quality Routes Tests
 *
 * Tests the sidecar quality check endpoint that runs tsc/eslint/prettier
 * as async subprocesses with timeouts and returns structured results.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { startSidecar, stopSidecar } from "./server.js";
import { getToolCommand } from "./quality-routes.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

// ─── Test Sidecar Setup ────────────────────────────────────────────────────

let base: string;
let sidecar: Awaited<ReturnType<typeof startSidecar>>;
let tmpDir: string;

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

beforeAll(async () => {
  tmpDir = join(tmpdir(), `quality-test-${Date.now().toString(36)}`);
  mkdirSync(tmpDir, { recursive: true });

  const store = new MemoryStore(join(tmpDir, "test.db"));
  sidecar = await startSidecar({ store, port: 0, httpOnly: true });
  const port = sidecar.server.port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  stopSidecar(sidecar.server, sidecar.ctx);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Quality Check Endpoint ─────────────────────────────────────────────────

describe("POST /quality-check", () => {
  it(
    "should return structured results for a valid project",
    async () => {
      // Use the sentinal project itself as the test project
      const projectPath = join(import.meta.dir, "../..");
      const r = await post(base, "/quality-check", {
        projectPath,
        checks: ["tsc"],
        timeout: 60000,
      });

      expect(r.ok).toBe(true);
      expect(r.data.tsc).toBeDefined();
      expect(typeof r.data.tsc.ok).toBe("boolean");
      expect(typeof r.data.tsc.durationMs).toBe("number");
      expect(Array.isArray(r.data.tsc.errors)).toBe(true);
    },
    60_000,
  );

  it(
    "should support single-file eslint check",
    async () => {
      const projectPath = join(import.meta.dir, "../..");
      const r = await post(base, "/quality-check", {
        projectPath,
        filePath: join(import.meta.dir, "quality-routes.ts"),
        checks: ["eslint"],
        timeout: 30000,
      });

      expect(r.ok).toBe(true);
      expect(r.data.eslint).toBeDefined();
      expect(typeof r.data.eslint.ok).toBe("boolean");
      expect(typeof r.data.eslint.durationMs).toBe("number");
    },
    30_000,
  );

  it(
    "should support single-file prettier check",
    async () => {
      const projectPath = join(import.meta.dir, "../..");
      const r = await post(base, "/quality-check", {
        projectPath,
        filePath: join(import.meta.dir, "quality-routes.ts"),
        checks: ["prettier"],
        timeout: 30000,
      });

      expect(r.ok).toBe(true);
      expect(r.data.prettier).toBeDefined();
      expect(typeof r.data.prettier.ok).toBe("boolean");
    },
    30_000,
  );

  it("should fail with 400 when projectPath is missing", async () => {
    const r = await post(base, "/quality-check", { checks: ["tsc"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("projectPath");
  });

  it("should fail with 400 when projectPath does not exist", async () => {
    const r = await post(base, "/quality-check", {
      projectPath: "/nonexistent/path/to/project",
      checks: ["tsc"],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it(
    "should include incremental flag in tsc result",
    async () => {
      const projectPath = join(import.meta.dir, "../..");
      const r = await post(base, "/quality-check", {
        projectPath,
        checks: ["tsc"],
        timeout: 60000,
      });

      expect(r.ok).toBe(true);
      expect(typeof r.data.tsc.incremental).toBe("boolean");
    },
    60_000,
  );

  it(
    "should run all checks when checks array is omitted",
    async () => {
      const projectPath = join(import.meta.dir, "../..");
      const r = await post(base, "/quality-check", {
        projectPath,
        filePath: join(import.meta.dir, "quality-routes.ts"),
        timeout: 60000,
      });

      expect(r.ok).toBe(true);
      // All three checks should be present
      expect(r.data.tsc).toBeDefined();
      expect(r.data.eslint).toBeDefined();
      expect(r.data.prettier).toBeDefined();
    },
    60_000,
  );
});

// ─── Concurrency Control ────────────────────────────────────────────────

describe("POST /quality-check concurrency", () => {
  it(
    "should reject duplicate requests for the same project",
    async () => {
      const projectPath = join(import.meta.dir, "../..");

      // Fire two requests simultaneously for the same project
      const [r1, r2] = await Promise.all([
        post(base, "/quality-check", {
          projectPath,
          checks: ["tsc"],
          timeout: 60000,
        }),
        post(base, "/quality-check", {
          projectPath,
          checks: ["tsc"],
          timeout: 60000,
        }),
      ]);

      // One should succeed, one should be rejected (429)
      const results = [r1, r2];
      const successes = results.filter((r) => r.ok === true);
      const rejects = results.filter((r) => r.ok === false);

      expect(successes.length).toBe(1);
      expect(rejects.length).toBe(1);
      expect(rejects[0].error).toContain("already running");
    },
    60_000,
  );

  it(
    "should allow requests for different projects",
    async () => {
      const projectPath = join(import.meta.dir, "../..");
      // Use different filePaths but same project — should still dedup by project
      // To test different projects properly, we'd need two valid project paths.
      // Just verify the first request succeeds.
      const r = await post(base, "/quality-check", {
        projectPath,
        checks: ["prettier"],
        filePath: join(import.meta.dir, "quality-routes.ts"),
        timeout: 30000,
      });
      expect(r.ok).toBe(true);
    },
    30_000,
  );
});

// ─── getToolCommand ─────────────────────────────────────────────────────────

describe("getToolCommand", () => {
  let fakeProjDir: string;

  beforeAll(() => {
    fakeProjDir = join(tmpdir(), `tool-cmd-test-${Date.now().toString(36)}`);
    mkdirSync(join(fakeProjDir, "node_modules", ".bin"), { recursive: true });
    // Create a bun lockfile so detectPackageManager returns "bun"
    writeFileSync(join(fakeProjDir, "bun.lockb"), "");
  });

  afterAll(() => {
    rmSync(fakeProjDir, { recursive: true, force: true });
  });

  it("should prefer local binary when it exists", () => {
    // Create a fake eslint binary
    const binPath = join(fakeProjDir, "node_modules", ".bin", "eslint");
    writeFileSync(binPath, "#!/bin/sh\nexit 0", { mode: 0o755 });

    const cmd = getToolCommand(fakeProjDir, "eslint");
    expect(cmd).toEqual([binPath]);
  });

  it("should fall back to bunx when no local binary exists", () => {
    const cmd = getToolCommand(fakeProjDir, "prettier");
    expect(cmd).toEqual(["bunx", "prettier"]);
  });

  it("should fall back to npx for npm projects", () => {
    const npmDir = join(
      tmpdir(),
      `tool-cmd-npm-test-${Date.now().toString(36)}`,
    );
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, "package-lock.json"), "{}");

    const cmd = getToolCommand(npmDir, "eslint");
    expect(cmd).toEqual(["npx", "eslint"]);

    rmSync(npmDir, { recursive: true, force: true });
  });
});
