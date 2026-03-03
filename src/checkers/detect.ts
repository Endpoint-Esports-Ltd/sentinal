import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type TestRunner = "jest" | "vitest" | "karma";
export type Framework = "angular" | "nestjs";

const LOCKFILE_MAP: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "package-lock.json": "npm",
};

const TEST_CONFIG_MAP: Record<string, TestRunner> = {
  "jest.config.ts": "jest",
  "jest.config.js": "jest",
  "jest.config.mjs": "jest",
  "vitest.config.ts": "vitest",
  "vitest.config.js": "vitest",
  "vitest.config.mts": "vitest",
  "karma.conf.js": "karma",
  "karma.conf.ts": "karma",
};

const FRAMEWORK_MAP: Record<string, Framework> = {
  "angular.json": "angular",
  ".angular.json": "angular",
  "nest-cli.json": "nestjs",
};

export function detectPackageManager(cwd: string): PackageManager {
  for (const [file, pm] of Object.entries(LOCKFILE_MAP)) {
    if (existsSync(join(cwd, file))) return pm;
  }
  return "npm";
}

export function detectTestRunner(cwd: string): TestRunner {
  for (const [file, runner] of Object.entries(TEST_CONFIG_MAP)) {
    if (existsSync(join(cwd, file))) return runner;
  }
  return "jest";
}

export function detectFramework(cwd: string): Framework[] {
  const frameworks: Framework[] = [];
  for (const [file, framework] of Object.entries(FRAMEWORK_MAP)) {
    if (existsSync(join(cwd, file))) frameworks.push(framework);
  }
  return frameworks;
}
