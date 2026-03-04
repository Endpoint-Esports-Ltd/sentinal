/**
 * Sentinal Check Tool for OpenCode
 *
 * A custom tool that allows manual invocation of Sentinal quality checks.
 * Useful when you want to verify a file before/after editing, or check
 * the entire project's quality status.
 *
 * Usage in OpenCode:
 *   "Run sentinal-check on src/app/user.service.ts"
 *   "Check the quality of the auth module"
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

// Tool helper for OpenCode custom tools
// Once @opencode-ai/plugin is published, replace with: import { tool } from "@opencode-ai/plugin"
interface ToolContext {
  agent: string;
  sessionID: string;
  messageID: string;
  directory: string;
  worktree: string;
}

interface ToolDefinition<T extends z.ZodRawShape> {
  description: string;
  args: T;
  execute: (args: z.infer<z.ZodObject<T>>, context: ToolContext) => Promise<string>;
}

function tool<T extends z.ZodRawShape>(def: ToolDefinition<T>): ToolDefinition<T> {
  return def;
}

// Attach schema helper
(tool as any).schema = z;

// ═══════════════════════════════════════════════════════════════════════════
// Constants (duplicated from plugin for standalone tool)
// ═══════════════════════════════════════════════════════════════════════════

const WARN_THRESHOLD = 400;
const BLOCK_THRESHOLD = 600;

const TEST_FILE_PATTERNS = [/\.spec\.ts$/, /\.test\.ts$/, /\.spec\.js$/, /\.test\.js$/, /\.e2e-spec\.ts$/];

const SKIP_TEST_PATTERNS = [
  /\.module\.ts$/, /\.dto\.ts$/, /\.entity\.ts$/, /\.interface\.ts$/,
  /\.enum\.ts$/, /\.constant\.ts$/, /\.config\.ts$/, /\.model\.ts$/,
  /index\.ts$/, /main\.ts$/, /environment\.ts$/,
];

const NEST_FILE_PATTERNS = [
  /\.controller\.ts$/, /\.service\.ts$/, /\.module\.ts$/,
  /\.guard\.ts$/, /\.interceptor\.ts$/, /\.dto\.ts$/,
  /\.entity\.ts$/, /\.pipe\.ts$/, /\.filter\.ts$/, /\.middleware\.ts$/,
];

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function getExpectedTestPaths(filePath: string): string[] {
  if (isTestFile(filePath)) return [];
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".js")) return [];
  if (SKIP_TEST_PATTERNS.some((p) => p.test(filePath))) return [];

  const ext = filePath.endsWith(".ts") ? ".ts" : ".js";
  const base = filePath.slice(0, -ext.length);
  return [`${base}.spec${ext}`, `${base}.test${ext}`];
}

function isNestFile(filePath: string): boolean {
  return NEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

interface CheckResult {
  file: string;
  issues: string[];
  passed: boolean;
}

function checkFile(filePath: string): CheckResult {
  const issues: string[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;

    // File length check
    if (lineCount > BLOCK_THRESHOLD && !isTestFile(filePath)) {
      issues.push(`BLOCK: File exceeds ${BLOCK_THRESHOLD} lines (${lineCount})`);
    } else if (lineCount > WARN_THRESHOLD && !isTestFile(filePath)) {
      issues.push(`WARN: File has ${lineCount} lines (threshold: ${WARN_THRESHOLD})`);
    }

    // NestJS patterns
    if (isNestFile(filePath)) {
      if (filePath.endsWith(".controller.ts") && !content.includes("@ApiTags")) {
        issues.push("WARN: Controller missing @ApiTags decorator");
      }
      if (filePath.endsWith(".dto.ts") && !content.includes("class-validator") && !content.match(/@Is\w+\(/)) {
        issues.push("WARN: DTO missing class-validator decorators");
      }
      if (filePath.endsWith(".entity.ts") && !content.includes("@Entity") && !content.includes("@model")) {
        issues.push("WARN: Entity missing ORM decorator");
      }
    }

    // TDD check
    if (!isTestFile(filePath)) {
      const testPaths = getExpectedTestPaths(filePath);
      if (testPaths.length > 0 && !testPaths.some((tp) => existsSync(tp))) {
        issues.push(`INFO: No companion test file (expected: ${testPaths[0]})`);
      }
    }
  } catch (e) {
    issues.push(`ERROR: Could not read file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    file: filePath,
    issues,
    passed: issues.length === 0 || issues.every((i) => i.startsWith("INFO:")),
  };
}

function findTsFiles(dir: string, maxDepth = 5): string[] {
  const files: string[] = [];

  function walk(currentDir: string, depth: number) {
    if (depth > maxDepth) return;
    if (!existsSync(currentDir)) return;

    try {
      const entries = readdirSync(currentDir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") {
          continue;
        }

        const fullPath = join(currentDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (stat.isFile()) {
            const ext = entry.slice(entry.lastIndexOf("."));
            if (TS_EXTENSIONS.includes(ext)) {
              files.push(fullPath);
            }
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

// ═══════════════════════════════════════════════════════════════════════════
// Tool Definition
// ═══════════════════════════════════════════════════════════════════════════

export default tool({
  description: "Run Sentinal quality checks on a file or directory. Checks file length, NestJS patterns, and TDD compliance.",
  args: {
    path: z.string().describe("Path to a file or directory to check. Use '.' for the entire project."),
    verbose: z.boolean().optional().describe("Show all files, including those that pass checks"),
  },
  async execute(args, context) {
    const targetPath = args.path.startsWith("/")
      ? args.path
      : join(context.directory, args.path);

    if (!existsSync(targetPath)) {
      return `Error: Path does not exist: ${targetPath}`;
    }

    const stat = statSync(targetPath);
    const results: CheckResult[] = [];

    if (stat.isFile()) {
      results.push(checkFile(targetPath));
    } else if (stat.isDirectory()) {
      const files = findTsFiles(targetPath);
      for (const file of files) {
        results.push(checkFile(file));
      }
    }

    if (results.length === 0) {
      return "No TypeScript/JavaScript files found to check.";
    }

    // Build report
    const lines: string[] = [];
    const passed = results.filter((r) => r.passed);
    const failed = results.filter((r) => !r.passed);

    lines.push(`# Sentinal Quality Check Report`);
    lines.push(``);
    lines.push(`**Checked:** ${results.length} files`);
    lines.push(`**Passed:** ${passed.length}`);
    lines.push(`**Issues:** ${failed.length}`);
    lines.push(``);

    if (failed.length > 0) {
      lines.push(`## Files with Issues`);
      lines.push(``);
      for (const result of failed) {
        const relPath = relative(context.directory, result.file);
        lines.push(`### ${relPath}`);
        for (const issue of result.issues) {
          lines.push(`- ${issue}`);
        }
        lines.push(``);
      }
    }

    if (args.verbose && passed.length > 0) {
      lines.push(`## Passed Files`);
      lines.push(``);
      for (const result of passed) {
        const relPath = relative(context.directory, result.file);
        lines.push(`- ${relPath}`);
      }
      lines.push(``);
    }

    if (failed.length === 0) {
      lines.push(`All checks passed!`);
    }

    return lines.join("\n");
  },
});
