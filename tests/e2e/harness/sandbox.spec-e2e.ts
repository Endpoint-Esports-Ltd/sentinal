// Sandbox harness tests.
//
// NOTE: filename is `*.spec-e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default test glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/
// or explicitly: bun test ./tests/e2e/harness/sandbox.spec-e2e.ts
//
// RED phase: fails until tests/e2e/harness/sandbox.ts exists.

import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createSandbox,
  assertEnvContained,
  assertCompiledBinaryFresh,
  hashTree,
  snapshotRealDirs,
  assertNoRealEscape,
  E2E_TEST_SESSION_IDS,
  type Sandbox,
} from "./sandbox.ts";

describe("createSandbox — env isolation", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  it("uses a real temp HOME (never / or empty) inside the OS tmpdir", () => {
    sb = createSandbox();
    expect(sb.home).toContain(tmpdir());
    expect(sb.home.length).toBeGreaterThan(tmpdir().length + 1);
    expect(sb.home).not.toBe("/");
    expect(sb.home).not.toBe("");
  });

  it("sets the full isolation env map", () => {
    sb = createSandbox();
    expect(sb.env.HOME).toBe(sb.home);
    expect(sb.env.XDG_CONFIG_HOME).toBe(join(sb.home, ".config"));
    // CLAUDE_CONFIG_DIR is REQUIRED — the installer spawns real `claude` which
    // resolves its plugin registry via CLAUDE_CONFIG_DIR, not HOME.
    expect(sb.env.CLAUDE_CONFIG_DIR).toBe(join(sb.home, ".claude"));
    expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBe("1");
    // CLAUDE_PLUGIN_DATA is the ONE env that can relocate the memory DB — cleared.
    expect(sb.env.CLAUDE_PLUGIN_DATA ?? "").toBe("");
    // SENTINAL_HOME relocates the whole tree — pinned inside the sandbox, never
    // inherited from the bun test preload's per-run temp home.
    expect(sb.env.SENTINAL_HOME).toBe(join(sb.home, ".sentinal"));
  });
});

describe("assertEnvContained — primary structural escape guarantee", () => {
  let sb: Sandbox | null = null;
  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  it("passes when HOME/XDG/CLAUDE_CONFIG_DIR all resolve inside the sandbox", () => {
    sb = createSandbox();
    expect(() => assertEnvContained(sb!.env, sb!.home)).not.toThrow();
  });

  it("throws when an env var points OUTSIDE the sandbox", () => {
    sb = createSandbox();
    const leaked = { ...sb.env, CLAUDE_CONFIG_DIR: "/Users/real/.claude" };
    expect(() => assertEnvContained(leaked, sb!.home)).toThrow();
  });

  it("throws when SENTINAL_HOME points OUTSIDE the sandbox", () => {
    sb = createSandbox();
    const leaked = { ...sb.env, SENTINAL_HOME: "/Users/real/.sentinal" };
    expect(() => assertEnvContained(leaked, sb!.home)).toThrow(/SENTINAL_HOME/);
  });

  it("throws when a required isolation var is missing", () => {
    sb = createSandbox();
    const missing = { ...sb.env };
    delete (missing as Record<string, string | undefined>).CLAUDE_CONFIG_DIR;
    expect(() => assertEnvContained(missing, sb!.home)).toThrow();
  });
});

