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
// spawned process's env stays inside the sandbox. snapshotRealDirs /
// assertNoRealEscape are the backstop: they look for writes ATTRIBUTABLE to a
// sandbox (so the user's live sidecar can keep writing during a run), plus a
// content hash of static user config — see ./real-escape.ts. Teardown kills
// sandbox processes by pidfile + environment — see ./sandbox-procs.ts.

import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { registerSandboxMarkers } from "./real-escape.ts";
import { killSandboxProcesses } from "./sandbox-procs.ts";

export {
  E2E_TEST_SESSION_IDS,
  hashTree,
  snapshotRealDirs,
  assertNoRealEscape,
  type SnapshotOptions,
} from "./real-escape.ts";
export { killSandboxProcesses } from "./sandbox-procs.ts";

// Repo root = three levels up from tests/e2e/harness/.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_SRC = join(REPO_ROOT, "src", "cli", "index.ts");
const CLI_COMPILED = join(REPO_ROOT, "dist", "sentinal");

export interface SandboxEnv {
  HOME: string;
  XDG_CONFIG_HOME: string;
  CLAUDE_CONFIG_DIR: string;
  /**
   * "1" by default (skips the ~150MB native-dep/model provisioning). Deleted
   * (undefined) when createSandbox({ autoSetup: true }) — used by the release
   * native-dep gate so the binary really provisions ~/.sentinal/deps.
   */
  SENTINAL_NO_AUTO_SETUP?: string;
  CLAUDE_PLUGIN_DATA: string;
  /** Unique per sandbox; lets teardown find strays by their environment. */
  SENTINAL_E2E_SANDBOX_ID: string;
  [key: string]: string | undefined;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateSandboxOptions {
  /**
   * When true, do NOT set (and DELETE any inherited) SENTINAL_NO_AUTO_SETUP so
   * the sentinal binary provisions native deps as a real user would. Default false.
   */
  autoSetup?: boolean;
}

export interface InstallOptions {
  /** Pass --bundled (default true). A release binary self-selects embedded mode. */
  bundled?: boolean;
}

export interface Sandbox {
  home: string;
  /** SENTINAL_E2E_SANDBOX_ID — also present in `env`. */
  id: string;
  env: SandboxEnv;
  /**
   * The resolved binary the harness runs. Either the SENTINAL_E2E_BINARY
   * override (release artifact), the dev `dist/sentinal`, or the bun-src fallback.
   */
  binaryPath: string;
  /** Run the sentinal CLI with the sandbox env (binaryPath). */
  run(args: string[], opts?: { stdin?: string; cwd?: string }): SpawnResult;
  /** Install a target (opencode/claude/both) into the sandbox. */
  install(
    target: "opencode" | "claude" | "both",
    opts?: InstallOptions,
  ): SpawnResult;
  /** Path existence within the sandbox. */
  exists(path: string): boolean;
  /**
   * Tear down: kill sandbox-owned processes, remove the HOME, then THROW if
   * any sandbox process survived (a survivor can recreate the deleted HOME).
   */
  cleanup(): void;
}

// ── Binary resolution + freshness ────────────────────────────────────────────

export interface CompiledBinaryCheck {
  binary: string;
  expectedVersion: string;
  srcDir: string;
  env?: Record<string, string | undefined>;
}

const TEST_SOURCE = /\.(test|spec)\.[jt]sx?$|\.e2e\.ts$|\.spec-e2e\.ts$/;

function newestSourceFile(
  dir: string,
): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(full);
      } else if (e.isFile() && !TEST_SOURCE.test(e.name)) {
        const m = statSync(full).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: full, mtimeMs: m };
      }
    }
  };
  walk(dir);
  return best;
}

/**
 * Refuse a compiled binary that does not represent the current source: its
 * `--version` must equal package.json's and it must be newer than every
 * non-test file under `srcDir`. A stale dist/sentinal silently tests OLD code.
 */
