/**
 * Analysis Helpers
 *
 * Shared utilities for the analysis MCP tools:
 *   - Parsing tsc output
 *   - Extracting spec file paths from plan files
 *   - File line counting
 *   - Import counting via grep
 *   - Project hash for cache keys
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- Types ---

export interface DiagnosticError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface DiagnosticsBaseline {
  timestamp: number;
  errorCount: number;
  errors: DiagnosticError[];
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface ChangedFile {
  path: string;
  relPath: string;
  isExpected: boolean;
  lineCount: number;
  overLimit: boolean;
  importerCount: number;
}

// --- Helpers ---

/**
 * Simple project hash for cache keys.
 * Uses base64 of the project path, truncated to 16 chars.
 */
export function projectHash(projectPath: string): string {
  return Buffer.from(projectPath).toString("base64").slice(0, 16);
}

/**
 * Parse tsc --noEmit --pretty false output into structured errors.
 * Format: "path/to/file.ts(line,col): error TSxxxx: message"
 */
export function parseTscOutput(output: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  const lineRe = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+: .+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(output)) !== null) {
    errors.push({
      file: match[1].trim(),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: match[4].trim(),
    });
  }
  return errors;
}

/**
 * Extract all file paths mentioned in a plan file.
 * Looks for "- Modify:", "- Create:", "- Delete:", etc. lines in the
 * Implementation Tasks section.
 * Reads the plan file directly since SpecTask.description doesn't capture
 * the **Files:** block in the current parser.
 */
export function extractSpecFiles(planFilePath: string): Set<string> {
  const files = new Set<string>();
  if (!existsSync(planFilePath)) return files;

  try {
    const content = readFileSync(planFilePath, "utf-8");
    const fileRe = /^-\s+(?:Modify|Create|Delete|Rename|Add|Update):\s*(.+)$/gim;
    let match: RegExpExecArray | null;
    while ((match = fileRe.exec(content)) !== null) {
      // Normalize: strip leading ./ and trailing whitespace, strip inline comments
      const raw = match[1].trim().split(" ")[0].replace(/^\.\//, "");
      if (raw.length > 0) files.add(raw);
    }
  } catch {
    // File unreadable — return empty set
  }
  return files;
}

/**
 * Count lines in a file. Returns 0 if file doesn't exist.
 */
export function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Check if a changed file path matches any spec task file.
 * Uses suffix matching: "src/auth/auth.service.ts" matches "auth.service.ts"
 * or "src/auth/auth.service.ts" but NOT "other.ts" or "auth.other.ts".
 */
export function isExpectedFile(relPath: string, specFiles: Set<string>): boolean {
  if (specFiles.size === 0) return true; // No spec — all files are "expected"
  const normalized = relPath.replace(/^\.\//, "");
  return [...specFiles].some((sf) => {
    const sfNorm = sf.replace(/^\.\//, "");
    return normalized.endsWith(sfNorm) || sfNorm.endsWith(normalized);
  });
}

/**
 * Count how many TypeScript files import from the given file.
 * Uses grep for a quick approximation.
 */
export async function countImporters(relPath: string, project: string): Promise<number> {
  const baseName = relPath.replace(/\.[^.]+$/, "").replace(/^.*\//, "");
  try {
    const proc = Bun.spawn(
      ["grep", "-rl", `from.*${baseName}`, "--include=*.ts", "--include=*.tsx", "src"],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const output = await proc.stdout.text();
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    // Exclude the file itself
    return lines.filter((l) => !l.includes(relPath)).length;
  } catch {
    return 0;
  }
}

/**
 * Count unique files in a list of DiagnosticErrors.
 */
export function countUniqueFiles(errors: DiagnosticError[]): number {
  return new Set(errors.map((e) => e.file)).size;
}
