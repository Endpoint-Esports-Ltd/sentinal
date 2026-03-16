import { existsSync, readFileSync } from "node:fs";
import { readStdin, hint, output } from "../utils/hook-output.js";
import { checkFileLength } from "../utils/file-length.js";
import { getExpectedTestPaths, isTestFile } from "../utils/tdd.js";
import { detectFramework } from "../checkers/detect.js";
import { isAngularFile, runAngularChecks } from "../checkers/angular.js";
import { isNestFile, checkNestPatterns } from "../checkers/nestjs.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];
const ALL_CODE_EXTENSIONS = [
  ...TS_EXTENSIONS,
  ".go",
  ".py",
  ".rs",
  ".c",
  ".cpp",
];

export async function processFileCheck(
  filePath: string,
  cwd: string,
): Promise<string | null> {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (!ALL_CODE_EXTENSIONS.includes(ext)) return null;

  const isTs = TS_EXTENSIONS.includes(ext);
  const messages: string[] = [];

  // File length check (all languages)
  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    const lengthResult = checkFileLength(filePath, lineCount);
    if (lengthResult) messages.push(lengthResult.message);

    // NestJS checks (TS only)
    if (isTs && isNestFile(filePath)) {
      const nestResults = checkNestPatterns(filePath, content);
      for (const r of nestResults) messages.push(`[NestJS] ${r.message}`);
    }
  } catch {
    /* File might not exist yet during Write */
  }

  // Companion test check (all languages)
  if (!isTestFile(filePath)) {
    const testPaths = getExpectedTestPaths(filePath);
    if (testPaths.length > 0 && !testPaths.some((tp) => existsSync(tp))) {
      messages.push(
        `No companion test file found. Expected one of: ${testPaths.join(", ")}`,
      );
    }
  }

  // Angular structural checks (pattern detection, not subprocess quality checks)
  if (isTs) {
    const frameworks = detectFramework(cwd);
    if (frameworks.includes("angular") && isAngularFile(filePath)) {
      for (const r of runAngularChecks(cwd))
        messages.push(`[Angular] ${r.message}`);
    }
  }

  // NOTE: tsc, eslint, and prettier are now on-demand only via quality_report MCP tool.
  // They no longer run automatically on every edit.

  return messages.length === 0 ? null : messages.join("\n");
}

async function main(): Promise<void> {
  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath =
    (toolInput?.file_path as string) ?? (toolInput?.path as string);
  if (!filePath) return;
  const result = await processFileCheck(filePath, input.cwd);
  if (result) output(hint("PostToolUse", result));
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(String(err));
    process.exit(1);
  });
}
