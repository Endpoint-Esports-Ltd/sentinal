import { existsSync, readFileSync } from "node:fs";
import { readStdin, hint, output } from "../utils/hook-output.js";
import { checkFileLength } from "../utils/file-length.js";
import { getExpectedTestPaths, isTestFile } from "../utils/tdd.js";
import { detectPackageManager, detectFramework } from "../checkers/detect.js";
import { runTypeScriptChecks } from "../checkers/typescript.js";
import { isAngularFile, runAngularChecks } from "../checkers/angular.js";
import { isNestFile, checkNestPatterns } from "../checkers/nestjs.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

function getRunnerCommand(pm: string): string {
  return pm === "bun" ? "bunx" : "npx";
}

export async function processFileCheck(filePath: string, cwd: string): Promise<string | null> {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (!TS_EXTENSIONS.includes(ext)) return null;

  const messages: string[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    const lengthResult = checkFileLength(filePath, lineCount);
    if (lengthResult) messages.push(lengthResult.message);

    if (isNestFile(filePath)) {
      const nestResults = checkNestPatterns(filePath, content);
      for (const r of nestResults) messages.push(`[NestJS] ${r.message}`);
    }
  } catch { /* File might not exist yet during Write */ }

  if (!isTestFile(filePath)) {
    const testPaths = getExpectedTestPaths(filePath);
    if (testPaths.length > 0 && !testPaths.some((tp) => existsSync(tp))) {
      messages.push(`No companion test file found. Expected one of: ${testPaths.join(", ")}`);
    }
  }

  const pm = detectPackageManager(cwd);
  const runner = getRunnerCommand(pm);
  const tsResults = runTypeScriptChecks(filePath, cwd, runner);
  for (const r of tsResults) {
    if (r.autoFixed) messages.push(`[${r.tool}] ${r.message}`);
    else if (r.severity === "error") messages.push(`[${r.tool}] ${r.message}`);
  }

  const frameworks = detectFramework(cwd);
  if (frameworks.includes("angular") && isAngularFile(filePath)) {
    for (const r of runAngularChecks(cwd)) messages.push(`[Angular] ${r.message}`);
  }

  return messages.length === 0 ? null : messages.join("\n");
}

async function main(): Promise<void> {
  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath = (toolInput?.file_path as string) ?? (toolInput?.path as string);
  if (!filePath) return;
  const result = await processFileCheck(filePath, input.cwd);
  if (result) output(hint("PostToolUse", result));
}

if (import.meta.main) {
  main().catch((err) => { process.stderr.write(String(err)); process.exit(1); });
}
