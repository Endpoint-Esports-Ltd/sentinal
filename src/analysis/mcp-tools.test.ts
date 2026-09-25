/**
 * Analysis MCP Tools Tests
 *
 * Tests for spec-aware analysis tools:
 *   - check_diagnostics: tsc with delta tracking and spec-file filtering
 *   - impact_analysis: change impact with plan-context cross-referencing and risk scoring
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { registerAnalysisTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";

// --- Fake eslint/prettier for quality_report (D1) ---
// Never run the real formatter/linter on repo files: each fake appends its
// argv to `.fake/<tool>.argv`; `.fake/<tool>.<mode>.{out,exit}` set behaviour.

const FAKE_SCRIPT = (dir: string, tool: string) => `#!/bin/sh
D="${dir}/.fake"
printf '%s\\n' "$*" >> "$D/${tool}.argv"
M=$(echo "$1" | sed 's/^--//')
[ -f "$D/${tool}.$M.out" ] && cat "$D/${tool}.$M.out"
exit $(cat "$D/${tool}.$M.exit" 2>/dev/null || echo 0)
`;

const fakeDirs: string[] = [];
function fake(spec: Record<string, string | number> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "qtool-fake-")));
  fakeDirs.push(dir);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, ".fake"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  for (const tool of ["eslint", "prettier"]) {
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

// --- Helpers ---

// Minimal plan file content for tests
function writePlan(
  dir: string,
  slug: string,
  filesSection: string = "",
): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const content = `# ${slug}

Status: IN_PROGRESS
Type: Feature
Approved: Yes

## Progress Tracking
- [ ] Task 1: Do something

## Implementation Tasks

### Task 1: Do something

**Files:**
${filesSection || "- Modify: src/auth/auth.service.ts\n- Create: src/auth/auth.service.test.ts"}
`;
  const path = join(plansDir, `${slug}.md`);
  writeFileSync(path, content);
  return path;
}

// --- Registration tests ---

describe("Analysis MCP tools — registration", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should register check_diagnostics and impact_analysis tools", () => {
    const tools = captureTools(registerAnalysisTools, { store });
    expect(tools.has("check_diagnostics")).toBe(true);
    expect(tools.has("impact_analysis")).toBe(true);
  });
});

// --- check_diagnostics tests ---

describe("check_diagnostics", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerAnalysisTools, { store });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return no errors when tsc exits with 0", async () => {
    // Mock Bun.spawn to return exit 0
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => ({
      stdout: { text: async () => "" },
      stderr: { text: async () => "" },
      exited: Promise.resolve(0),
      kill: () => {},
    }));

    const handler = tools.get("check_diagnostics")!;
    const result = await handler({ project: tmpDir });

    expect(result.content[0].text).toContain("0 errors");
    (Bun as any).spawn = origSpawn;
  });

  it("should return formatted errors when tsc exits with 1", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => ({
      stdout: {
        text: async () =>
          "src/auth/auth.service.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
          "src/user/user.dto.ts(20,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n",
      },
      stderr: { text: async () => "" },
      exited: Promise.resolve(1),
      kill: () => {},
    }));

    const handler = tools.get("check_diagnostics")!;
    const result = await handler({ project: tmpDir });

    expect(result.content[0].text).toContain("2 errors");
    expect(result.content[0].text).toContain("auth.service.ts");
    expect(result.content[0].text).toContain("TS2322");
    (Bun as any).spawn = origSpawn;
  });

  it("should report delta when previous baseline exists", async () => {
    // Seed a baseline with 3 errors
    const baseline = {
      timestamp: Date.now() - 60000,
      errorCount: 3,
      errors: [
        { file: "src/a.ts", line: 1, message: "TS2322: old error" },
        { file: "src/b.ts", line: 2, message: "TS2345: old error 2" },
        { file: "src/c.ts", line: 3, message: "TS2551: old error 3" },
      ],
    };
    const projectHash = Buffer.from(tmpDir).toString("base64").slice(0, 16);
    store.setSetting(`diagnostics:${projectHash}`, JSON.stringify(baseline));

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => ({
      stdout: {
        text: async () =>
          "src/a.ts(1,1): error TS2322: old error\n" +
          "src/d.ts(5,5): error TS9999: new error\n",
      },
      stderr: { text: async () => "" },
      exited: Promise.resolve(1),
      kill: () => {},
    }));

    const handler = tools.get("check_diagnostics")!;
    const result = await handler({ project: tmpDir });
    const text = result.content[0].text;

    expect(text).toContain("1 NEW");
    expect(text).toContain("2 FIXED");
    (Bun as any).spawn = origSpawn;
  });

  it("should filter to spec-relevant files when active spec exists", async () => {
    const specStore = new SpecStore(store);
    const planPath = writePlan(
      tmpDir,
      "my-spec",
      "- Modify: src/auth/auth.service.ts",
    );
    specStore.syncFromPlanFile(planPath, tmpDir);

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => ({
      stdout: {
        text: async () =>
          "src/auth/auth.service.ts(10,5): error TS2322: spec file error\n" +
          "src/unrelated/other.ts(5,1): error TS9999: unrelated error\n",
      },
      stderr: { text: async () => "" },
      exited: Promise.resolve(1),
      kill: () => {},
    }));

    const handler = tools.get("check_diagnostics")!;
    const result = await handler({ project: tmpDir });
    const text = result.content[0].text;

    // Spec file shown in detail
    expect(text).toContain("auth.service.ts");
    // Non-spec error summarized
    expect(text).toContain("1 other error");
    (Bun as any).spawn = origSpawn;
  });

  it("should handle tsc timeout gracefully", async () => {
    const origSpawn = Bun.spawn;
    // Simulate a process that never exits (we'll fake the timeout by rejecting)
    (Bun as any).spawn = mock(() => ({
      stdout: { text: async () => "" },
      stderr: { text: async () => "partial output" },
      exited: new Promise(() => {
        /* never resolves */
      }),
      kill: () => {},
    }));

    // Override timeout to 10ms for testing
    const handler = tools.get("check_diagnostics")!;
    const result = await handler({ project: tmpDir, timeout_ms: 10 });

    expect(result.content[0].text).toContain("TIMEOUT");
    (Bun as any).spawn = origSpawn;
  });

  it("should cache results in settings table after run", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => ({
      stdout: {
        text: async () => "src/a.ts(1,1): error TS2322: some error\n",
      },
      stderr: { text: async () => "" },
      exited: Promise.resolve(1),
      kill: () => {},
    }));

    const handler = tools.get("check_diagnostics")!;
    await handler({ project: tmpDir });

    const projectHash = Buffer.from(tmpDir).toString("base64").slice(0, 16);
    const cached = store.getSetting(`diagnostics:${projectHash}`);
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.errors[0].file).toContain("src/a.ts");
    (Bun as any).spawn = origSpawn;
  });

  it("should return helpful error when tsc not found", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const handler = tools.get("check_diagnostics")!;
    const result = await handler({ project: tmpDir });

    expect(result.content[0].text).toContain("Error");
    (Bun as any).spawn = origSpawn;
  });
});

