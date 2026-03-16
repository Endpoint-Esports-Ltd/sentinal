#!/usr/bin/env node
/**
 * Sentinal Quality Check Test Runner
 *
 * This script tests the quality check logic without requiring OpenCode TUI.
 * Run with: node targets/opencode/tests/run-checks.js
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants (duplicated from plugin)
const WARN_THRESHOLD = 400;
const BLOCK_THRESHOLD = 600;

const TEST_FILE_PATTERNS = [
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.js$/,
  /\.test\.js$/,
  /\.e2e-spec\.ts$/,
];

const SKIP_TEST_PATTERNS = [
  /\.module\.ts$/,
  /\.dto\.ts$/,
  /\.entity\.ts$/,
  /\.interface\.ts$/,
  /\.enum\.ts$/,
  /\.constant\.ts$/,
  /\.config\.ts$/,
  /\.model\.ts$/,
  /index\.ts$/,
  /main\.ts$/,
  /environment\.ts$/,
];

const NEST_FILE_PATTERNS = [
  /\.controller\.ts$/,
  /\.service\.ts$/,
  /\.module\.ts$/,
  /\.guard\.ts$/,
  /\.interceptor\.ts$/,
  /\.dto\.ts$/,
  /\.entity\.ts$/,
  /\.pipe\.ts$/,
  /\.filter\.ts$/,
  /\.middleware\.ts$/,
];

// Utility functions
function isTestFile(filePath) {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function getExpectedTestPaths(filePath) {
  if (isTestFile(filePath)) return [];
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".js")) return [];
  if (SKIP_TEST_PATTERNS.some((p) => p.test(filePath))) return [];

  const ext = filePath.endsWith(".ts") ? ".ts" : ".js";
  const base = filePath.slice(0, -ext.length);
  return [`${base}.spec${ext}`, `${base}.test${ext}`];
}

function isNestFile(filePath) {
  return NEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function checkNestPatterns(filePath, content) {
  const issues = [];

  if (filePath.endsWith(".controller.ts")) {
    if (!content.includes("@ApiTags")) {
      issues.push("Controller missing @ApiTags decorator");
    }
  }

  if (filePath.endsWith(".dto.ts")) {
    if (!content.includes("class-validator") && !content.match(/@Is\w+\(/)) {
      issues.push("DTO missing class-validator decorators");
    }
  }

  if (filePath.endsWith(".entity.ts")) {
    if (!content.includes("@Entity") && !content.includes("@model")) {
      issues.push("Entity missing ORM decorator");
    }
  }

  return issues;
}

function checkFile(filePath) {
  const issues = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;

    // File length check
    if (lineCount > BLOCK_THRESHOLD && !isTestFile(filePath)) {
      issues.push(
        `BLOCK: File exceeds ${BLOCK_THRESHOLD} lines (${lineCount})`,
      );
    } else if (lineCount > WARN_THRESHOLD && !isTestFile(filePath)) {
      issues.push(
        `WARN: File has ${lineCount} lines (threshold: ${WARN_THRESHOLD})`,
      );
    }

    // NestJS patterns
    if (isNestFile(filePath)) {
      const nestIssues = checkNestPatterns(filePath, content);
      issues.push(...nestIssues.map((i) => `NestJS: ${i}`));
    }

    // TDD check
    if (!isTestFile(filePath)) {
      const testPaths = getExpectedTestPaths(filePath);
      if (testPaths.length > 0 && !testPaths.some((tp) => existsSync(tp))) {
        issues.push(`TDD: No companion test file (expected: ${testPaths[0]})`);
      }
    }
  } catch (e) {
    issues.push(`ERROR: Could not read file: ${e.message}`);
  }

  return {
    file: filePath,
    issues,
    passed:
      issues.length === 0 ||
      issues.every((i) => i.startsWith("WARN:") || i.startsWith("TDD:")),
  };
}

function findTsFiles(dir, maxDepth = 5) {
  const files = [];

  function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    if (!existsSync(currentDir)) return;

    try {
      const entries = readdirSync(currentDir);
      for (const entry of entries) {
        if (
          entry.startsWith(".") ||
          entry === "node_modules" ||
          entry === "dist" ||
          entry === "build"
        ) {
          continue;
        }

        const fullPath = join(currentDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (
            stat.isFile() &&
            (entry.endsWith(".ts") || entry.endsWith(".js"))
          ) {
            files.push(fullPath);
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(dir, 0);
  return files;
}

// Main
const fixturesDir = join(
  process.cwd(),
  "targets",
  "opencode",
  "tests",
  "fixtures",
);

if (!existsSync(fixturesDir)) {
  console.error("Fixtures directory not found:", fixturesDir);
  process.exit(1);
}

console.log(
  "═══════════════════════════════════════════════════════════════════",
);
console.log("  Sentinal Quality Check - Test Runner");
console.log(
  "═══════════════════════════════════════════════════════════════════\n",
);

console.log("Checking fixtures in:", fixturesDir, "\n");

const files = findTsFiles(fixturesDir);
const results = files.map(checkFile);

const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

console.log("Results:");
console.log(`  Total files: ${results.length}`);
console.log(`  Passed: ${passed.length}`);
console.log(`  Issues found: ${failed.length}\n`);

if (failed.length > 0) {
  console.log("Files with issues:\n");
  for (const result of failed) {
    console.log(`  ${relative(fixturesDir, result.file)}:`);
    for (const issue of result.issues) {
      console.log(`    - ${issue}`);
    }
    console.log("");
  }
}

console.log(
  "═══════════════════════════════════════════════════════════════════",
);
console.log("Test fixtures validate the Sentinal quality check logic.");
console.log("Expected issues:");
console.log("  - user-service.ts: File length > 400 (should warn)");
console.log("  - create-user.dto.ts: Missing class-validator decorators");
console.log("  - users.controller.ts: Missing @ApiTags decorator");
console.log("  - user.service.ts (implementation): No companion test file");
console.log(
  "═══════════════════════════════════════════════════════════════════",
);
