// Isolated E2E sandbox harness.
//
// Creates a fully isolated temp HOME so installing/driving Sentinal never
// touches the real ~/.claude, ~/.config/opencode, ~/.opencode, ~/.sentinal.
// Every Sentinal path keys off os.homedir()/XDG_CONFIG_HOME, and the installer
// spawns the real `claude` binary which resolves its plugin registry via
// CLAUDE_CONFIG_DIR — so the sandbox env overrides HOME, XDG_CONFIG_HOME and
// CLAUDE_CONFIG_DIR, clears CLAUDE_PLUGIN_DATA (the one var that can relocate
// the memory DB outside HOME), and sets SENTINAL_NO_AUTO_SETUP=1.
//
// Escape guarantee is STRUCTURAL (primary): assertEnvContained proves every
// spawned process's env stays inside the sandbox. hashTree is the content-hash
// backstop that detects nested-file rewrites the mtime/entry-list approach misses.

import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

// Repo root = three levels up from tests/e2e/harness/.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_SRC = join(REPO_ROOT, "src", "cli", "index.ts");
const CLI_COMPILED = join(REPO_ROOT, "dist", "sentinal");

export interface SandboxEnv {
  HOME: string;
  XDG_CONFIG_HOME: string;
  CLAUDE_CONFIG_DIR: string;
  SENTINAL_NO_AUTO_SETUP: string;
  CLAUDE_PLUGIN_DATA: string;
  [key: string]: string | undefined;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  home: string;
  env: SandboxEnv;
  /** Run the sentinal CLI with the sandbox env (compiled binary if built, else bun src). */
  run(args: string[], opts?: { stdin?: string; cwd?: string }): SpawnResult;
  /** Install a target (opencode/claude/both) into the sandbox, bundled mode. */
  install(target: "opencode" | "claude" | "both"): SpawnResult;
  /** Path existence within the sandbox. */
  exists(path: string): boolean;
  /** Tear down: kill sandbox-owned sidecar/dashboard, then remove the HOME. */
  cleanup(): void;
}

// ── Sandbox construction ─────────────────────────────────────────────────────

