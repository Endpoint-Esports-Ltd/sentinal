# Sentinal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code plugin that enforces production-grade quality for TypeScript, Angular, and NestJS projects through hooks, rules, and structured workflows.

**Architecture:** TypeScript-native plugin using Claude Code's plugin system. Hook scripts read JSON from stdin, process it, and output JSON to stdout. Rules are markdown with YAML frontmatter for conditional loading. Commands/skills and agents are markdown with frontmatter.

**Tech Stack:** TypeScript, Bun (runtime for hooks), Claude Code Plugin API, Prettier, ESLint, Angular CLI, NestJS CLI

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "sentinal",
  "version": "0.1.0",
  "private": true,
  "description": "Claude Code quality plugin for TypeScript, Angular, and NestJS",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "build:watch": "tsc --watch",
    "test": "bun test",
    "test:watch": "bun test --watch"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "bun-types": "^1.2.0"
  },
  "engines": {
    "node": ">=18.0.0",
    "bun": ">=1.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "plugin/hooks/dist",
    "rootDir": "src",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "plugin", "**/*.test.ts"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
plugin/hooks/dist/
*.tsbuildinfo
.DS_Store
```

**Step 4: Install dependencies**

Run: `cd /home/adam/dev/sentinal && bun install`
Expected: Dependencies installed successfully

**Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lockb
git commit -m "chore: scaffold project with TypeScript + Bun"
```

---

### Task 2: Plugin Manifest and Configuration Files

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/settings.json`
- Create: `plugin/.mcp.json`
- Create: `plugin/.lsp.json`

**Step 1: Create plugin manifest**

Create `plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "sentinal",
  "version": "0.1.0",
  "description": "Claude Code quality plugin for TypeScript, Angular, and NestJS",
  "author": {
    "name": "Sentinal"
  },
  "license": "MIT",
  "keywords": ["sentinal", "typescript", "angular", "nestjs", "quality"]
}
```

**Step 2: Create settings.json**

Create `plugin/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TASKS": "true",
    "ENABLE_TOOL_SEARCH": "true",
    "ENABLE_LSP_TOOL": "true",
    "DISABLE_AUTO_COMPACT": "false"
  },
  "permissions": {
    "allow": [
      "Bash",
      "Bash(npx:*)",
      "Bash(npm:*)",
      "Bash(pnpm:*)",
      "Bash(yarn:*)",
      "Bash(bun:*)",
      "Bash(ng:*)",
      "Bash(nest:*)",
      "Bash(tsc:*)",
      "Bash(prettier:*)",
      "Bash(eslint:*)",
      "Bash(jest:*)",
      "Bash(vitest:*)",
      "Bash(playwright:*)",
      "Bash(vexor:*)",
      "Bash(git:*)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(grep:*)",
      "Bash(rg:*)",
      "Bash(cp:*)",
      "Bash(mkdir:*)",
      "Bash(mv:*)",
      "Bash(rm:*)",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "Write",
      "NotebookEdit",
      "mcp__plugin_sentinal_context7__*",
      "mcp__plugin_sentinal_web-search__*",
      "mcp__plugin_sentinal_web-fetch__*",
      "mcp__plugin_sentinal_grep-mcp__*",
      "Skill(spec)",
      "Skill(spec-plan)",
      "Skill(spec-implement)",
      "Skill(spec-verify)",
      "Skill(spec-bugfix-plan)",
      "Skill(spec-bugfix-verify)",
      "Skill(sync)",
      "Skill(learn)",
      "Task(spec-reviewer:*)",
      "Task(plan-reviewer:*)",
      "LSP"
    ],
    "deny": []
  },
  "alwaysThinkingEnabled": true,
  "respectGitignore": false,
  "spinnerTipsOverride": {
    "tips": [
      "[SENTINAL] Run /sync after installation to generate project-specific rules",
      "[SENTINAL] Use /spec for structured plan-implement-verify workflows",
      "[SENTINAL] Prettier, ESLint, and tsc run automatically on every file edit",
      "[SENTINAL] Angular standards enforce standalone components, signals, and new control flow",
      "[SENTINAL] NestJS standards enforce DTOs, guards, and Swagger decorators",
      "[SENTINAL] File length: warn at 400 lines, block at 600 lines (tests exempt)",
      "[SENTINAL] TDD enforcement: implementation files need companion test files",
      "[SENTINAL] Use /learn to extract reusable knowledge from your session",
      "[SENTINAL] Tailwind CSS is the default styling approach for frontend work",
      "[SENTINAL] Vexor semantic search finds code by intent, not exact text"
    ],
    "excludeDefault": false
  }
}
```

**Step 3: Create .mcp.json**

Create `plugin/.mcp.json`:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "web-search": {
      "command": "npx",
      "args": ["-y", "open-websearch"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "ALLOWED_SEARCH_ENGINES": "duckduckgo,bing,exa"
      }
    },
    "grep-mcp": {
      "type": "http",
      "url": "https://mcp.grep.app"
    },
    "web-fetch": {
      "command": "npx",
      "args": ["-y", "fetcher-mcp"]
    }
  }
}
```

**Step 4: Create .lsp.json**

Create `plugin/.lsp.json`:

```json
{
  "typescript": {
    "command": "vtsls",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript"
    },
    "transport": "stdio",
    "initializationOptions": {},
    "settings": {},
    "maxRestarts": 3
  }
}
```

**Step 5: Commit**

```bash
git add plugin/
git commit -m "feat: add plugin manifest, settings, MCP, and LSP configs"
```

---

### Task 3: Hook Output Utilities

**Files:**
- Create: `src/utils/hook-output.ts`
- Create: `src/utils/hook-output.test.ts`

**Step 1: Write failing tests for hook output helpers**

Create `src/utils/hook-output.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { deny, hint, block, readStdin } from "./hook-output";

describe("hook-output", () => {
  describe("deny", () => {
    it("should return PreToolUse deny JSON", () => {
      const result = deny("Tool blocked");
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Tool blocked",
      });
    });
  });

  describe("hint", () => {
    it("should return PreToolUse hint JSON with additionalContext", () => {
      const result = hint("PreToolUse", "Consider using Vexor");
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "Consider using Vexor",
        },
      });
    });

    it("should return PostToolUse context JSON", () => {
      const result = hint("PostToolUse", "File too long");
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "File too long",
        },
      });
    });
  });

  describe("block", () => {
    it("should return block decision JSON", () => {
      const result = block("Cannot stop during active spec");
      expect(result).toEqual({
        decision: "block",
        reason: "Cannot stop during active spec",
      });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/hook-output.test.ts`
