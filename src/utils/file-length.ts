const WARN_THRESHOLD = 400;
const BLOCK_THRESHOLD = 600;
const TEST_PATTERNS = [/\.spec\.ts$/, /\.test\.ts$/, /\.e2e-spec\.ts$/, /\.spec\.js$/, /\.test\.js$/];

export interface FileLengthResult {
  severity: "warn" | "block";
  message: string;
}

export function checkFileLength(
  filePath: string,
  lineCount: number,
): FileLengthResult | null {
  if (TEST_PATTERNS.some((p) => p.test(filePath))) {
    return null;
  }

  if (lineCount >= BLOCK_THRESHOLD) {
    return {
      severity: "block",
      message: `File is ${lineCount} lines (limit: ${BLOCK_THRESHOLD}). Refactor into smaller modules before continuing.`,
    };
  }

  if (lineCount >= WARN_THRESHOLD) {
    return {
      severity: "warn",
      message: `File is ${lineCount} lines (soft limit: ${WARN_THRESHOLD}). Consider splitting into smaller modules.`,
    };
  }

  return null;
}