export function createSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "sentinal-e2e-"));
  const env: SandboxEnv = {
    ...(process.env as Record<string, string | undefined>),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    SENTINAL_NO_AUTO_SETUP: "1",
    CLAUDE_PLUGIN_DATA: "", // cleared — must not relocate the memory DB outside HOME
  };

  const cwdTmp = join(home, "work");

  function entry(): string[] {
    return existsSync(CLI_COMPILED) ? [CLI_COMPILED] : ["bun", CLI_SRC];
  }

  function run(
    args: string[],
    opts: { stdin?: string; cwd?: string } = {},
  ): SpawnResult {
    // Structural guarantee: never spawn with an env that escapes the sandbox.
    assertEnvContained(env, home);
    const cmd = [...entry(), ...args];
    const proc = Bun.spawnSync(cmd, {
      env: env as Record<string, string>,
      cwd: opts.cwd ?? cwdTmp,
      stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
    };
  }

  function install(target: "opencode" | "claude" | "both"): SpawnResult {
    // Bundled mode avoids the ~/.npmrc scoped-registry network requirement.
    // Explicit target skips setupProjectSymlinks/setupShellIntegration (cwd/shell rc).
    Bun.spawnSync(["mkdir", "-p", cwdTmp]);
    return run(["install", target, "--bundled"]);
  }

  function cleanup(): void {
    killSandboxProcesses(home);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  return {
    home,
    env,
    run,
    install,
    exists: (p: string) => existsSync(p),
    cleanup,
  };
}

// ── Primary escape guarantee (structural) ────────────────────────────────────

/**
 * Assert the sandbox env keeps HOME / XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR all
 * resolving INSIDE the sandbox root. This is the real proof of non-escape — any
 * spawned process inherits these, so it cannot write to the user's real dirs.
 */
export function assertEnvContained(
  env: Record<string, string | undefined>,
  sandboxRoot: string,
): void {
  const root = withSep(resolve(sandboxRoot));
  const required = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"] as const;
  for (const key of required) {
    const val = env[key];
    if (!val) {
      throw new Error(
        `Sandbox escape guard: required isolation env "${key}" is missing`,
      );
    }
    if (!withSep(resolve(val)).startsWith(root)) {
      throw new Error(
        `Sandbox escape guard: env "${key}"=${val} resolves OUTSIDE the sandbox ${sandboxRoot}`,
      );
    }
  }
  // CLAUDE_PLUGIN_DATA, if set, must also be inside (it can relocate the DB).
  const pluginData = env.CLAUDE_PLUGIN_DATA;
  if (pluginData && !withSep(resolve(pluginData)).startsWith(root)) {
    throw new Error(
      `Sandbox escape guard: CLAUDE_PLUGIN_DATA=${pluginData} escapes the sandbox`,
    );
  }
}

function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

// ── Content-hash escape backstop ─────────────────────────────────────────────

/**
 * Recursively content-hash a directory tree (sorted paths + file contents).
 * Returns "<absent>" when the path does not exist. Detects nested-file content
 * rewrites that a dir-mtime/entry-list snapshot would miss.
 */
export function hashTree(root: string): string {
  if (!existsSync(root)) return "<absent>";
  const h = createHash("sha256");
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return; // unreadable → skip (permission dirs like keychain)
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      h.update(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        try {
          h.update(readFileSync(full));
        } catch {
          h.update("<unreadable>");
        }
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

/**
 * Snapshot the real user dirs/files that install/shell-init could touch.
 * Used as a defense-in-depth backstop around assertEnvContained.
 */
export function snapshotRealDirs(): Record<string, string> {
  const home = homedir();
  const targets = [
    join(home, ".claude"),
    join(home, ".config", "opencode"),
    join(home, ".opencode"),
    join(home, ".sentinal"),
    join(home, ".bashrc"),
    join(home, ".zshrc"),
    join(home, ".config", "fish", "config.fish"),
    join(home, ".npmrc"),
    process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
  ];
  const snap: Record<string, string> = {};
  for (const t of targets) snap[t] = hashTree(t);
  return snap;
}

export function assertNoRealEscape(before: Record<string, string>): void {
  for (const [path, prevHash] of Object.entries(before)) {
    const now = hashTree(path);
    if (now !== prevHash) {
      throw new Error(
        `Sandbox escape detected: real path "${path}" changed during the e2e run`,
      );
    }
  }
}

// ── Teardown: kill sandbox-owned processes (PID-reuse safe) ───────────────────

function killSandboxProcesses(sandboxHome: string): void {
  // 1. Best-effort SIGTERM via the sandbox pid files, guarded by ownership.
  const pidDir = join(sandboxHome, ".sentinal");
  for (const pidFile of ["sidecar.pid", "server.pid"]) {
    const p = join(pidDir, pidFile);
    if (!existsSync(p)) continue;
    const pid = Number(safeRead(p).trim());
    if (Number.isFinite(pid) && pid > 1 && processBelongsToSandbox(pid, sandboxHome)) {
      trySignal(pid, "SIGTERM");
    }
  }
  // 2. Backstop: kill any process whose command line references the unique
  //    sandbox HOME path (covers detached children / reparented sidecars).
  try {
    const ps = Bun.spawnSync(["pgrep", "-f", sandboxHome], { stdout: "pipe" });
    const out = ps.stdout?.toString() ?? "";
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 1) trySignal(pid, "SIGKILL");
    }
  } catch {
    /* pgrep may be unavailable; pid-file path already handled the common case */
  }
}

function processBelongsToSandbox(pid: number, sandboxHome: string): boolean {
  // Confirm the PID's command line references the sandbox HOME before killing,
  // guarding against PID reuse naming an unrelated host process.
  try {
    const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
    });
    return (r.stdout?.toString() ?? "").includes(sandboxHome);
  } catch {
    return false; // if we can't verify ownership, don't kill
  }
}

function trySignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