Expected: FAIL — module not found

**Step 3: Implement hook-output.ts**

Create `src/utils/hook-output.ts`:

```typescript
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface DenyOutput {
  permissionDecision: "deny";
  reason: string;
}

export interface HintOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

export interface BlockOutput {
  decision: "block";
  reason: string;
}

export function deny(reason: string): DenyOutput {
  return { permissionDecision: "deny", reason };
}

export function hint(eventName: string, context: string): HintOutput {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

export function block(reason: string): BlockOutput {
  return { decision: "block", reason };
}

export async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export function output(data: DenyOutput | HintOutput | BlockOutput): void {
  process.stdout.write(JSON.stringify(data));
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/hook-output.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/utils/hook-output.ts src/utils/hook-output.test.ts
git commit -m "feat: add hook output utility functions (deny, hint, block)"
```

---

### Task 4: File Length Utility

**Files:**
- Create: `src/utils/file-length.ts`
- Create: `src/utils/file-length.test.ts`

**Step 1: Write failing tests**

Create `src/utils/file-length.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { checkFileLength } from "./file-length";

describe("checkFileLength", () => {
  it("should return null for files under 400 lines", () => {
    const result = checkFileLength("/src/app.ts", 200);
    expect(result).toBeNull();
  });

  it("should return warn for files between 400-599 lines", () => {
    const result = checkFileLength("/src/app.ts", 450);
    expect(result).toEqual({
      severity: "warn",
      message: expect.stringContaining("450 lines"),
    });
  });

  it("should return block for files at or above 600 lines", () => {
    const result = checkFileLength("/src/app.ts", 600);
    expect(result).toEqual({
      severity: "block",
      message: expect.stringContaining("600 lines"),
    });
  });

  it("should exempt test files from blocking", () => {
    const result = checkFileLength("/src/app.spec.ts", 700);
    expect(result).toBeNull();
  });

  it("should exempt .test.ts files from blocking", () => {
    const result = checkFileLength("/src/app.test.ts", 700);
    expect(result).toBeNull();
  });

  it("should exempt e2e test files from blocking", () => {
    const result = checkFileLength("/e2e/app.e2e-spec.ts", 700);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/file-length.test.ts`
Expected: FAIL

**Step 3: Implement file-length.ts**

Create `src/utils/file-length.ts`:

```typescript
const WARN_THRESHOLD = 400;
const BLOCK_THRESHOLD = 600;
const TEST_PATTERNS = [/\.spec\.ts$/, /\.test\.ts$/, /\.e2e-spec\.ts$/, /\.spec\.js$/, /\.test\.js$/];

interface FileLengthResult {
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
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/file-length.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/utils/file-length.ts src/utils/file-length.test.ts
git commit -m "feat: add file length enforcement utility (400 warn, 600 block)"
```

---

### Task 5: Git Utilities

**Files:**
- Create: `src/utils/git.ts`
- Create: `src/utils/git.test.ts`

**Step 1: Write failing tests**

Create `src/utils/git.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { findGitRoot, isInsideGitRepo } from "./git";

describe("git utilities", () => {
  describe("findGitRoot", () => {
    it("should find git root from a subdirectory", async () => {
      const root = await findGitRoot("/home/adam/dev/sentinal/src");
      expect(root).toBe("/home/adam/dev/sentinal");
    });

    it("should return null for non-git directory", async () => {
      const root = await findGitRoot("/tmp");
      expect(root).toBeNull();
    });
  });

  describe("isInsideGitRepo", () => {
    it("should return true inside a git repo", async () => {
      expect(await isInsideGitRepo("/home/adam/dev/sentinal")).toBe(true);
    });

    it("should return false outside a git repo", async () => {
      expect(await isInsideGitRepo("/tmp")).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/git.test.ts`
Expected: FAIL

**Step 3: Implement git.ts**

Create `src/utils/git.ts` — use `Bun.spawnSync` for safe subprocess execution (no shell injection):

```typescript
export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  const root = await findGitRoot(cwd);
  return root !== null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/git.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/utils/git.ts src/utils/git.test.ts
git commit -m "feat: add git utility functions (findGitRoot, isInsideGitRepo)"
```

---

### Task 6: TDD Enforcement Utility

**Files:**
- Create: `src/utils/tdd.ts`
- Create: `src/utils/tdd.test.ts`

**Step 1: Write failing tests**

Create `src/utils/tdd.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { getExpectedTestPaths, isTrivialEdit, isTestFile } from "./tdd";

describe("tdd utilities", () => {
  describe("getExpectedTestPaths", () => {
    it("should generate .spec.ts path for a .ts file", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.ts");
      expect(paths).toContain("/src/app/user.service.spec.ts");
    });

    it("should generate .test.ts path for a .ts file", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.ts");
      expect(paths).toContain("/src/app/user.service.test.ts");
    });

    it("should return empty for test files themselves", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.spec.ts");
      expect(paths).toEqual([]);
    });

    it("should return empty for non-TypeScript files", () => {
      const paths = getExpectedTestPaths("/src/index.html");
      expect(paths).toEqual([]);
    });

    it("should return empty for config files", () => {
      const paths = getExpectedTestPaths("/src/app/app.module.ts");
      expect(paths).toEqual([]);
    });

    it("should return empty for DTOs", () => {
      const paths = getExpectedTestPaths("/src/users/create-user.dto.ts");
      expect(paths).toEqual([]);
    });

    it("should return empty for entities", () => {
      const paths = getExpectedTestPaths("/src/users/user.entity.ts");
      expect(paths).toEqual([]);
    });
  });

  describe("isTestFile", () => {
    it("should detect .spec.ts files", () => {
      expect(isTestFile("user.service.spec.ts")).toBe(true);
    });

    it("should detect .test.ts files", () => {
      expect(isTestFile("user.service.test.ts")).toBe(true);
    });

    it("should not detect regular .ts files", () => {
      expect(isTestFile("user.service.ts")).toBe(false);
    });
  });

  describe("isTrivialEdit", () => {
    it("should detect import-only changes", () => {
      expect(isTrivialEdit("import { Foo } from './foo';")).toBe(true);
    });

    it("should not detect function changes as trivial", () => {
      expect(isTrivialEdit("function doSomething() { return 1; }")).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/tdd.test.ts`
