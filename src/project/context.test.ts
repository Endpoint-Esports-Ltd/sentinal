/**
 * Project Context Analysis Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeProject,
  formatProjectContext,
  type ProjectContext,
} from "./context.js";

function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `sentinal-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("analyzeProject", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should extract name from package.json", () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "@acme/my-app",
        scripts: { build: "tsc", test: "jest" },
      }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.name).toBe("@acme/my-app");
  });

  it("should fall back to directory basename when no package.json", () => {
    const ctx = analyzeProject(projectDir);
    expect(ctx.name).toBeTruthy();
    // Should be the basename of the temp dir
    expect(typeof ctx.name).toBe("string");
  });

  it("should extract scripts from package.json", () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "test-app",
        scripts: {
          build: "tsc",
          test: "bun test",
          lint: "eslint .",
          dev: "bun run dev",
        },
      }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.commands.build).toBe("tsc");
    expect(ctx.commands.test).toBe("bun test");
    expect(ctx.commands.lint).toBe("eslint .");
    expect(ctx.commands.dev).toBe("bun run dev");
  });

  it("should detect package manager from lockfile", () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(projectDir, "bun.lockb"), "");

    const ctx = analyzeProject(projectDir);
    expect(ctx.techStack.packageManager).toBe("bun");
  });

  it("should detect frameworks", () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(projectDir, "angular.json"), "{}");

    const ctx = analyzeProject(projectDir);
    expect(ctx.techStack.frameworks).toContain("angular");
  });

  it("should capture directory structure", () => {
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(join(projectDir, "tests"), { recursive: true });
    mkdirSync(join(projectDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.structure).toContain("src/");
    expect(ctx.structure).toContain("tests/");
    // node_modules should be excluded
    expect(ctx.structure).not.toContain("node_modules/");
  });

  it("should capture src/ subdirectories", () => {
    mkdirSync(join(projectDir, "src", "components"), { recursive: true });
    mkdirSync(join(projectDir, "src", "services"), { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.structure).toContain("src/components/");
    expect(ctx.structure).toContain("src/services/");
  });

  it("should include sync-generated rules when present", () => {
    mkdirSync(join(projectDir, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(projectDir, ".claude", "rules", "test-project.md"),
      "# My Project Rules\n\nUse strict TypeScript.",
    );
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.rulesContent).toContain("My Project Rules");
  });

  it("should return null rulesContent when no rules files exist", () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.rulesContent).toBeNull();
  });

  it("should detect tsconfig strict mode", () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(
      join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022" },
      }),
    );

    const ctx = analyzeProject(projectDir);
    expect(ctx.conventions).toContain("TypeScript strict mode enabled");
  });

  it("should include analyzedAt timestamp", () => {
    const before = Date.now();
    const ctx = analyzeProject(projectDir);
    const after = Date.now();

    expect(ctx.analyzedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.analyzedAt).toBeLessThanOrEqual(after);
  });
});

describe("formatProjectContext", () => {
  it("should produce readable markdown", () => {
    const ctx: ProjectContext = {
      name: "my-app",
      techStack: {
        packageManager: "bun",
        frameworks: ["nestjs"],
        testRunner: "jest",
        language: "TypeScript",
      },
      structure: ["src/", "src/modules/", "src/common/", "tests/"],
      conventions: ["TypeScript strict mode enabled", "Uses ESLint"],
      commands: { build: "nest build", test: "jest", lint: "eslint ." },
      rulesContent: "# Project Rules\nUse DTOs for all endpoints.",
      analyzedAt: Date.now(),
    };

    const md = formatProjectContext(ctx);

    expect(md).toContain("# Project Context: my-app");
    expect(md).toContain("bun");
    expect(md).toContain("nestjs");
    expect(md).toContain("src/modules/");
    expect(md).toContain("nest build");
    expect(md).toContain("TypeScript strict mode");
    expect(md).toContain("Project Rules");
  });

  it("should omit rules section when rulesContent is null", () => {
    const ctx: ProjectContext = {
      name: "test",
      techStack: {
        packageManager: "npm",
        frameworks: [],
        testRunner: "jest",
        language: "TypeScript",
      },
      structure: ["src/"],
      conventions: [],
      commands: {},
      rulesContent: null,
      analyzedAt: Date.now(),
    };

    const md = formatProjectContext(ctx);
    expect(md).not.toContain("Project Rules");
  });
});
