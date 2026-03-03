import { describe, expect, it } from "bun:test";
import { detectPackageManager, detectTestRunner, detectFramework } from "./detect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sentinal-test-"));
}

describe("detect", () => {
  describe("detectPackageManager", () => {
    it("should detect pnpm from pnpm-lock.yaml", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(dir)).toBe("pnpm");
      rmSync(dir, { recursive: true });
    });

    it("should detect yarn from yarn.lock", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "yarn.lock"), "");
      expect(detectPackageManager(dir)).toBe("yarn");
      rmSync(dir, { recursive: true });
    });

    it("should detect bun from bun.lockb", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "bun.lockb"), "");
      expect(detectPackageManager(dir)).toBe("bun");
      rmSync(dir, { recursive: true });
    });

    it("should detect npm from package-lock.json", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "package-lock.json"), "{}");
      expect(detectPackageManager(dir)).toBe("npm");
      rmSync(dir, { recursive: true });
    });

    it("should default to npm when no lockfile", () => {
      const dir = createTempDir();
      expect(detectPackageManager(dir)).toBe("npm");
      rmSync(dir, { recursive: true });
    });
  });

  describe("detectTestRunner", () => {
    it("should detect jest from jest.config.ts", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "jest.config.ts"), "");
      expect(detectTestRunner(dir)).toBe("jest");
      rmSync(dir, { recursive: true });
    });

    it("should detect vitest from vitest.config.ts", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "vitest.config.ts"), "");
      expect(detectTestRunner(dir)).toBe("vitest");
      rmSync(dir, { recursive: true });
    });

    it("should detect karma from karma.conf.js", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "karma.conf.js"), "");
      expect(detectTestRunner(dir)).toBe("karma");
      rmSync(dir, { recursive: true });
    });

    it("should default to jest", () => {
      const dir = createTempDir();
      expect(detectTestRunner(dir)).toBe("jest");
      rmSync(dir, { recursive: true });
    });
  });

  describe("detectFramework", () => {
    it("should detect angular from angular.json", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "angular.json"), "{}");
      expect(detectFramework(dir)).toContain("angular");
      rmSync(dir, { recursive: true });
    });

    it("should detect nestjs from nest-cli.json", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "nest-cli.json"), "{}");
      expect(detectFramework(dir)).toContain("nestjs");
      rmSync(dir, { recursive: true });
    });

    it("should detect both in monorepo", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "angular.json"), "{}");
      writeFileSync(join(dir, "nest-cli.json"), "{}");
      const fw = detectFramework(dir);
      expect(fw).toContain("angular");
      expect(fw).toContain("nestjs");
      rmSync(dir, { recursive: true });
    });

    it("should return empty when no framework", () => {
      const dir = createTempDir();
      expect(detectFramework(dir)).toEqual([]);
      rmSync(dir, { recursive: true });
    });
  });
});