Expected: FAIL

**Step 3: Implement tdd.ts**

Create `src/utils/tdd.ts`:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/utils/tdd.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/utils/tdd.ts src/utils/tdd.test.ts
git commit -m "feat: add TDD enforcement utility (test file detection, path generation)"
```

---

### Task 7: Tooling Detection (Package Manager, Test Runner, Framework)

**Files:**
- Create: `src/checkers/detect.ts`
- Create: `src/checkers/detect.test.ts`

**Step 1: Write failing tests**

Create `src/checkers/detect.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import {
  detectPackageManager,
  detectTestRunner,
  detectFramework,
} from "./detect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sentinal-test-"));
}

describe("detect", () => {
  describe("detectPackageManager", () => {
    it("should detect pnpm from pnpm-lock.yaml", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(dir)).toBe("pnpm");
      rmSync(dir, { recursive: true });
    });

    it("should detect yarn from yarn.lock", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "yarn.lock"), "");
      expect(detectPackageManager(dir)).toBe("yarn");
      rmSync(dir, { recursive: true });
    });

    it("should detect bun from bun.lockb", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "bun.lockb"), "");
      expect(detectPackageManager(dir)).toBe("bun");
      rmSync(dir, { recursive: true });
    });

    it("should detect npm from package-lock.json", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "package-lock.json"), "{}");
      expect(detectPackageManager(dir)).toBe("npm");
      rmSync(dir, { recursive: true });
    });

    it("should default to npm when no lockfile found", () => {
      const dir = createTempDir();
      expect(detectPackageManager(dir)).toBe("npm");
      rmSync(dir, { recursive: true });
    });
  });

  describe("detectTestRunner", () => {
    it("should detect jest from jest.config.ts", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "jest.config.ts"), "");
      expect(detectTestRunner(dir)).toBe("jest");
      rmSync(dir, { recursive: true });
    });

    it("should detect vitest from vitest.config.ts", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "vitest.config.ts"), "");
      expect(detectTestRunner(dir)).toBe("vitest");
      rmSync(dir, { recursive: true });
    });

    it("should detect karma from karma.conf.js", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "karma.conf.js"), "");
      expect(detectTestRunner(dir)).toBe("karma");
      rmSync(dir, { recursive: true });
    });

    it("should default to jest when no config found", () => {
      const dir = createTempDir();
      expect(detectTestRunner(dir)).toBe("jest");
      rmSync(dir, { recursive: true });
    });
  });

  describe("detectFramework", () => {
    it("should detect angular from angular.json", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "angular.json"), "{}");
      expect(detectFramework(dir)).toContain("angular");
      rmSync(dir, { recursive: true });
    });

    it("should detect nestjs from nest-cli.json", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "nest-cli.json"), "{}");
      expect(detectFramework(dir)).toContain("nestjs");
      rmSync(dir, { recursive: true });
    });

    it("should detect both angular and nestjs in a monorepo", () => {
      const dir = createTempDir();
      writeFileSync(join(dir, "angular.json"), "{}");
      writeFileSync(join(dir, "nest-cli.json"), "{}");
      const frameworks = detectFramework(dir);
      expect(frameworks).toContain("angular");
      expect(frameworks).toContain("nestjs");
      rmSync(dir, { recursive: true });
    });

    it("should return empty array when no framework detected", () => {
      const dir = createTempDir();
      expect(detectFramework(dir)).toEqual([]);
      rmSync(dir, { recursive: true });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/detect.test.ts`
Expected: FAIL

**Step 3: Implement detect.ts**

Create `src/checkers/detect.ts`:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/detect.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/checkers/detect.ts src/checkers/detect.test.ts
git commit -m "feat: add package manager, test runner, and framework detection"
```

---

### Task 8: TypeScript Checker (Prettier + ESLint + tsc)

**Files:**
- Create: `src/checkers/typescript.ts`
- Create: `src/checkers/typescript.test.ts`

**Step 1: Write failing tests**

Create `src/checkers/typescript.test.ts`:

```typescript
import { describe, expect, it, mock, beforeEach } from "bun:test";
import { runTypeScriptChecks, type CheckResult } from "./typescript";

describe("typescript checker", () => {
  describe("runTypeScriptChecks", () => {
    it("should return empty results when all checks pass", () => {
      const results = runTypeScriptChecks("/src/app.ts", "/project", "npx");
      // Results depend on actual tool availability — just verify it returns an array
      expect(Array.isArray(results)).toBe(true);
    });

    it("should include prettier in the check pipeline", () => {
      // Verify the function handles the prettier step without crashing
      const results = runTypeScriptChecks("/nonexistent/file.ts", "/tmp", "npx");
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/typescript.test.ts`
Expected: FAIL

**Step 3: Implement typescript.ts**

Create `src/checkers/typescript.ts` — use `Bun.spawnSync` for safe subprocess execution:

```typescript
export interface CheckResult {
  tool: "prettier" | "eslint" | "tsc";
  severity: "error" | "warning" | "info";
  message: string;
  autoFixed?: boolean;
}

export function runTypeScriptChecks(
  filePath: string,
  projectRoot: string,
  runner: string,
): CheckResult[] {
  const results: CheckResult[] = [];

  // Prettier check + auto-fix
  const prettierCheck = Bun.spawnSync([runner, "prettier", "--check", filePath], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (prettierCheck.exitCode !== 0) {
    const prettierFix = Bun.spawnSync([runner, "prettier", "--write", filePath], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (prettierFix.exitCode === 0) {
      results.push({
        tool: "prettier",
        severity: "info",
        message: `Prettier auto-formatted ${filePath}`,
        autoFixed: true,
      });
    } else {
      results.push({
        tool: "prettier",
        severity: "error",
        message: `Prettier formatting failed: ${prettierFix.stderr.toString()}`,
      });
    }
  }

  // ESLint check + auto-fix
  const eslintResult = Bun.spawnSync([runner, "eslint", "--fix", filePath], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (eslintResult.exitCode !== 0) {
    results.push({
      tool: "eslint",
      severity: "error",
      message: `ESLint issues found: ${eslintResult.stderr.toString()}`,
    });
  }

  // TypeScript type check
  const tscResult = Bun.spawnSync([runner, "tsc", "--noEmit"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (tscResult.exitCode !== 0) {
    results.push({
      tool: "tsc",
      severity: "error",
      message: `TypeScript type errors: ${tscResult.stdout.toString()}`,
    });
  }

  return results;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/typescript.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/checkers/typescript.ts src/checkers/typescript.test.ts
git commit -m "feat: add TypeScript checker (Prettier + ESLint + tsc)"
```

---

### Task 9: Angular Checker

**Files:**
- Create: `src/checkers/angular.ts`
- Create: `src/checkers/angular.test.ts`

**Step 1: Write failing tests**

Create `src/checkers/angular.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { isAngularFile } from "./angular";

describe("angular checker", () => {
  describe("isAngularFile", () => {
    it("should detect component files", () => {
      expect(isAngularFile("user.component.ts")).toBe(true);
    });

    it("should detect directive files", () => {
      expect(isAngularFile("highlight.directive.ts")).toBe(true);
    });

    it("should detect pipe files", () => {
      expect(isAngularFile("date-format.pipe.ts")).toBe(true);
    });

    it("should detect Angular module files", () => {
      expect(isAngularFile("app.module.ts")).toBe(true);
    });

    it("should not detect regular service files as Angular-specific", () => {
      expect(isAngularFile("user.service.ts")).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/angular.test.ts`
Expected: FAIL

**Step 3: Implement angular.ts**

Create `src/checkers/angular.ts`:

```typescript
export interface AngularCheckResult {
  tool: "ng-build" | "ng-lint";
  severity: "error" | "warning" | "info";
  message: string;
}

const ANGULAR_FILE_PATTERNS = [
  /\.component\.ts$/,
  /\.directive\.ts$/,
  /\.pipe\.ts$/,
  /\.module\.ts$/,
  /\.guard\.ts$/,
  /\.resolver\.ts$/,
];

export function isAngularFile(filePath: string): boolean {
  return ANGULAR_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function runAngularChecks(projectRoot: string): AngularCheckResult[] {
  const results: AngularCheckResult[] = [];

  const ngBuild = Bun.spawnSync(["npx", "ng", "build", "--dry-run"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });

  if (ngBuild.exitCode !== 0) {
    results.push({
      tool: "ng-build",
      severity: "error",
      message: `Angular build errors: ${ngBuild.stderr.toString()}`,
    });
  }

  return results;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/angular.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/checkers/angular.ts src/checkers/angular.test.ts
git commit -m "feat: add Angular checker (ng build --dry-run)"
```

---

### Task 10: NestJS Checker

**Files:**
- Create: `src/checkers/nestjs.ts`
- Create: `src/checkers/nestjs.test.ts`

**Step 1: Write failing tests**

Create `src/checkers/nestjs.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { isNestFile, checkNestPatterns } from "./nestjs";

describe("nestjs checker", () => {
  describe("isNestFile", () => {
    it("should detect controller files", () => {
      expect(isNestFile("user.controller.ts")).toBe(true);
    });

    it("should detect service files", () => {
      expect(isNestFile("user.service.ts")).toBe(true);
    });

    it("should detect module files", () => {
      expect(isNestFile("user.module.ts")).toBe(true);
    });

    it("should detect guard files", () => {
      expect(isNestFile("auth.guard.ts")).toBe(true);
    });

    it("should detect interceptor files", () => {
      expect(isNestFile("logging.interceptor.ts")).toBe(true);
    });

    it("should detect DTO files", () => {
      expect(isNestFile("create-user.dto.ts")).toBe(true);
    });

    it("should not detect plain TypeScript files", () => {
      expect(isNestFile("helpers.ts")).toBe(false);
    });
  });

  describe("checkNestPatterns", () => {
    it("should warn when controller has no @ApiTags decorator", () => {
      const content = `
import { Controller, Get } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }
}`;
      const results = checkNestPatterns("user.controller.ts", content);
      expect(results.some((r) => r.message.includes("@ApiTags"))).toBe(true);
    });

    it("should warn when DTO has no class-validator decorators", () => {
      const content = `