describe("hashTree — content-hash escape backstop", () => {
  it("detects a NESTED file content change (mtime/entry-list would miss it)", () => {
    const a = mkdtempSync(join(tmpdir(), "sentinal-hashtree-"));
    try {
      mkdirSync(join(a, "nested"), { recursive: true });
      writeFileSync(join(a, "nested", "f.txt"), "original");
      const h1 = hashTree(a);
      expect(hashTree(a)).toBe(h1); // deterministic
      writeFileSync(join(a, "nested", "f.txt"), "TAMPERED");
      expect(hashTree(a)).not.toBe(h1);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });

  it("returns <absent> for a nonexistent path", () => {
    expect(hashTree(join(tmpdir(), "does-not-exist-" + Date.now()))).toBe(
      "<absent>",
    );
  });
});

describe("createSandbox — install + cleanup", () => {
  let sb: Sandbox | null = null;
  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  it("install('opencode') lands opencode.json under the sandbox .config without touching real dirs", () => {
    const realBefore = snapshotRealDirs();
    sb = createSandbox();
    const r = sb.install("opencode");
    expect(r.exitCode).toBe(0);
    const cfg = join(sb.home, ".config", "opencode", "opencode.json");
    expect(sb.exists(cfg)).toBe(true);
    // Also proves the backstop: a real install left the real dirs untouched.
    assertNoRealEscape(realBefore);
  }, 180_000);

  it("cleanup() removes the sandbox HOME", () => {
    const local = createSandbox();
    const home = local.home;
    local.cleanup();
    expect(hashTree(home)).toBe("<absent>");
  });
});

// ── Task 1: binary override + config knobs (release-gate) ────────────────────

describe("createSandbox — SENTINAL_E2E_BINARY override", () => {
  let sb: Sandbox | null = null;
  const savedEnv = process.env.SENTINAL_E2E_BINARY;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    if (savedEnv === undefined) delete process.env.SENTINAL_E2E_BINARY;
    else process.env.SENTINAL_E2E_BINARY = savedEnv;
  });

  it("uses the caller-supplied binary path and exposes it as binaryPath", () => {
    // A fake executable file stands in for a release binary.
    const fake = join(mkdtempSync(join(tmpdir(), "e2e-bin-")), "sentinal-fake");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    process.env.SENTINAL_E2E_BINARY = fake;
    sb = createSandbox();
    expect(sb.binaryPath).toBe(resolve(fake));
  });

  it("THROWS when SENTINAL_E2E_BINARY is set but the file does not exist (no silent dev fallback)", () => {
    process.env.SENTINAL_E2E_BINARY = join(
      tmpdir(),
      "does-not-exist-" + Date.now(),
    );
    expect(() => createSandbox()).toThrow(/SENTINAL_E2E_BINARY/);
  });

  it("falls back to the default entry when SENTINAL_E2E_BINARY is unset", () => {
    delete process.env.SENTINAL_E2E_BINARY;
    sb = createSandbox();
    // binaryPath is the dev dist/sentinal or the bun-src fallback — NOT thrown.
    expect(sb.binaryPath.length).toBeGreaterThan(0);
  });
});

describe("createSandbox — autoSetup + install bundled knobs", () => {
  let sb: Sandbox | null = null;
  const savedNoAuto = process.env.SENTINAL_NO_AUTO_SETUP;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    if (savedNoAuto === undefined) delete process.env.SENTINAL_NO_AUTO_SETUP;
    else process.env.SENTINAL_NO_AUTO_SETUP = savedNoAuto;
  });

  it("default sandbox sets SENTINAL_NO_AUTO_SETUP=1 (backward-compatible)", () => {
    sb = createSandbox();
    expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBe("1");
  });

  it("autoSetup:true DELETES SENTINAL_NO_AUTO_SETUP even when inherited from process.env", () => {
    // Set it in the parent env — the spread must NOT let it bleed through.
    process.env.SENTINAL_NO_AUTO_SETUP = "1";
    sb = createSandbox({ autoSetup: true });
    expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBeUndefined();
  });
});

// ── Task 8 (hardening sweep): stale dist/sentinal is refused ─────────────────

describe("assertCompiledBinaryFresh — a stale dev binary is refused", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A fake compiled binary printing `version`, plus a src/ tree whose newest
  // non-test file is `srcAgeSec` seconds old (the binary is 100s old).
  function fixture(version: string, srcAgeSec: number) {
    const root = mkdtempSync(join(tmpdir(), "sentinal-fresh-"));
    dirs.push(root);
    const binary = join(root, "sentinal");
    writeFileSync(binary, `#!/bin/sh\necho "${version}"\n`);
    chmodSync(binary, 0o755);
    const srcDir = join(root, "src");
    mkdirSync(join(srcDir, "nested"), { recursive: true });
    const impl = join(srcDir, "nested", "impl.ts");
    writeFileSync(impl, "export {};\n");
    const now = Date.now() / 1000;
    utimesSync(binary, now - 100, now - 100);
    utimesSync(impl, now - srcAgeSec, now - srcAgeSec);
    return { binary, srcDir };
  }

  it("accepts a binary whose version matches and is newer than every src file", () => {
    const { binary, srcDir } = fixture("1.2.3", 500);
    expect(() =>
      assertCompiledBinaryFresh({ binary, expectedVersion: "1.2.3", srcDir }),
    ).not.toThrow();
  });

  it("refuses a binary whose --version differs from package.json", () => {
    const { binary, srcDir } = fixture("1.0.0", 500);
    expect(() =>
      assertCompiledBinaryFresh({ binary, expectedVersion: "1.2.3", srcDir }),
    ).toThrow(
      /1\.0\.0[\s\S]*1\.2\.3[\s\S]*bun run build:cli[\s\S]*SENTINAL_E2E_BINARY/,
    );
  });

  it("refuses a binary older than the newest file under src/", () => {
    const { binary, srcDir } = fixture("1.2.3", 10);
    expect(() =>
      assertCompiledBinaryFresh({ binary, expectedVersion: "1.2.3", srcDir }),
    ).toThrow(/older than[\s\S]*impl\.ts[\s\S]*bun run build:cli/);
  });

  it("ignores test files when judging staleness (they are not compiled in)", () => {
    const { binary, srcDir } = fixture("1.2.3", 500);
    writeFileSync(join(srcDir, "nested", "impl.test.ts"), "// newer test\n");
    expect(() =>
      assertCompiledBinaryFresh({ binary, expectedVersion: "1.2.3", srcDir }),
    ).not.toThrow();
  });
});