// --- impact_analysis tests ---

describe("impact_analysis", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerAnalysisTools, { store });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty analysis when no files changed", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => ({
      stdout: { text: async () => "" },
      stderr: { text: async () => "" },
      exited: Promise.resolve(0),
      kill: () => {},
    }));

    const handler = tools.get("impact_analysis")!;
    const result = await handler({ project: tmpDir });

    expect(result.content[0].text).toContain("0 files");
    (Bun as any).spawn = origSpawn;
  });

  it("should return LOW risk when only expected spec files changed", async () => {
    const specStore = new SpecStore(store);
    const planPath = writePlan(
      tmpDir,
      "my-spec",
      "- Modify: src/auth/auth.service.ts",
    );
    specStore.syncFromPlanFile(planPath, tmpDir);

    // Write the file so we can read its line count
    mkdirSync(join(tmpDir, "src", "auth"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src/auth/auth.service.ts"),
      "export function foo() {}\n".repeat(10),
    );

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock((cmd: string[]) => {
      if (cmd.includes("--name-only")) {
        return {
          stdout: { text: async () => "src/auth/auth.service.ts\n" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      if (cmd.includes("--stat")) {
        return {
          stdout: {
            text: async () =>
              " src/auth/auth.service.ts | 5 +++++\n 1 file changed, 5 insertions(+)",
          },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      // grep for importers
      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(1),
        kill: () => {},
      };
    });

    const handler = tools.get("impact_analysis")!;
    const result = await handler({ project: tmpDir });
    const text = result.content[0].text;

    expect(text).toContain("LOW");
    expect(text).toContain("auth.service.ts");
    (Bun as any).spawn = origSpawn;
  });

  it("should return HIGH risk when unexpected files changed", async () => {
    const specStore = new SpecStore(store);
    const planPath = writePlan(
      tmpDir,
      "my-spec",
      "- Modify: src/auth/auth.service.ts",
    );
    specStore.syncFromPlanFile(planPath, tmpDir);

    mkdirSync(join(tmpDir, "src", "routes"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src/routes/routes.ts"),
      "// routes\n".repeat(10),
    );

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock((cmd: string[]) => {
      if (cmd.includes("--name-only")) {
        // Returns a file NOT in the spec
        return {
          stdout: { text: async () => "src/routes/routes.ts\n" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      if (cmd.includes("--stat")) {
        return {
          stdout: {
            text: async () => " src/routes/routes.ts | 3 +++\n 1 file changed",
          },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(1),
        kill: () => {},
      };
    });

    const handler = tools.get("impact_analysis")!;
    const result = await handler({ project: tmpDir });
    const text = result.content[0].text;

    expect(text).toContain("HIGH");
    expect(text).toContain("WARNING");
    expect(text).toContain("routes.ts");
    (Bun as any).spawn = origSpawn;
  });

  it("should warn on files over 400-line limit", async () => {
    // Write a file that is 410 lines
    mkdirSync(join(tmpDir, "src", "big"), { recursive: true });
    // repeat(400) produces 400 newlines = 401 lines when split("\n"); use 410 to exceed 400-line limit
    writeFileSync(join(tmpDir, "src/big/big.ts"), "const x = 1;\n".repeat(410));
    // File will have 411 lines (410 content lines + trailing newline splits to 411)

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock((cmd: string[]) => {
      if (cmd.includes("--name-only")) {
        return {
          stdout: { text: async () => "src/big/big.ts\n" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      if (cmd.includes("--stat")) {
        return {
          stdout: {
            text: async () =>
              " src/big/big.ts | 10 ++++++++++\n 1 file changed",
          },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(1),
        kill: () => {},
      };
    });

    const handler = tools.get("impact_analysis")!;
    const result = await handler({ project: tmpDir });
    const text = result.content[0].text;

    expect(text).toMatch(/41[01] lines/);
    expect(text).toContain("over 400");
    (Bun as any).spawn = origSpawn;
  });

  it("should return LOW risk with no active spec", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src/foo.ts"),
      "export const x = 1;\n".repeat(5),
    );

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock((cmd: string[]) => {
      if (cmd.includes("--name-only")) {
        return {
          stdout: { text: async () => "src/foo.ts\n" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      if (cmd.includes("--stat")) {
        return {
          stdout: { text: async () => " src/foo.ts | 2 ++\n 1 file changed" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }
      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(1),
        kill: () => {},
      };
    });

    const handler = tools.get("impact_analysis")!;
    const result = await handler({ project: tmpDir });
    const text = result.content[0].text;

    // Without active spec, all changed files are "unknown" — treated as LOW
    expect(text).toContain("src/foo.ts");
    (Bun as any).spawn = origSpawn;
  });

  it("should handle git not found gracefully", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = mock(() => {
      throw new Error("ENOENT: git not found");
    });

    const handler = tools.get("impact_analysis")!;
    const result = await handler({ project: tmpDir });

    expect(result.content[0].text).toContain("Error");
    (Bun as any).spawn = origSpawn;
  });
});

// --- Sidecar mode tests ---

describe("Analysis MCP tools (sidecar mode)", () => {
  it("should register tools when client provided", () => {
    const mockClient = {} as unknown as SidecarClient;
    const tools = captureTools(registerAnalysisTools, { client: mockClient });
    expect(tools.has("check_diagnostics")).toBe(true);
    expect(tools.has("impact_analysis")).toBe(true);
    expect(tools.has("quality_report")).toBe(true);
  });
});

// --- quality_report tool ---

describe("quality_report MCP tool", () => {
  it("should be registered with correct schema", () => {
    const tools = captureTools(registerAnalysisTools, {});
    expect(tools.has("quality_report")).toBe(true);
  });

  it("should return structured quality report for project", async () => {
    const tools = captureTools(registerAnalysisTools, {});
    const handler = tools.get("quality_report")!;
    const projectPath = join(import.meta.dir, "../..");

    const result = await handler({
      project: projectPath,
      checks: ["tsc"],
      timeout_ms: 60000,
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    const text = result.content[0].text;
    expect(text).toContain("Quality Report");
    expect(text).toContain("TypeScript");
  });

  it("single-file mode (no sidecar) fixes only that file — fake prettier", async () => {
    const dir = fake({ "prettier.check.exit": 1 });
    const tools = captureTools(registerAnalysisTools, {});
    const result = await tools.get("quality_report")!({
      project: dir,
      file: "src/a.ts",
      checks: ["prettier"],
      timeout_ms: 5000,
    });
    const abs = join(dir, "src", "a.ts");
    expect(argvOf(dir, "prettier")).toEqual([
      `--check ${abs}`,
      `--write ${abs}`,
    ]);
    expect(result.content[0].text).toContain(`Formatted ${abs}`);
  }, 10_000);

  it("describes project-wide mode as report-only and file mode as the only auto-fix", () => {
    const server = new McpServer({ name: "t", version: "0" });
    let description = "";
    let fileDescription = "";
    const orig = server.tool.bind(server);
    server.tool = ((...args: any[]) => {
      if (args[0] === "quality_report") {
        description = args[1];
        fileDescription = args[2].file.description;
      }
      return (orig as any)(...args);
    }) as any;
    registerAnalysisTools(server, {});
    expect(description).toContain("report-only");
    expect(description).not.toContain("with auto-fix for eslint/prettier");
    expect(fileDescription).toContain("auto-fixes only the given file");
    expect(fileDescription).toContain("project-wide is report-only");
  });
});

// --- quality_report D1: fix scope with a sidecar client ---

describe("quality_report fix scope (D1)", () => {
  function mockClient() {
    const calls: any[] = [];
    const client = {
      qualityCheck: mock(async (opts: any) => {
        calls.push(opts);
        return {
          tsc: { ok: true, errors: [], durationMs: 1, incremental: true },
        };
      }),
    } as unknown as SidecarClient;
    return { client, calls };
  }

  it("project-wide: lint runs report-only in-process; only tsc goes to the (possibly old) sidecar", async () => {
    const dir = fake({
      "prettier.list-different.out": "src/a.ts\nsrc/b.ts\n",
      "prettier.list-different.exit": 1,
      "eslint.format.exit": 1,
    });
    writeFileSync(
      join(dir, ".fake", "eslint.format.out"),
      JSON.stringify([
        {
          filePath: join(dir, "src", "a.ts"),
          errorCount: 1,
          warningCount: 0,
          messages: [{ ruleId: "no-undef", severity: 2, line: 7 }],
        },
      ]),
    );
    const { client, calls } = mockClient();
    const tools = captureTools(registerAnalysisTools, { client });
    const result = await tools.get("quality_report")!({
      project: dir,
      timeout_ms: 5000,
    });
    // An old sidecar would run `prettier --write .` — it must never see lint.
    expect(calls).toEqual([
      { projectPath: dir, filePath: undefined, checks: ["tsc"], timeout: 5000 },
    ]);
    expect(argvOf(dir, "eslint")).toEqual(["--format json ."]);
    expect(argvOf(dir, "prettier")).toEqual(["--list-different ."]);
    const text = result.content[0].text;
    expect(text).toContain("report-only");
    expect(text).toContain("2 files not formatted");
    expect(text).toContain("  - src/b.ts");
    expect(text).toContain("1 error, 0 warnings");
    expect(text).toContain("src/a.ts:7 no-undef");
  }, 15_000);

  it("project-wide without tsc never calls the sidecar", async () => {
    const dir = fake();
    const { client, calls } = mockClient();
    const tools = captureTools(registerAnalysisTools, { client });
    await tools.get("quality_report")!({
      project: dir,
      checks: ["prettier"],
      timeout_ms: 5000,
    });
    expect(calls).toEqual([]);
    expect(argvOf(dir, "prettier")).toEqual(["--list-different ."]);
  }, 10_000);

  it("single file: the sidecar receives the file resolved against the project", async () => {
    const dir = fake();
    const { client, calls } = mockClient();
    const tools = captureTools(registerAnalysisTools, { client });
    await tools.get("quality_report")!({
      project: dir,
      file: "src/a.ts",
      checks: ["prettier"],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].filePath).toBe(join(dir, "src", "a.ts"));
  });

  it("refuses a file outside the project without calling the sidecar or any tool", async () => {
    const dir = fake();
    const { client, calls } = mockClient();
    const tools = captureTools(registerAnalysisTools, { client });
    const result = await tools.get("quality_report")!({
      project: dir,
      file: "/etc/hosts",
    });
    expect(result.content[0].text).toContain("outside the project");
    expect(calls).toEqual([]);
    expect(argvOf(dir, "prettier")).toEqual([]);
    expect(argvOf(dir, "eslint")).toEqual([]);
  });
});