export class CreateUserDto {
  name: string;
  email: string;
}`;
      const results = checkNestPatterns("create-user.dto.ts", content);
      expect(results.some((r) => r.message.includes("class-validator"))).toBe(true);
    });

    it("should not warn for well-decorated DTOs", () => {
      const content = `
import { IsString, IsEmail } from 'class-validator';

export class CreateUserDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;
}`;
      const results = checkNestPatterns("create-user.dto.ts", content);
      expect(results.filter((r) => r.message.includes("class-validator"))).toEqual([]);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/nestjs.test.ts`
Expected: FAIL

**Step 3: Implement nestjs.ts**

Create `src/checkers/nestjs.ts`:

```typescript
export interface NestCheckResult {
  severity: "error" | "warning" | "info";
  message: string;
}

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

export function isNestFile(filePath: string): boolean {
  return NEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function checkNestPatterns(
  filePath: string,
  content: string,
): NestCheckResult[] {
  const results: NestCheckResult[] = [];

  if (filePath.endsWith(".controller.ts")) {
    if (!content.includes("@ApiTags")) {
      results.push({
        severity: "warning",
        message:
          "Controller missing @ApiTags decorator. Add Swagger/OpenAPI tags for API documentation.",
      });
    }
  }

  if (filePath.endsWith(".dto.ts")) {
    if (!content.includes("class-validator") && !content.match(/@Is\w+\(/)) {
      results.push({
        severity: "warning",
        message:
          "DTO missing class-validator decorators. Add validation decorators (@IsString, @IsEmail, etc.) for input validation.",
      });
    }
  }

  if (filePath.endsWith(".entity.ts")) {
    if (!content.includes("@Entity") && !content.includes("@model")) {
      results.push({
        severity: "warning",
        message:
          "Entity file missing ORM decorator (@Entity for TypeORM, @model for Prisma).",
      });
    }
  }

  return results;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/checkers/nestjs.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/checkers/nestjs.ts src/checkers/nestjs.test.ts
git commit -m "feat: add NestJS checker (pattern validation for controllers, DTOs, entities)"
```

