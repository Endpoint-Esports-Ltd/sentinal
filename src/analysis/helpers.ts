/**
 * Analysis Helpers
 *
 * Shared utilities for the analysis MCP tools:
 *   - Parsing tsc output
 *   - Extracting spec file paths from plan files
 *   - File line counting
 *   - Importer counting (delegated to the parsed-import resolver in ./imports.ts)
 *   - Project hash for cache keys
 */

import { existsSync, readFileSync } from "node:fs";
import { countTransitiveImporters, type ImportGraph } from "./imports.js";

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
 * Normalize a single path token pulled out of a plan's `**Files:**` block.
 *
 * Strips surrounding backticks first, then a leading `./`. Order matters: the
 * shipped template writes every path backticked (`spec-plan.md:190-192`), so
 * stripping `./` first leaves `` `./src/a.ts` `` with the backtick in front of
 * the dot and the prefix never matches.
 *
 * Exported so a future per-task plan parser normalizes identically rather than
 * growing a second, silently divergent copy.
 */
export function normalizeSpecFilePath(token: string): string {
  return token
    .trim()
    .replace(/`/g, "")
    .replace(/^\.\//, "")
    .replace(/[,;]+$/, "")
    .trim();
}

/**
 * Extract all file paths mentioned in a plan file.
 * Looks for "- Modify:", "- Create:", "- Test:", etc. lines in the
 * Implementation Tasks section.
 * Reads the plan file directly since SpecTask.description doesn't capture
 * the **Files:** block in the current parser.
 *
 * ⛔ `Test` is not optional in this alternation. The shipped task template
 * emits `- Test: \`path\`` (`spec-plan.md:192`) and TDD guarantees every task
 * touches its own test file, so omitting the verb makes a false "modified but
 * not listed in any task's Files section" warning certain — not merely likely.
 * The omission went unnoticed only because `impact_analysis` never received a
 * spec at all in production; see `registerImpactAnalysisTool`.
 */
export function extractSpecFiles(planFilePath: string): Set<string> {
  const files = new Set<string>();
  if (!existsSync(planFilePath)) return files;

  try {
    const content = readFileSync(planFilePath, "utf-8");
    const fileRe =
      /^-\s+(?:Modify|Create|Delete|Rename|Add|Update|Test):\s*(.+)$/gim;
    let match: RegExpExecArray | null;
    while ((match = fileRe.exec(content)) !== null) {
      const value = match[1].trim();
      // Backticks delimit paths unambiguously, so when they are present take
      // every one of them: real plans write `- Modify: \`a.ts\`, \`b.ts\``,
      // and taking only the first token dropped every path after the comma.
      // Un-backticked lines keep the original first-token behaviour, which
      // also discards trailing prose and inline comments.
      const ticked = value.match(/`[^`]+`/g);
      for (const token of ticked ?? [value.split(" ")[0]]) {
        const raw = normalizeSpecFilePath(token);
        if (raw.length > 0) files.add(raw);
      }
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
export function isExpectedFile(
  relPath: string,
  specFiles: Set<string>,
): boolean {
  if (specFiles.size === 0) return true; // No spec — all files are "expected"
  const normalized = relPath.replace(/^\.\//, "");
  return [...specFiles].some((sf) => {
    const sfNorm = sf.replace(/^\.\//, "");
    return normalized.endsWith(sfNorm) || sfNorm.endsWith(normalized);
  });
}

/**
 * How many modules reach the given file, directly or transitively.
 *
 * Previously a basename grep (`grep -rl "from.*<basename>"`), which was
 * file-granular, single-hop and substring-matched — it counted barrel
 * re-exports and comments as importers while missing every transitive caller.
 * It now defers to the parsed-import resolver in `./imports.ts`.
 *
 * Pass `graph` to reuse a single graph across many files; omit it and one is
 * built for this call.
 */
export function countImporters(
  relPath: string,
  project: string,
  graph?: ImportGraph,
): number {
  try {
    return countTransitiveImporters(relPath, project, graph);
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
