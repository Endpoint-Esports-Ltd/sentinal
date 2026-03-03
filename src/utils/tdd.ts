const TEST_FILE_PATTERNS = [/\.spec\.ts$/, /\.test\.ts$/, /\.spec\.js$/, /\.test\.js$/];
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

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function getExpectedTestPaths(filePath: string): string[] {
  if (isTestFile(filePath)) return [];
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".js")) return [];
  if (SKIP_TEST_PATTERNS.some((p) => p.test(filePath))) return [];

  const ext = filePath.endsWith(".ts") ? ".ts" : ".js";
  const base = filePath.slice(0, -ext.length);
  return [`${base}.spec${ext}`, `${base}.test${ext}`];
}

export function isTrivialEdit(content: string): boolean {
  const lines = content.trim().split("\n");
  return lines.every(
    (line) =>
      line.trim() === "" ||
      line.trim().startsWith("import ") ||
      line.trim().startsWith("export ") ||
      line.trim().startsWith("//") ||
      line.trim().startsWith("/*") ||
      line.trim().startsWith("*"),
  );
}