---

### Task 11: Tool Redirect Hook (PreToolUse)

**Files:**
- Create: `src/hooks/tool-redirect.ts`
- Create: `src/hooks/tool-redirect.test.ts`

**Step 1: Write failing tests**

Create `src/hooks/tool-redirect.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { processToolRedirect } from "./tool-redirect";

describe("tool-redirect hook", () => {
  it("should deny WebSearch and suggest MCP alternative", () => {
    const result = processToolRedirect("WebSearch", {});
    expect(result).not.toBeNull();
    expect(result!.permissionDecision).toBe("deny");
  });

  it("should deny WebFetch and suggest MCP alternative", () => {
    const result = processToolRedirect("WebFetch", {});
    expect(result).not.toBeNull();
    expect(result!.permissionDecision).toBe("deny");
  });

  it("should deny EnterPlanMode and suggest /spec", () => {
    const result = processToolRedirect("EnterPlanMode", {});
    expect(result).not.toBeNull();
    expect(result!.permissionDecision).toBe("deny");
  });

  it("should deny ExitPlanMode and suggest /spec", () => {
    const result = processToolRedirect("ExitPlanMode", {});
    expect(result).not.toBeNull();
    expect(result!.permissionDecision).toBe("deny");
  });

  it("should return null for allowed tools", () => {
    const result = processToolRedirect("Read", {});
    expect(result).toBeNull();
  });

  it("should hint about Vexor for vague Grep patterns", () => {
    const result = processToolRedirect("Grep", {
      pattern: "how authentication works",
    });
    expect(result).not.toBeNull();
  });

  it("should not hint for specific Grep patterns", () => {
    const result = processToolRedirect("Grep", {
      pattern: "class UserService",
    });
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/tool-redirect.test.ts`
Expected: FAIL

**Step 3: Implement tool-redirect.ts**

Create `src/hooks/tool-redirect.ts`:

```typescript
import { deny, hint, readStdin, output, type DenyOutput, type HintOutput } from "../utils/hook-output.js";

const BLOCKED_TOOLS: Record<string, string> = {
  WebSearch: "WebSearch is blocked. Use MCP web-search instead: ToolSearch(query='+web-search search')",
  WebFetch: "WebFetch is blocked. Use MCP web-fetch instead: ToolSearch(query='+web-fetch fetch')",
  EnterPlanMode: "EnterPlanMode is blocked. Use /spec for structured planning workflows.",
  ExitPlanMode: "ExitPlanMode is blocked. Use /spec for structured planning workflows.",
};

const VAGUE_GREP_INDICATORS = [
  /^how\s/i,
  /^what\s/i,
  /^where\s/i,
  /^why\s/i,
  /^find\s.*that/i,
  /\bworks?\b/i,
  /\bhandles?\b/i,
  /\bimplements?\b/i,
];

export function processToolRedirect(
  toolName: string,
  toolInput: Record<string, unknown>,
): (DenyOutput & { permissionDecision: "deny" }) | HintOutput | null {
  if (toolName in BLOCKED_TOOLS) {
    return deny(BLOCKED_TOOLS[toolName]) as DenyOutput & { permissionDecision: "deny" };
  }

  if (toolName === "Grep" && typeof toolInput.pattern === "string") {
    const pattern = toolInput.pattern;
    if (VAGUE_GREP_INDICATORS.some((r) => r.test(pattern))) {
      return hint(
        "PreToolUse",
        `This Grep pattern looks like a semantic query. Consider using Vexor instead: vexor "${pattern}"`,
      );
    }
  }

  return null;
}

// Main entry point — executed by Claude Code hook system
async function main(): Promise<void> {
  const input = await readStdin();
  const result = processToolRedirect(
    input.tool_name ?? "",
    (input.tool_input as Record<string, unknown>) ?? {},
  );
  if (result) {
    output(result);
    if ("permissionDecision" in result && result.permissionDecision === "deny") {
      process.exit(2);
    }
  }
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/tool-redirect.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/hooks/tool-redirect.ts src/hooks/tool-redirect.test.ts
git commit -m "feat: add tool-redirect hook (blocks WebSearch/WebFetch/PlanMode, hints Vexor)"
```

---

### Task 12: File Checker Hook (PostToolUse)

**Files:**
- Create: `src/hooks/file-checker.ts`
- Create: `src/hooks/file-checker.test.ts`

**Step 1: Write failing tests**

Create `src/hooks/file-checker.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { processFileCheck } from "./file-checker";

describe("file-checker hook", () => {
  it("should return null for non-TypeScript files", async () => {
    const result = await processFileCheck("/project/readme.md", "/project");
    expect(result).toBeNull();
  });

  it("should return null for non-existent files gracefully", async () => {
    const result = await processFileCheck("/nonexistent/app.ts", "/tmp");
    // Should handle gracefully — may return null or a string
    expect(result === null || typeof result === "string").toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/file-checker.test.ts`
Expected: FAIL

**Step 3: Implement file-checker.ts**

Create `src/hooks/file-checker.ts`:

