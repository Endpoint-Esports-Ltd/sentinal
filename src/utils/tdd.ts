import { basename, dirname, join } from "node:path";

// ─── Test File Patterns ─────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  // TypeScript / JavaScript
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.js$/,
  /\.test\.js$/,
  /\.spec\.tsx$/,
  /\.test\.tsx$/,
  /\.spec\.jsx$/,
  /\.test\.jsx$/,
  // Go
  /_test\.go$/,
  // Python
  /(^|[/\\])test_[^/\\]+\.py$/,
  /_test\.py$/,
  // Rust
  /_test\.rs$/,
  // C
  /(^|[/\\])test_[^/\\]+\.c$/,
  /_test\.c$/,
  // C++
  /(^|[/\\])test_[^/\\]+\.cpp$/,
  /_test\.cpp$/,
];

// ─── Skip Patterns (files that don't need standalone tests) ─────────────────

const SKIP_TEST_PATTERNS = [
  // TypeScript / NestJS convention files
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
  // Python
  /__init__\.py$/,
  /conftest\.py$/,
  /setup\.py$/,
  // Rust
  /(^|[/\\])mod\.rs$/,
  /(^|[/\\])lib\.rs$/,
  // Go (config files — NOT main.go, which has real logic)
  /go\.mod$/,
  /go\.sum$/,
  // Build files
  /(^|[/\\])Makefile$/,
  /CMakeLists\.txt$/,
];

// ─── Implementation Extensions (files the TDD guard can protect) ────────────

const IMPL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".rs", ".c", ".cpp"];

// ─── Public API ─────────────────────────────────────────────────────────────

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function shouldSkipTddGuard(filePath: string): boolean {
  return SKIP_TEST_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Returns true if a file is a guardable implementation file:
 * has a supported extension, is not a test file, and is not skipped.
 */
export function isGuardedFile(filePath: string): boolean {
  const ext = IMPL_EXTENSIONS.find((e) => filePath.endsWith(e));
  if (!ext) return false;
  if (isTestFile(filePath)) return false;
  if (shouldSkipTddGuard(filePath)) return false;
  return true;
}

/**
 * Generate expected companion test file paths for an implementation file.
 * Returns [] if the file is a test file, non-code, or skipped.
 *
 * Language conventions:
 * - TS/JS:    foo.ts  → [foo.spec.ts, foo.test.ts]
 * - Go:       foo.go  → [foo_test.go]
 * - Python:   foo.py  → [dir/test_foo.py, foo_test.py]
 * - Rust:     foo.rs  → [foo_test.rs]
 * - C:        foo.c   → [dir/test_foo.c, foo_test.c]
 * - C++:      foo.cpp → [dir/test_foo.cpp, foo_test.cpp]
 */
export function getExpectedTestPaths(filePath: string): string[] {
  if (isTestFile(filePath)) return [];

  const ext = IMPL_EXTENSIONS.find((e) => filePath.endsWith(e));
  if (!ext) return [];
  if (shouldSkipTddGuard(filePath)) return [];

  const base = filePath.slice(0, -ext.length);
  const dir = dirname(filePath);
  const name = basename(filePath, ext);

  switch (ext) {
    // TS/JS: foo.ts → foo.spec.ts, foo.test.ts
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
      return [`${base}.spec${ext}`, `${base}.test${ext}`];

    // Go: foo.go → foo_test.go
    case ".go":
      return [`${base}_test${ext}`];

    // Python: foo.py → test_foo.py, foo_test.py
    case ".py":
      return [join(dir, `test_${name}${ext}`), `${base}_test${ext}`];

    // Rust: foo.rs → foo_test.rs
    case ".rs":
      return [`${base}_test${ext}`];

    // C/C++: foo.c → test_foo.c, foo_test.c
    case ".c":
    case ".cpp":
      return [join(dir, `test_${name}${ext}`), `${base}_test${ext}`];

    default:
      return [];
  }
}

/**
 * Given a test file path, return the expected implementation file path.
 *
 * Handles:
 * - TS/JS: foo.test.ts → foo.ts, foo.spec.ts → foo.ts
 * - Go:    foo_test.go → foo.go
 * - Python: test_foo.py → foo.py (prefix), foo_test.py → foo.py (suffix)
 * - Rust:  foo_test.rs → foo.rs
 * - C/C++: test_foo.c → foo.c (prefix), foo_test.c → foo.c (suffix)
 *
 * Returns null if the mapping can't be determined.
 */
export function getImplPathForTest(testFilePath: string): string | null {
  // TS/JS: foo.spec.ts → foo.ts, foo.test.tsx → foo.tsx
  const tsMatch = testFilePath.match(/^(.+)\.(spec|test)\.(ts|tsx|js|jsx)$/);
  if (tsMatch) {
    return `${tsMatch[1]}.${tsMatch[3]}`;
  }

  // Go: foo_test.go → foo.go
  const goMatch = testFilePath.match(/^(.+)_test\.go$/);
  if (goMatch) {
    return `${goMatch[1]}.go`;
  }

  // Suffix convention: foo_test.py → foo.py, foo_test.rs → foo.rs, foo_test.c → foo.c
  const suffixMatch = testFilePath.match(/^(.+)_test\.(py|rs|c|cpp)$/);
  if (suffixMatch) {
    return `${suffixMatch[1]}.${suffixMatch[2]}`;
  }

  // Prefix convention: dir/test_foo.py → dir/foo.py, dir/test_foo.c → dir/foo.c
  const prefixMatch = testFilePath.match(/^(.*[/\\])?test_([^/\\]+)\.(py|c|cpp)$/);
  if (prefixMatch) {
    const dir = prefixMatch[1] ?? "";
    return `${dir}${prefixMatch[2]}.${prefixMatch[3]}`;
  }

  return null;
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
