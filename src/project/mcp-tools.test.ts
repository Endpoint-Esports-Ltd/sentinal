/**
 * Project MCP Tools Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeProject, formatProjectContext } from "./context.js";

function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `sentinal-mcp-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("project_context tool logic", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpProject();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        scripts: { build: "tsc", test: "bun test", lint: "eslint ." },
      }),
    );
    writeFileSync(
      join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
      }),
    );
    mkdirSync(join(projectDir, "src", "services"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should analyze and format a project in one pipeline", () => {
    const ctx = analyzeProject(projectDir);
    const md = formatProjectContext(ctx);

    expect(md).toContain("# Project Context: test-project");
    expect(md).toContain("TypeScript");
    expect(md).toContain("tsc");
    expect(md).toContain("src/services/");
    expect(md).toContain("TypeScript strict mode");
  });

  it("should produce valid context even for empty directories", () => {
    const emptyDir = join(tmpdir(), `sentinal-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });

    const ctx = analyzeProject(emptyDir);
    const md = formatProjectContext(ctx);

    expect(md).toContain("# Project Context:");
    expect(ctx.name).toBeTruthy();

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("should include refresh capability (context changes on re-analysis)", () => {
    const ctx1 = analyzeProject(projectDir);
    expect(ctx1.commands.build).toBe("tsc");

    // Modify package.json
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "updated-project",
        scripts: { build: "vite build" },
      }),
    );

    const ctx2 = analyzeProject(projectDir);
    expect(ctx2.name).toBe("updated-project");
    expect(ctx2.commands.build).toBe("vite build");
  });
});