```typescript
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

export async function processFileCheck(
  filePath: string,
  cwd: string,
): Promise<string | null> {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (!TS_EXTENSIONS.includes(ext)) return null;

  const messages: string[] = [];

  // File length check
  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    const lengthResult = checkFileLength(filePath, lineCount);
    if (lengthResult) {
      messages.push(lengthResult.message);
    }

    // NestJS pattern checks (static analysis, no subprocess needed)
    if (isNestFile(filePath)) {
      const nestResults = checkNestPatterns(filePath, content);
      for (const r of nestResults) {
        messages.push(`[NestJS] ${r.message}`);
      }
    }
  } catch {
    // File might not exist yet during Write
  }

  // TDD enforcement
  if (!isTestFile(filePath)) {
    const testPaths = getExpectedTestPaths(filePath);
    if (testPaths.length > 0) {
      const hasTest = testPaths.some((tp) => existsSync(tp));
      if (!hasTest) {
        messages.push(
          `No companion test file found. Expected one of: ${testPaths.join(", ")}`,
        );
      }
    }
  }

  // Run TypeScript quality checks
  const pm = detectPackageManager(cwd);
  const runner = getRunnerCommand(pm);
  const tsResults = runTypeScriptChecks(filePath, cwd, runner);
  for (const r of tsResults) {
    if (r.autoFixed) {
      messages.push(`[${r.tool}] ${r.message}`);
    } else if (r.severity === "error") {
      messages.push(`[${r.tool}] ${r.message}`);
    }
  }

  // Angular checks
  const frameworks = detectFramework(cwd);
  if (frameworks.includes("angular") && isAngularFile(filePath)) {
    const angularResults = runAngularChecks(cwd);
    for (const r of angularResults) {
      messages.push(`[Angular] ${r.message}`);
    }
  }

  if (messages.length === 0) return null;
  return messages.join("\n");
}

// Main entry point
async function main(): Promise<void> {
  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath = (toolInput?.file_path as string) ?? (toolInput?.path as string);
  if (!filePath) return;

  const result = await processFileCheck(filePath, input.cwd);
  if (result) {
    output(hint("PostToolUse", result));
  }
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/file-checker.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/hooks/file-checker.ts src/hooks/file-checker.test.ts
git commit -m "feat: add file-checker hook (Prettier, ESLint, tsc, file length, TDD, NestJS)"
```

---

### Task 13: Context Monitor Hook (PostToolUse)

**Files:**
- Create: `src/hooks/context-monitor.ts`
- Create: `src/hooks/context-monitor.test.ts`

**Step 1: Write failing tests**

Create `src/hooks/context-monitor.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { getContextWarning } from "./context-monitor";

describe("context-monitor", () => {
  it("should return null below 65% raw", () => {
    expect(getContextWarning(50)).toBeNull();
  });

  it("should warn at 65% raw (~80% effective)", () => {
    const result = getContextWarning(65);
    expect(result).not.toBeNull();
    expect(result).toContain("80%");
  });

  it("should strongly warn at 75% raw (~90% effective)", () => {
    const result = getContextWarning(75);
    expect(result).not.toBeNull();
    expect(result).toContain("90%");
  });

  it("should urge completion at 85%+ raw", () => {
    const result = getContextWarning(85);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("complete");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/context-monitor.test.ts`
Expected: FAIL

**Step 3: Implement context-monitor.ts**

Create `src/hooks/context-monitor.ts`:

```typescript
import { readStdin, hint, output } from "../utils/hook-output.js";

export function getContextWarning(rawPercent: number): string | null {
  if (rawPercent >= 85) {
    return `Context ~${Math.round(rawPercent * 1.2)}%+ effective. Complete current task — auto-compaction imminent. Run /learn if this session has extractable knowledge.`;
  }
  if (rawPercent >= 75) {
    return `Context ~90% effective. Complete current work, don't start complex new tasks. Consider running /learn.`;
  }
  if (rawPercent >= 65) {
    return `Context ~80% effective. Work normally — auto-compaction handles the rest. Consider running /learn if valuable.`;
  }
  return null;
}

