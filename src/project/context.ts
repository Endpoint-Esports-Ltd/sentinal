/**
 * Project Context Analysis
 *
 * Analyzes a project directory to produce a structured summary:
 * tech stack, directory structure, commands, conventions, and
 * existing sync-generated rule files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import {
  detectPackageManager,
  detectTestRunner,
  detectFramework,
  type PackageManager,
  type TestRunner,
  type Framework,
} from "../checkers/detect.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TechStack {
  packageManager: PackageManager;
  frameworks: Framework[];
  testRunner: TestRunner;
  language: string;
}

export interface ProjectContext {
  name: string;
  techStack: TechStack;
  structure: string[];
  conventions: string[];
  commands: Record<string, string>;
  rulesContent: string | null;
  analyzedAt: number;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".angular",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".output",
  ".nuxt",
  "__pycache__",
]);

const RULES_GLOBS = [".claude/rules", ".opencode/rules"];

export function analyzeProject(projectPath: string): ProjectContext {
  const resolved = resolve(projectPath);

  // Package.json
  const pkg = readPackageJson(resolved);
  const name =
    (typeof pkg?.name === "string" ? pkg.name : null) ?? basename(resolved);
  const commands = extractCommands(pkg);

  // Tech stack
  const techStack: TechStack = {
    packageManager: detectPackageManager(resolved),
    frameworks: detectFramework(resolved),
    testRunner: detectTestRunner(resolved),
    language: detectLanguage(resolved),
  };

  // Directory structure
  const structure = buildStructure(resolved);

  // Conventions
  const conventions = detectConventions(resolved);

  // Rules files
  const rulesContent = findRulesContent(resolved);

  return {
    name,
    techStack,
    structure,
    conventions,
    commands,
    rulesContent,
    analyzedAt: Date.now(),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [];

  lines.push(`# Project Context: ${ctx.name}`, "");

  // Tech Stack
  lines.push("## Tech Stack", "");
  lines.push(`- **Language:** ${ctx.techStack.language}`);
  lines.push(`- **Package Manager:** ${ctx.techStack.packageManager}`);
  if (ctx.techStack.frameworks.length > 0) {
    lines.push(`- **Frameworks:** ${ctx.techStack.frameworks.join(", ")}`);
  }
  lines.push(`- **Test Runner:** ${ctx.techStack.testRunner}`);
  lines.push("");

  // Commands
  const cmdEntries = Object.entries(ctx.commands);
  if (cmdEntries.length > 0) {
    lines.push("## Commands", "");
    lines.push("| Command | Script |");
    lines.push("|---------|--------|");
    for (const [cmd, script] of cmdEntries) {
      lines.push(`| ${cmd} | \`${script}\` |`);
    }
    lines.push("");
  }

  // Structure
  if (ctx.structure.length > 0) {
    lines.push("## Directory Structure", "");
    lines.push("```");
    for (const entry of ctx.structure) {
      lines.push(entry);
    }
    lines.push("```");
    lines.push("");
  }

  // Conventions
  if (ctx.conventions.length > 0) {
    lines.push("## Conventions", "");
    for (const conv of ctx.conventions) {
      lines.push(`- ${conv}`);
    }
    lines.push("");
  }

  // Rules
  if (ctx.rulesContent) {
    lines.push("## Project Rules", "");
    lines.push(ctx.rulesContent);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readPackageJson(projectPath: string): Record<string, unknown> | null {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
}

function extractCommands(
  pkg: Record<string, unknown> | null,
): Record<string, string> {
  if (!pkg?.scripts || typeof pkg.scripts !== "object") return {};
  const scripts = pkg.scripts as Record<string, string>;
  const commands: Record<string, string> = {};
  const keys = ["build", "test", "lint", "dev", "start", "format", "typecheck"];
  for (const key of keys) {
    if (scripts[key]) commands[key] = scripts[key];
  }
  return commands;
}

function detectLanguage(projectPath: string): string {
  if (existsSync(join(projectPath, "tsconfig.json"))) return "TypeScript";
  if (existsSync(join(projectPath, "jsconfig.json"))) return "JavaScript";
  if (existsSync(join(projectPath, "go.mod"))) return "Go";
  if (existsSync(join(projectPath, "Cargo.toml"))) return "Rust";
  if (
    existsSync(join(projectPath, "pyproject.toml")) ||
    existsSync(join(projectPath, "setup.py"))
  )
    return "Python";
  return "JavaScript";
}

function buildStructure(projectPath: string): string[] {
  const structure: string[] = [];

  // Top-level directories
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      structure.push(`${entry.name}/`);

      // One level deeper for src/
      if (entry.name === "src") {
        try {
          const srcEntries = readdirSync(join(projectPath, "src"), {
            withFileTypes: true,
          });
          for (const sub of srcEntries) {
            if (sub.isDirectory() && !IGNORED_DIRS.has(sub.name)) {
              structure.push(`src/${sub.name}/`);
            }
          }
        } catch {
          /* src/ not readable */
        }
      }
    }
  } catch {
    /* not readable */
  }

  return structure.sort();
}

function detectConventions(projectPath: string): string[] {
  const conventions: string[] = [];

  // tsconfig strict mode
  const tsconfigPath = join(projectPath, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
      if (tsconfig?.compilerOptions?.strict) {
        conventions.push("TypeScript strict mode enabled");
      }
      if (tsconfig?.compilerOptions?.paths) {
        conventions.push("Path aliases configured in tsconfig");
      }
    } catch {
      /* parse error */
    }
  }

  // Linting/formatting
  const lintConfigs = [
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
  ];
  if (lintConfigs.some((f) => existsSync(join(projectPath, f)))) {
    conventions.push("Uses ESLint");
  }
  if (
    existsSync(join(projectPath, ".prettierrc")) ||
    existsSync(join(projectPath, ".prettierrc.json"))
  ) {
    conventions.push("Uses Prettier");
  }

  // Monorepo
  const pkg = readPackageJson(projectPath);
  if (pkg?.workspaces) {
    conventions.push("Monorepo with workspaces");
  }

  return conventions;
}

function findRulesContent(projectPath: string): string | null {
  for (const rulesDir of RULES_GLOBS) {
    const fullDir = join(projectPath, rulesDir);
    if (!existsSync(fullDir)) continue;
    try {
      const files = readdirSync(fullDir).filter(
        (f) => f.endsWith("-project.md") || f === "project.md",
      );
      if (files.length > 0) {
        return readFileSync(join(fullDir, files[0]), "utf-8");
      }
    } catch {
      /* not readable */
    }
  }
  return null;
}