export function assertCompiledBinaryFresh(o: CompiledBinaryCheck): void {
  const hint =
    "Run `bun run build:cli` to rebuild it, or set SENTINAL_E2E_BINARY=<path> " +
    "to test a specific binary.";
  const r = Bun.spawnSync([o.binary, "--version"], {
    env: (o.env ?? process.env) as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const out = r.stdout?.toString().trim() ?? "";
  const got =
    /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(out)?.[0] ??
    `<no version, exit ${r.exitCode}>`;
  if (got !== o.expectedVersion) {
    throw new Error(
      `Refusing stale ${o.binary}: --version reports ${got} but package.json ` +
        `is ${o.expectedVersion}. ${hint}`,
    );
  }
  const binMtime = statSync(o.binary).mtimeMs;
  const newest = newestSourceFile(o.srcDir);
  if (newest && newest.mtimeMs > binMtime) {
    throw new Error(
      `Refusing stale ${o.binary}: it is older than ${newest.path} ` +
        `(modified ${new Date(newest.mtimeMs).toISOString()}). ${hint}`,
    );
  }
}

const freshBinaries = new Set<string>(); // "<path>@<mtimeMs>" already verified

/**
 * Resolve the binary the harness will run.
 * - SENTINAL_E2E_BINARY set → MUST exist, else THROW (never silently fall back to
 *   the dev build — a bad release path would otherwise produce a green gate).
 *   Not freshness-checked: a release artifact is deliberately pinned.
 * - unset → dev `dist/sentinal` if present AND fresh (else THROW), otherwise
 *   `bun src/cli/index.ts`.
 */
function resolveEntry(env: SandboxEnv): string[] {
  const override = process.env.SENTINAL_E2E_BINARY;
  if (override) {
    const abs = resolve(override);
    if (!existsSync(abs)) {
      throw new Error(
        `SENTINAL_E2E_BINARY is set to "${override}" but that file does not exist. ` +
          `Refusing to silently fall back to the dev build.`,
      );
    }
    return [abs];
  }
  if (!existsSync(CLI_COMPILED)) return ["bun", CLI_SRC];
  const key = `${CLI_COMPILED}@${statSync(CLI_COMPILED).mtimeMs}`;
  if (!freshBinaries.has(key)) {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
    ) as { version: string };
    assertCompiledBinaryFresh({
      binary: CLI_COMPILED,
      expectedVersion: pkg.version,
      srcDir: join(REPO_ROOT, "src"),
      env,
    });
    freshBinaries.add(key);
  }
  return [CLI_COMPILED];
}

// ── Sandbox construction ─────────────────────────────────────────────────────

export function createSandbox(opts: CreateSandboxOptions = {}): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "sentinal-e2e-"));
  const id = `sentinal-e2e-${randomUUID()}`;

  const env: SandboxEnv = {
    ...(process.env as Record<string, string | undefined>),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    SENTINAL_NO_AUTO_SETUP: "1",
    CLAUDE_PLUGIN_DATA: "", // cleared — must not relocate the memory DB outside HOME
    // Pinned (= the unset default under HOME): the spread above would
    // otherwise inherit the bun test preload's per-run temp SENTINAL_HOME, so
    // every sandbox in a run would share one DB/sidecar outside its HOME.
    SENTINAL_HOME: join(home, ".sentinal"),
    SENTINAL_E2E_SANDBOX_ID: id,
  };
  if (opts.autoSetup) {
    // Must DELETE (not just skip): an inherited process.env value survives the spread.
    delete env.SENTINAL_NO_AUTO_SETUP;
  }

  let entryCmd: string[];
  try {
    entryCmd = resolveEntry(env); // throws on a bad override or a stale dist
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  const binaryPath = entryCmd[entryCmd.length - 1] ?? "";
  registerSandboxMarkers(home, id);

  const cwdTmp = join(home, "work");

  function run(
    args: string[],
    ropts: { stdin?: string; cwd?: string } = {},
  ): SpawnResult {
    // Structural guarantee: never spawn with an env that escapes the sandbox.
    assertEnvContained(env, home);
    const cmd = [...entryCmd, ...args];
    const proc = Bun.spawnSync(cmd, {
      env: env as Record<string, string>,
      cwd: ropts.cwd ?? cwdTmp,
      stdin: ropts.stdin ? Buffer.from(ropts.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
    };
  }

  function install(
    target: "opencode" | "claude" | "both",
    iopts: InstallOptions = {},
  ): SpawnResult {
    // Bundled mode avoids the ~/.npmrc scoped-registry network requirement.
    // Explicit target skips setupProjectSymlinks/setupShellIntegration (cwd/shell rc).
    // A release binary self-selects embedded mode regardless of --bundled.
    Bun.spawnSync(["mkdir", "-p", cwdTmp]);
    const bundled = iopts.bundled ?? true;
    const args = bundled
      ? ["install", target, "--bundled"]
      : ["install", target];
    return run(args);
  }

  function cleanup(): void {
    const survivors = killSandboxProcesses(home, id);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (survivors.length > 0) {
      throw new Error(
        `Sandbox processes survived cleanup of ${home}: ${survivors.join(", ")}`,
      );
    }
  }

  return {
    home,
    id,
    env,
    binaryPath,
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
  // SENTINAL_HOME, if set, relocates the whole ~/.sentinal tree.
  const sentinalHome = env.SENTINAL_HOME;
  if (sentinalHome && !withSep(resolve(sentinalHome)).startsWith(root)) {
    throw new Error(
      `Sandbox escape guard: SENTINAL_HOME=${sentinalHome} escapes the sandbox`,
    );
  }
}

function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}