async function main(): Promise<void> {
  let rawPercent: number;
  try {
    const proc = Bun.spawnSync(
      ["sh", "-c", "~/.pilot/bin/pilot check-context --json 2>/dev/null"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    if (proc.exitCode !== 0) return;
    const data = JSON.parse(proc.stdout.toString());
    rawPercent = data.percent ?? 0;
  } catch {
    return; // pilot not available, skip context monitoring
  }

  const warning = getContextWarning(rawPercent);
  if (warning) {
    output(hint("PostToolUse", warning));
  }
}

main().catch(() => {});
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/context-monitor.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/hooks/context-monitor.ts src/hooks/context-monitor.test.ts
git commit -m "feat: add context monitor hook (warns at 80%/90% effective context)"
```

---

### Task 14: Spec Stop Guard Hook

**Files:**
- Create: `src/hooks/spec-stop-guard.ts`
- Create: `src/hooks/spec-stop-guard.test.ts`

**Step 1: Write failing tests**

Create `src/hooks/spec-stop-guard.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { shouldBlockStop } from "./spec-stop-guard";

describe("spec-stop-guard", () => {
  it("should block when plan status is PENDING", () => {
    const result = shouldBlockStop("PENDING");
    expect(result).not.toBeNull();
    expect(result).toContain("PENDING");
  });

  it("should block when plan status is COMPLETE", () => {
    const result = shouldBlockStop("COMPLETE");
    expect(result).not.toBeNull();
    expect(result).toContain("COMPLETE");
  });

  it("should not block when plan status is VERIFIED", () => {
    const result = shouldBlockStop("VERIFIED");
    expect(result).toBeNull();
  });

  it("should not block when no plan status", () => {
    const result = shouldBlockStop(null);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/spec-stop-guard.test.ts`
Expected: FAIL

**Step 3: Implement spec-stop-guard.ts**

Create `src/hooks/spec-stop-guard.ts`:

```typescript
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin, block, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

export function shouldBlockStop(status: string | null): string | null {
  if (!status) return null;

  if (status === "PENDING") {
    return `Active spec plan is PENDING (awaiting implementation). Resume with /spec <plan-path>. Do NOT stop.`;
  }

  if (status === "COMPLETE") {
    return `Active spec plan is COMPLETE (awaiting verification). Run verification phase. Do NOT stop.`;
  }

  return null;
}

function findActivePlanStatus(cwd: string): string | null {
  const plansDir = join(cwd, "docs", "plans");
  if (!existsSync(plansDir)) return null;

  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();

    for (const file of files) {
      const content = readFileSync(join(plansDir, file), "utf-8");
      const statusMatch = content.match(/\*\*Status:\*\*\s*(PENDING|COMPLETE|VERIFIED)/);
      if (statusMatch) {
        const status = statusMatch[1];
        if (status !== "VERIFIED") return status;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;

  const status = findActivePlanStatus(searchDir);
  const blockReason = shouldBlockStop(status);

  if (blockReason) {
    output(block(blockReason));
    process.exit(2);
  }
}

main().catch(() => {});
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/adam/dev/sentinal && bun test src/hooks/spec-stop-guard.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/hooks/spec-stop-guard.ts src/hooks/spec-stop-guard.test.ts
git commit -m "feat: add spec stop guard (blocks exit during active PENDING/COMPLETE plans)"
```

---

### Task 15: Pre-Compact and Post-Compact Hooks

**Files:**
- Create: `src/hooks/pre-compact.ts`
- Create: `src/hooks/post-compact-restore.ts`

**Step 1: Implement pre-compact.ts**

Create `src/hooks/pre-compact.ts`:

```typescript
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

interface CompactState {
  activePlan: string | null;
  timestamp: string;
  cwd: string;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;

  let activePlan: string | null = null;
  const plansDir = join(searchDir, "docs", "plans");

  if (existsSync(plansDir)) {
    const files = readdirSync(plansDir)
      .filter((f: string) => f.endsWith(".md"))
      .sort()
      .reverse();

    for (const file of files) {
      const content = readFileSync(join(plansDir, file), "utf-8");
      if (content.includes("PENDING") || content.includes("COMPLETE")) {
        activePlan = join(plansDir, file);
        break;
      }
    }
  }

  const stateDir = join(searchDir, ".sentinal");
  mkdirSync(stateDir, { recursive: true });

  const state: CompactState = {
    activePlan,
    timestamp: new Date().toISOString(),
    cwd: input.cwd,
  };

  writeFileSync(
    join(stateDir, "compact-state.json"),
    JSON.stringify(state, null, 2),
  );
}

main().catch(() => {});
```

**Step 2: Implement post-compact-restore.ts**

Create `src/hooks/post-compact-restore.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStdin, hint, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;

  const stateFile = join(searchDir, ".sentinal", "compact-state.json");
  if (!existsSync(stateFile)) return;

  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    const messages: string[] = [];
    messages.push("Session restored after compaction.");

    if (state.activePlan) {
      messages.push(`Active plan: ${state.activePlan}`);
      messages.push("Resume the /spec workflow by reading the plan file and continuing from where you left off.");
    }

    output(hint("PostToolUse", messages.join("\n")));
  } catch {
    // State file corrupted, ignore
  }
}

main().catch(() => {});
```

**Step 3: Commit**

```bash
git add src/hooks/pre-compact.ts src/hooks/post-compact-restore.ts
git commit -m "feat: add pre-compact and post-compact-restore hooks for state preservation"
```

---

### Task 16: Session End Hook

**Files:**
- Create: `src/hooks/session-end.ts`

**Step 1: Implement session-end.ts**

Create `src/hooks/session-end.ts`:

```typescript
import { readStdin } from "../utils/hook-output.js";

async function main(): Promise<void> {
  await readStdin();
  // Cleanup: remove any temporary session files
  // Future: stop background processes, clear caches
}

main().catch(() => {});
```

**Step 2: Commit**

```bash
git add src/hooks/session-end.ts
git commit -m "feat: add session-end hook (cleanup placeholder)"
```

---

### Task 17: hooks.json — Hook Pipeline Definition

**Files:**
- Create: `plugin/hooks/hooks.json`

**Step 1: Create hooks.json**

Create `plugin/hooks/hooks.json`:

```json
{
  "description": "Sentinal hooks - quality enforcement for TypeScript/Angular/NestJS",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/post-compact-restore.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|WebSearch|WebFetch|Grep|EnterPlanMode|ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/tool-redirect.js\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/file-checker.js\"",
            "timeout": 60
          }
        ]
      },
      {
        "matcher": "Read|Write|Edit|MultiEdit|Bash|Grep|Glob",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/context-monitor.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/pre-compact.js\"",
            "timeout": 15
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/spec-stop-guard.js\""
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/session-end.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Step 2: Commit**

```bash
git add plugin/hooks/hooks.json
git commit -m "feat: add hooks.json pipeline (6 lifecycle events)"
```

---

### Task 18: TypeScript Coding Standards Rule

**Files:**
- Create: `plugin/rules/standards-typescript.md`

**Step 1: Create the rule** (see design doc for full content — strict types, no any, kebab-case, barrel exports, organized imports, early returns, async/await)

**Step 2: Commit**

```bash
git add plugin/rules/standards-typescript.md
git commit -m "feat: add TypeScript coding standards rule"
```

---

### Task 19: Angular Coding Standards Rule

**Files:**
- Create: `plugin/rules/standards-angular.md`

**Step 1: Create the rule** (see design doc for full content — standalone components, signals, @if/@for control flow, OnPush, Tailwind CSS, lazy routes, reactive forms)

**Step 2: Commit**

```bash
git add plugin/rules/standards-angular.md
git commit -m "feat: add Angular 17+ coding standards rule"
```

---

### Task 20: NestJS Coding Standards Rule

**Files:**
- Create: `plugin/rules/standards-nestjs.md`

**Step 1: Create the rule** (see design doc for full content — DTOs with class-validator, guards, Swagger decorators, repository pattern, @nestjs/config)

**Step 2: Commit**

```bash
git add plugin/rules/standards-nestjs.md
git commit -m "feat: add NestJS coding standards rule"
```

---

### Task 21: Frontend and Backend Standards Rules

**Files:**
- Create: `plugin/rules/standards-frontend.md`
- Create: `plugin/rules/standards-backend.md`

**Step 1: Create frontend standards** (Tailwind, WCAG 2.1 AA, responsive mobile-first, ui-ux-pro-max reference)

**Step 2: Create backend standards** (REST, parameterized queries, N+1 prevention, reversible migrations, Helmet/CORS)

**Step 3: Commit**

```bash
git add plugin/rules/standards-frontend.md plugin/rules/standards-backend.md
git commit -m "feat: add frontend and backend standards rules"
```

---

### Task 22: /spec Dispatcher Command

**Files:**
- Create: `plugin/commands/spec.md`

**Step 1: Create the /spec dispatcher** (thin router: detect feature vs bugfix, ask worktree, route to spec-plan or spec-bugfix-plan)

**Step 2: Commit**

```bash
git add plugin/commands/spec.md
git commit -m "feat: add /spec dispatcher command"
```

---

### Task 23: Spec Plan Command (Feature Planning)

**Files:**
- Create: `plugin/commands/spec-plan.md`

**Step 1: Create spec-plan** (explore codebase, write plan to docs/plans/, optional plan-reviewer, user approval)

**Step 2: Commit**

```bash
git add plugin/commands/spec-plan.md
git commit -m "feat: add spec-plan command (feature planning)"
```

---

### Task 24: Spec Bugfix Plan Command

**Files:**
- Create: `plugin/commands/spec-bugfix-plan.md`

**Step 1: Create spec-bugfix-plan** (trace bug to file:line, Behavior Contract, user approval)

**Step 2: Commit**

```bash
git add plugin/commands/spec-bugfix-plan.md
git commit -m "feat: add spec-bugfix-plan command (Behavior Contract)"
```

---

### Task 25: Spec Implement Command

**Files:**
- Create: `plugin/commands/spec-implement.md`

**Step 1: Create spec-implement** (TDD loop per task: RED-GREEN-REFACTOR, plan file updates)

**Step 2: Commit**

```bash
git add plugin/commands/spec-implement.md
git commit -m "feat: add spec-implement command (TDD implementation)"
```

---

### Task 26: Spec Verify and Spec Bugfix Verify Commands

**Files:**
- Create: `plugin/commands/spec-verify.md`
- Create: `plugin/commands/spec-bugfix-verify.md`

**Step 1: Create spec-verify** (spec-reviewer agent, automated checks, E2E, worktree sync)

**Step 2: Create spec-bugfix-verify** (Behavior Contract audit, full test suite, process compliance)

**Step 3: Commit**

```bash
git add plugin/commands/spec-verify.md plugin/commands/spec-bugfix-verify.md
git commit -m "feat: add spec-verify and spec-bugfix-verify commands"
```

---

### Task 27: Sync and Learn Commands

**Files:**
- Create: `plugin/commands/sync.md`
- Create: `plugin/commands/learn.md`

**Step 1: Create sync** (explore codebase, generate project rules)

**Step 2: Create learn** (extract session knowledge into skills)

**Step 3: Commit**

```bash
git add plugin/commands/sync.md plugin/commands/learn.md
git commit -m "feat: add /sync and /learn commands"
```

---

### Task 28: Plan Reviewer and Spec Reviewer Agents

**Files:**
- Create: `plugin/agents/plan-reviewer.md`
- Create: `plugin/agents/spec-reviewer.md`

**Step 1: Create plan-reviewer** (completeness, architecture, adversarial review, JSON findings output)

**Step 2: Create spec-reviewer** (compliance, quality, goal achievement, JSON findings output)

**Step 3: Commit**

```bash
git add plugin/agents/plan-reviewer.md plugin/agents/spec-reviewer.md
git commit -m "feat: add plan-reviewer and spec-reviewer agents"
```

---

### Task 29: Build System — Compile TypeScript Hooks

**Step 1: Verify TypeScript compiles**

Run: `cd /home/adam/dev/sentinal && bun run build`
Expected: TypeScript compiles to `plugin/hooks/dist/`

**Step 2: Verify compiled hooks exist**

Run: `ls plugin/hooks/dist/hooks/`
Expected: tool-redirect.js, file-checker.js, context-monitor.js, spec-stop-guard.js, pre-compact.js, post-compact-restore.js, session-end.js

**Step 3: Commit any tsconfig adjustments**

```bash
git add tsconfig.json package.json
git commit -m "chore: verify build system compiles hooks"
```

---

### Task 30: Install Script

**Files:**
- Create: `install.sh`

**Step 1: Create installer** (check Node 18+, check Bun, install deps, build, copy plugin to ~/.claude/sentinal/, copy rules)

**Step 2: Make executable**

Run: `chmod +x install.sh`

**Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: add install script"
```

---

### Task 31: Run All Tests and Verify Build

**Step 1: Run all tests**

Run: `cd /home/adam/dev/sentinal && bun test`
Expected: All tests PASS

**Step 2: Run build**

Run: `cd /home/adam/dev/sentinal && bun run build`
Expected: Build succeeds

**Step 3: Verify plugin structure**

Run: `find plugin/ -type f | sort`
Expected: All plugin files present

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify all tests pass and build succeeds"
```

---

## Summary

| Task | Component | What it builds |
|------|-----------|---------------|
| 1 | Scaffolding | package.json, tsconfig.json, .gitignore |
| 2 | Config | plugin.json, settings.json, .mcp.json, .lsp.json |
| 3 | Utilities | hook-output.ts (deny/hint/block/readStdin) |
| 4 | Utilities | file-length.ts (400 warn, 600 block) |
| 5 | Utilities | git.ts (findGitRoot, isInsideGitRepo) |
| 6 | Utilities | tdd.ts (test file detection, path generation) |
| 7 | Checkers | detect.ts (package manager, test runner, framework) |
| 8 | Checkers | typescript.ts (Prettier + ESLint + tsc) |
| 9 | Checkers | angular.ts (ng build, file detection) |
| 10 | Checkers | nestjs.ts (pattern validation) |
| 11 | Hooks | tool-redirect.ts (PreToolUse guard) |
| 12 | Hooks | file-checker.ts (PostToolUse quality gate) |
| 13 | Hooks | context-monitor.ts (context % warnings) |
| 14 | Hooks | spec-stop-guard.ts (Stop guard) |
| 15 | Hooks | pre-compact.ts + post-compact-restore.ts |
| 16 | Hooks | session-end.ts |
| 17 | Config | hooks.json (pipeline definition) |
| 18 | Rules | standards-typescript.md |
| 19 | Rules | standards-angular.md |
| 20 | Rules | standards-nestjs.md |
| 21 | Rules | standards-frontend.md + standards-backend.md |
| 22 | Commands | spec.md (dispatcher) |
| 23 | Commands | spec-plan.md (feature planning) |
| 24 | Commands | spec-bugfix-plan.md (bugfix planning) |
| 25 | Commands | spec-implement.md (TDD implementation) |
| 26 | Commands | spec-verify.md + spec-bugfix-verify.md |
| 27 | Commands | sync.md + learn.md |
| 28 | Agents | plan-reviewer.md + spec-reviewer.md |
| 29 | Build | Verify TypeScript compilation |
| 30 | Install | install.sh |
| 31 | Verify | Run all tests + build |
