/**
 * Shell utility helpers for CLI commands.
 *
 * Provides wrappers around Bun.spawnSync, path resolution,
 * filesystem helpers, and interactive prompts.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ─── ANSI colors ────────────────────────────────────────────────────────────

export const colors = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  blue: "\x1b[0;34m",
  nc: "\x1b[0m",
} as const;

export function info(msg: string): void {
  console.log(`${colors.yellow}${msg}${colors.nc}`);
}
export function ok(msg: string): void {
  console.log(`${colors.green}${msg}${colors.nc}`);
}
export function err(msg: string): void {
  console.error(`${colors.red}${msg}${colors.nc}`);
}
export function note(msg: string): void {
  console.log(`${colors.blue}${msg}${colors.nc}`);
}

// ─── Shell execution ────────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a command synchronously and return the result. */
export function run(cmd: string[], opts?: { cwd?: string }): RunResult {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode ?? 1,
  };
}

/** Check if a command exists on PATH. */
export function commandExists(name: string): boolean {
  return run(["which", name]).ok;
}

/** Get the Node.js major version number, or null if node is not available. */
export function getNodeMajorVersion(): number | null {
  const result = run(["node", "-e", "console.log(process.versions.node.split('.')[0])"]);
  if (!result.ok) return null;
  const major = parseInt(result.stdout, 10);
  return isNaN(major) ? null : major;
}

// ─── Path resolution ────────────────────────────────────────────────────────

/** Resolve XDG_CONFIG_HOME, defaulting to ~/.config */
export function resolveXdgConfig(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * Find the sentinal package root directory.
 *
 * Walks up from this file's directory looking for package.json with
 * name "@endpoint/sentinal". Works from source, compiled binary, and
 * global install.
 */
export function resolveSentinalRoot(): string {
  // Start from this file's directory (src/utils/) and walk up
  let dir = dirname(new URL(import.meta.url).pathname);

  // Walk up at most 10 levels looking for our package.json
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "@endpoint/sentinal") {
          return dir;
        }
      } catch {
        // Not valid JSON, keep looking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  // Fallback: assume cwd is the package root
  return process.cwd();
}

/**
 * Resolve the targets/ directory containing plugin assets.
 *
 * Works from:
 * - Source checkout: <root>/targets/
 * - Global install: ~/.bun/install/global/node_modules/@endpoint/sentinal/targets/
 */
export function resolveAssetsDir(): string {
  const root = resolveSentinalRoot();
  const targetsDir = join(root, "targets");
  if (existsSync(targetsDir)) {
    return targetsDir;
  }
  throw new Error(`Cannot find targets/ directory. Looked at: ${targetsDir}`);
}

/** Check if we're running from a global (node_modules) install. */
export function isGlobalInstall(): boolean {
  const root = resolveSentinalRoot();
  return root.includes("node_modules");
}

// ─── Filesystem helpers ─────────────────────────────────────────────────────

/** Copy a directory recursively (including dotfiles), with optional exclusions. */
export function copyDirRecursive(
  src: string,
  dest: string,
  opts?: { exclude?: string[] },
): void {
  // Use cp -r with the "/." trick to include dotfiles
  const result = run(["cp", "-r", `${src}/.`, dest]);
  if (!result.ok) {
    throw new Error(`Failed to copy ${src} to ${dest}: ${result.stderr}`);
  }

  // Remove excluded files
  if (opts?.exclude) {
    for (const file of opts.exclude) {
      const filePath = join(dest, file);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
  }
}

/** Remove a file if it exists. Returns true if removed. */
export function removeFileIfExists(path: string): boolean {
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

/** Remove a directory recursively if it exists. Returns true if removed. */
export function removeDirIfExists(path: string): boolean {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  return false;
}

/** Remove a directory only if it's empty. Returns true if removed. */
export function removeDirIfEmpty(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const entries = readdirSync(path);
    if (entries.length === 0) {
      rmSync(path);
      return true;
    }
  } catch {
    // Not a directory or permission error
  }
  return false;
}

/** Create directory and all parents (like mkdir -p). */
export function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

// ─── Interactive prompt ─────────────────────────────────────────────────────

/**
 * Present a numbered menu and wait for user input.
 * Returns the 1-based index of the chosen option.
 * Exits the process if stdin is not a TTY.
 */
export async function promptMenu(
  question: string,
  choices: string[],
): Promise<number> {
  if (!process.stdin.isTTY) {
    err("Error: Interactive prompt requires a TTY. Use an explicit target argument.");
    process.exit(1);
  }

  console.log(question);
  console.log("");
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<number>((resolve) => {
    const ask = () => {
      rl.question(`Enter your choice [1-${choices.length}]: `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= choices.length) {
          rl.close();
          resolve(num);
        } else {
          console.log(`Invalid choice. Please enter 1-${choices.length}.`);
          ask();
        }
      });
    };
    ask();
  });
}

// ─── JSONC helpers ──────────────────────────────────────────────────────────

/**
 * Strip // line comments from JSONC content.
 *
 * String-aware: skips // that appears inside double-quoted strings.
 * Handles escaped quotes within strings.
 */
export function stripJsoncComments(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    let inString = false;
    let escaped = false;
    let commentStart = -1;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (!inString && ch === "/" && i + 1 < line.length && line[i + 1] === "/") {
        commentStart = i;
        break;
      }
    }

    const stripped =
      commentStart >= 0 ? line.substring(0, commentStart).trimEnd() : line;
    if (stripped.length > 0 || commentStart < 0) {
      result.push(stripped);
    }
  }

  return result.join("\n");
}