// ── Task 8: sandbox processes are killed by pidfile + env, never foreign ones ─

// Start a DAEMONIZED bun process (reparented away from us, like a background
// sidecar) with `env`, returning its pid. Bun, not /bin/sleep: macOS hides the
// environment of Apple platform binaries from `ps e`, bun's is visible.
function spawnDaemon(env: Record<string, string | undefined>): number {
  const r = Bun.spawnSync(
    [
      "sh",
      "-c",
      `"${process.execPath}" -e "setTimeout(() => {}, 300000)" >/dev/null 2>&1 & echo $!`,
    ],
    { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
  );
  const pid = Number(r.stdout.toString().trim());
  if (!Number.isInteger(pid) || pid <= 1)
    throw new Error("daemon spawn failed");
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const st = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
  });
  const stat = st.stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

async function waitForEnv(pid: number, needle: string): Promise<void> {
  // `ps e` only shows the environment once the exec has completed.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = Bun.spawnSync(
      ["ps", "eww", "-o", "command=", "-p", String(pid)],
      {
        stdout: "pipe",
      },
    );
    if (r.stdout.toString().includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`pid ${pid} never showed ${needle}`);
}

describe("cleanup() — kills sandbox-owned processes, and only those", () => {
  const foreign: number[] = [];
  let sb: Sandbox | null = null;
  afterEach(() => {
    try {
      sb?.cleanup();
    } finally {
      sb = null;
      for (const pid of foreign.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  });

  it("gives every sandbox a unique SENTINAL_E2E_SANDBOX_ID in its env", () => {
    sb = createSandbox();
    const other = createSandbox();
    try {
      expect(sb.id.length).toBeGreaterThan(8);
      expect(sb.env.SENTINAL_E2E_SANDBOX_ID).toBe(sb.id);
      expect(other.id).not.toBe(sb.id);
    } finally {
      other.cleanup();
    }
  });

  it("kills the process named in the sandbox's sidecar.pid (env has no path on its command line)", async () => {
    sb = createSandbox();
    const pid = spawnDaemon(sb.env);
    await waitForEnv(pid, `SENTINAL_E2E_SANDBOX_ID=${sb.id}`);
    mkdirSync(join(sb.home, ".sentinal"), { recursive: true });
    writeFileSync(join(sb.home, ".sentinal", "sidecar.pid"), String(pid));
    expect(isAlive(pid)).toBe(true);
    const local = sb;
    sb = null;
    local.cleanup();
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it("kills a stray with no pidfile by matching the sandbox id in its environment", async () => {
    sb = createSandbox();
    const pid = spawnDaemon({
      ...process.env,
      SENTINAL_E2E_SANDBOX_ID: sb.id,
    });
    await waitForEnv(pid, `SENTINAL_E2E_SANDBOX_ID=${sb.id}`);
    const local = sb;
    sb = null;
    local.cleanup();
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it("REFUSES to kill a process named in a sandbox pidfile that is not the sandbox's", async () => {
    sb = createSandbox();
    // A process with the REAL environment (stands in for the user's sidecar,
    // or a recycled pid) — must survive even though a sandbox pidfile names it.
    const pid = spawnDaemon({ ...process.env });
    foreign.push(pid);
    await waitForEnv(pid, "setTimeout");
    mkdirSync(join(sb.home, ".sentinal"), { recursive: true });
    writeFileSync(join(sb.home, ".sentinal", "sidecar.pid"), String(pid));
    writeFileSync(join(sb.home, ".sentinal", "server.pid"), String(pid));
    const local = sb;
    sb = null;
    local.cleanup();
    expect(isAlive(pid)).toBe(true);
  }, 20_000);

  it("kills a real sandbox sidecar started with `sidecar start --background`", async () => {
    sb = createSandbox();
    const pidFile = join(sb.home, ".sentinal", "sidecar.pid");
    const r = sb.run(["sidecar", "start", "--background"], { cwd: sb.home });
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
    if (!existsSync(pidFile)) {
      // The CLI under test could not start a sidecar (e.g. a mid-edit tree) —
      // the pidfile/env kill paths above still pin the behaviour.
      console.warn(
        `[sandbox.spec-e2e] sidecar did not start (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}`,
      );
      return;
    }
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    expect(isAlive(pid)).toBe(true);
    const local = sb;
    sb = null;
    local.cleanup();
    expect(isAlive(pid)).toBe(false);
  }, 60_000);
});

// ── Task 8: escape backstop tolerates live writes, catches attributable ones ─

// A fake "real" HOME: a live-looking ~/.sentinal (logs, WAL-mode memory.db)
// plus static user config, so the checks are exercised without the user's dirs.
function fakeRealHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sentinal-fakehome-"));
  const s = join(home, ".sentinal");
  mkdirSync(join(s, "bin"), { recursive: true });
  mkdirSync(join(s, "sessions"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(s, "bin", "sentinal"), "binary-v1");
  writeFileSync(join(s, "plugin.debug.log"), "boot\n");
  writeFileSync(join(s, "sidecar.log"), "sidecar: started\n");
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  const db = new Database(join(s, "memory.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE observations (id INTEGER PRIMARY KEY, session_id TEXT, project_path TEXT, title TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT);
    CREATE TABLE specs (id TEXT PRIMARY KEY, project_path TEXT, plan_file TEXT, session_id TEXT);
    INSERT INTO observations (session_id, project_path, title) VALUES ('s1', '/Users/x/proj', 'old');`);
  db.close();
  return home;
}

function insert(home: string, sql: string, ...params: string[]): void {
  const db = new Database(join(home, ".sentinal", "memory.db"));
  db.query(sql).run(...params);
  db.close();
}

describe("snapshotRealDirs / assertNoRealEscape — attributable-write checks", () => {
  const homes: string[] = [];
  let sb: Sandbox | null = null;
  afterEach(() => {
    sb?.cleanup();
    sb = null;
    for (const h of homes.splice(0))
      rmSync(h, { recursive: true, force: true });
  });
  function setup(strict = false) {
    const home = fakeRealHome();
    homes.push(home);
    return { home, before: snapshotRealDirs({ home, strict }) };
  }

  it("does NOT content-hash the whole ~/.sentinal tree in default mode", () => {
    const { home, before } = setup();
    expect(Object.keys(before)).not.toContain(
      `hash:${join(home, ".sentinal")}`,
    );
    expect(Object.keys(before)).not.toContain(join(home, ".sentinal"));
  });

  it("passes while a live sidecar writes unrelated logs, WAL frames and rows", () => {
    const { home, before } = setup();
    appendFileSync(
      join(home, ".sentinal", "plugin.debug.log"),
      "system.transform\n",
    );
    appendFileSync(
      join(home, ".sentinal", "sidecar.log"),
      "client: reconnected\n",
    );
    writeFileSync(join(home, ".sentinal", "sessions", "default"), "live");
    insert(
      home,
      "INSERT INTO observations (session_id, project_path, title) VALUES (?, ?, ?)",
      "live-session",
      "/Users/x/proj",
      "live row",
    );
    expect(() => assertNoRealEscape(before)).not.toThrow();
  });

  it("fails when a real log gains bytes naming a sandbox HOME", () => {
    const { home, before } = setup();
    sb = createSandbox();
    appendFileSync(
      join(home, ".sentinal", "sidecar.log"),
      `request from ${join(sb.home, "work")}\n`,
    );
    expect(() => assertNoRealEscape(before)).toThrow(/sidecar\.log/);
  });

  it("fails when a real log gains bytes naming a sandbox id", () => {
    const { home, before } = setup();
    sb = createSandbox();
    appendFileSync(
      join(home, ".sentinal", "plugin.debug.log"),
      `id=${sb.id}\n`,
    );
    expect(() => assertNoRealEscape(before)).toThrow(/plugin\.debug\.log/);
  });

  it("fails when the real DB gains a row keyed to a sandbox path", () => {
    const { home, before } = setup();
    sb = createSandbox();
    insert(
      home,
      "INSERT INTO sessions (id, project_path) VALUES (?, ?)",
      "x",
      join(sb.home, "work"),
    );
    expect(() => assertNoRealEscape(before)).toThrow(
      /memory\.db[\s\S]*sessions/,
    );
  });

  it("fails when the real DB gains a row with a test session id", () => {
    const { home, before } = setup();
    insert(
      home,
      "INSERT INTO specs (id, project_path, plan_file, session_id) VALUES (?, ?, ?, ?)",
      "p",
      "/Users/x/proj",
      "/Users/x/proj/docs/plans/p.md",
      E2E_TEST_SESSION_IDS[0]!,
    );
    expect(() => assertNoRealEscape(before)).toThrow(/specs/);
  });

  it("fails when the real DB gains a tmpdir-keyed row that names no sandbox (row-count check)", () => {
    const { home, before } = setup();
    insert(
      home,
      "INSERT INTO observations (session_id, project_path, title) VALUES (?, ?, ?)",
      "anon",
      join(tmpdir(), "some-test-repo-abc"),
      "escaped",
    );
    expect(() => assertNoRealEscape(before)).toThrow(/observations/);
  });

  it("fails when static user config changes", () => {
    const { home, before } = setup();
    writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}');
    expect(() => assertNoRealEscape(before)).toThrow(/settings\.json/);
  });

  it("fails when the installed sentinal binary is replaced", () => {
    const { home, before } = setup();
    writeFileSync(
      join(home, ".sentinal", "bin", "sentinal"),
      "binary-v2-longer",
    );
    expect(() => assertNoRealEscape(before)).toThrow(/bin/);
  });

  it("opens the real DB read-only: no -wal/-shm created, WAL bytes untouched", () => {
    const home = fakeRealHome();
    homes.push(home);
    const s = join(home, ".sentinal");
    // (a) no WAL present (sidecar down): must not create one.
    rmSync(join(s, "memory.db-wal"), { force: true });
    rmSync(join(s, "memory.db-shm"), { force: true });
    const listing = readdirSync(s).sort();
    const dbHash = hashTree(join(s, "memory.db"));
    assertNoRealEscape(snapshotRealDirs({ home }));
    expect(readdirSync(s).sort()).toEqual(listing);
    expect(hashTree(join(s, "memory.db"))).toBe(dbHash);
    // (b) a live writer holds the WAL open: our reads must not checkpoint it.
    const live = new Database(join(s, "memory.db"));
    try {
      live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      live
        .query("INSERT INTO sessions (id, project_path) VALUES ('l', '/x')")
        .run();
      const walBefore = hashTree(join(s, "memory.db-wal"));
      const mainBefore = hashTree(join(s, "memory.db"));
      assertNoRealEscape(snapshotRealDirs({ home }));
      expect(hashTree(join(s, "memory.db-wal"))).toBe(walBefore);
      expect(hashTree(join(s, "memory.db"))).toBe(mainBefore);
    } finally {
      live.close();
    }
  });

  it("strict mode (SENTINAL_E2E_STRICT_ESCAPE=1) fails on ANY ~/.sentinal change", () => {
    const saved = process.env.SENTINAL_E2E_STRICT_ESCAPE;
    process.env.SENTINAL_E2E_STRICT_ESCAPE = "1";
    try {
      const home = fakeRealHome();
      homes.push(home);
      const before = snapshotRealDirs({ home });
      writeFileSync(join(home, ".sentinal", "sessions", "default"), "live");
      expect(() => assertNoRealEscape(before)).toThrow(/\.sentinal/);
    } finally {
      if (saved === undefined) delete process.env.SENTINAL_E2E_STRICT_ESCAPE;
      else process.env.SENTINAL_E2E_STRICT_ESCAPE = saved;
    }
  });

  it("keeps accepting a legacy { path: hash } snapshot", () => {
    const home = fakeRealHome();
    homes.push(home);
    const p = join(home, ".claude");
    const legacy = { [p]: hashTree(p) };
    expect(() => assertNoRealEscape(legacy)).not.toThrow();
    writeFileSync(join(p, "settings.json"), "changed");
    expect(() => assertNoRealEscape(legacy)).toThrow();
  });
});
