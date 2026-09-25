/**
 * Quality Routes Tests
 *
 * Tests the sidecar quality check endpoint that runs tsc/eslint/prettier
 * as async subprocesses with timeouts and returns structured results.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { startSidecar, stopSidecar } from "./server.js";
import { getToolCommand, runQualityChecks } from "./quality-routes.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";

// ─── Fake tsc/eslint/prettier (argv-recording) ──────────────────────────
// Never run the real formatter/linter against repo files (D1): each fake
// appends its argv to `.fake/<tool>.argv`; `.fake/<tool>.<mode>.exit` etc.
// set behaviour per first flag. (Same helper as quality-lint.test.ts.)

const FAKE_SCRIPT = (dir: string, tool: string) => `#!/bin/sh
D="${dir}/.fake"
printf '%s\\n' "$*" >> "$D/${tool}.argv"
M=$(echo "$1" | sed 's/^--//')
[ -f "$D/${tool}.$M.out" ] && cat "$D/${tool}.$M.out"
exit $(cat "$D/${tool}.$M.exit" 2>/dev/null || echo 0)
`;

const fakeDirs: string[] = [];
function fake(spec: Record<string, string | number> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "qroute-fake-")));
  fakeDirs.push(dir);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, ".fake"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  for (const tool of ["tsc", "eslint", "prettier"]) {
    writeFileSync(
      join(dir, "node_modules", ".bin", tool),
      FAKE_SCRIPT(dir, tool),
      { mode: 0o755 },
    );
  }
  for (const [k, v] of Object.entries(spec)) {
    writeFileSync(join(dir, ".fake", k), String(v));
  }
  return dir;
}
function argvOf(dir: string, tool: string): string[] {
  const p = join(dir, ".fake", `${tool}.argv`);
  return existsSync(p)
    ? readFileSync(p, "utf-8").split("\n").filter(Boolean)
    : [];
}
afterEach(() => {
  for (const d of fakeDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

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
  sidecar = await startSidecar({
    store,
    port: 0,
    httpOnly: true,
    enableVectorSearch: false,
  });
  const port = sidecar.server.port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  stopSidecar(sidecar.server, sidecar.ctx);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Quality Check Endpoint ─────────────────────────────────────────────────

describe("POST /quality-check", () => {
  it("should return structured results for a valid project", async () => {
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
  }, 60_000);

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

  it("should include incremental flag in tsc result", async () => {
    const projectPath = join(import.meta.dir, "../..");
    const r = await post(base, "/quality-check", {
      projectPath,
      checks: ["tsc"],
      timeout: 60000,
    });

    expect(r.ok).toBe(true);
    expect(typeof r.data.tsc.incremental).toBe("boolean");
  }, 60_000);
});

// ─── D1: fix scope ──────────────────────────────────────────────────────

describe("POST /quality-check fix scope (D1)", () => {
  it("project-wide (no file) never passes --write or --fix", async () => {
    const dir = fake({
      "prettier.list-different.out": "src/a.ts\n",
      "prettier.list-different.exit": 1,
      "eslint.format.out": "[]",
    });
    const r = await post(base, "/quality-check", {
      projectPath: dir,
      checks: ["eslint", "prettier"],
      timeout: 5000,
    });
    expect(r.ok).toBe(true);
    expect(argvOf(dir, "eslint")).toEqual(["--format json ."]);
    expect(argvOf(dir, "prettier")).toEqual(["--list-different ."]);
    expect(r.data.prettier.fixMode).toBe("none");
    expect(r.data.prettier.files).toEqual(["src/a.ts"]);
    expect(r.data.prettier.autoFixed).toBe(false);
    expect(r.data.eslint.fixMode).toBe("none");
    expect(r.data.eslint.errorCount).toBe(0);
  }, 10_000);

  it("single file: eslint --fix and prettier --check/--write touch only that file", async () => {
    const dir = fake({ "prettier.check.exit": 1 });
    const abs = join(dir, "src", "a.ts");
    const r = await post(base, "/quality-check", {
      projectPath: dir,
      filePath: "src/a.ts",
      checks: ["eslint", "prettier"],
      timeout: 5000,
    });
    expect(r.ok).toBe(true);
    expect(argvOf(dir, "eslint")).toEqual([`--fix ${abs}`]);
    expect(argvOf(dir, "prettier")).toEqual([
      `--check ${abs}`,
      `--write ${abs}`,
    ]);
    expect(r.data.prettier.autoFixed).toBe(true);
    expect(r.data.prettier.fixMode).toBe("file");
  }, 10_000);

  it("refuses a file outside the project with 400 and spawns nothing", async () => {
    const dir = fake();
    const r = await post(base, "/quality-check", {
      projectPath: dir,
      filePath: "/etc/hosts",
      timeout: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside the project");
    for (const tool of ["tsc", "eslint", "prettier"]) {
      expect(argvOf(dir, tool)).toEqual([]);
    }
    // The refusal must not leave the project locked in activeChecks.
    const again = await post(base, "/quality-check", {
      projectPath: dir,
      checks: ["prettier"],
      timeout: 5000,
    });
    expect(again.ok).toBe(true);
  }, 10_000);
});

describe("runQualityChecks (direct)", () => {
  it("runs all three checks when checks is omitted", async () => {
    const dir = fake({ "eslint.format.out": "[]" });
    const r = await runQualityChecks({ projectPath: dir, timeout: 5000 });
    expect(r.tsc).toBeDefined();
    expect(r.eslint).toBeDefined();
    expect(r.prettier).toBeDefined();
    expect(argvOf(dir, "prettier")).toEqual(["--list-different ."]);
  }, 15_000);

  it("rejects an outside file before running any check (tsc included)", async () => {
    const dir = fake();
    await expect(
      runQualityChecks({
        projectPath: dir,
        filePath: "../x.ts",
        timeout: 5000,
      }),
    ).rejects.toThrow(/outside the project/);
    expect(argvOf(dir, "tsc")).toEqual([]);
  }, 10_000);
});

// ─── Concurrency Control ────────────────────────────────────────────────

describe("POST /quality-check concurrency", () => {
  it("should reject duplicate requests for the same project", async () => {
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
  }, 60_000);

  it("should allow a request for another project while one is idle", async () => {
    const dir = fake();
    const r = await post(base, "/quality-check", {
      projectPath: dir,
      checks: ["prettier"],
      filePath: join(dir, "src", "a.ts"),
      timeout: 5000,
    });
    expect(r.ok).toBe(true);
  }, 10_000);
});

// ─── Hung subprocess (H8 wedge) ─────────────────────────────────────────
//
// A bunx/npx grandchild that ignores SIGTERM and holds stderr open used to
// hang the post-kill `new Response(proc.stderr).text()` read forever, so the
// route's `finally` never ran and `activeChecks` retained the project until
// sidecar restart (every later check → 429).

describe("POST /quality-check hung subprocess", () => {
  let hungDir: string;

  beforeAll(() => {
    hungDir = join(tmpdir(), `qc-hung-${Date.now().toString(36)}`);
    mkdirSync(join(hungDir, "node_modules", ".bin"), { recursive: true });
    // Fake eslint: ignores SIGTERM and holds stderr open (sleep keeps the
    // inherited pipe fd alive). Self-cleans after 15s so a failing run
    // cannot wedge the whole test file.
    writeFileSync(
      join(hungDir, "node_modules", ".bin", "eslint"),
      "#!/bin/sh\ntrap '' TERM\nsleep 15\n",
      { mode: 0o755 },
    );
    // Fake prettier: instant success — used to prove activeChecks released.
    writeFileSync(
      join(hungDir, "node_modules", ".bin", "prettier"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    rmSync(hungDir, { recursive: true, force: true });
  });

  it("returns within budget when the subprocess ignores SIGTERM and holds stderr open", async () => {
    const start = Date.now();
    const r = await post(base, "/quality-check", {
      projectPath: hungDir,
      checks: ["eslint"],
      timeout: 500, // subprocess timeout — fake ignores the SIGTERM that follows
    });
    // Post-kill read must be raced against a short deadline, not awaited
    // unconditionally: subprocess timeout (500ms) + read deadline + slack.
    expect(Date.now() - start).toBeLessThan(8000);
    expect(r.ok).toBe(true);
    expect(r.data.eslint.timedOut).toBe(true);
    expect(r.data.eslint.ok).toBe(false);
  }, 10_000); // it() timeout matches the subprocess budget (repo rule)

  it("allows a second check for the same project after a hung first (activeChecks released)", async () => {
    // Before the fix this 429s ("already running") because the first
    // request's finally never ran. Assert via behaviour, not internals.
    const r2 = await post(base, "/quality-check", {
      projectPath: hungDir,
      checks: ["prettier"],
      timeout: 5000,
    });
    expect(r2.ok).toBe(true);
    expect(r2.data.prettier.ok).toBe(true);
  }, 10_000);
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
