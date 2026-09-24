/**
 * Test isolation guard — `bun test` can never write to the REAL SENTINAL_HOME.
 *
 * History (Task 2 of docs/plans/2026-09-24-orca-support-followups.md): 205
 * "Fixed issue in foo.ts" observations leaked into the user's real
 * `~/.sentinal/memory.db` between 2026-05-26 and 2026-09-01, one per full
 * suite run, from `src/hooks/memory-observer.test.ts` ("should include
 * agent_id and duration_ms…"). That test calls `processMemoryObserver()`,
 * which stores via `SidecarClient.connect()` (the user's LIVE sidecar) or
 * `new MemoryStore()` (the default DB). The preload redirect landed in
 * e3f9194 (2026-09-02); this file pins every property that redirect relies on.
 */

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getDbPath, getSentinalHome } from "./db-path.js";
import { DEPS_DIR, getDepsDir } from "./native-deps.js";
import { getModelsCacheDir } from "./embeddings.js";
import {
  getSidecarPidPath,
  getSidecarPortPath,
  getSidecarSocketPath,
} from "../sidecar/paths.js";
import { SidecarClient } from "../sidecar/client.js";
import {
  decideTestHome,
  linkSharedModels,
  removeTestHome,
  sweepStaleTestHomes,
  testHome,
} from "./test-preload.js";

const REAL_HOME = join(homedir(), ".sentinal");

function canon(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canon(parent), basename(abs));
  }
}

function isInside(child: string, parent: string): boolean {
  const c = canon(child);
  const p = canon(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

describe("bun test runs against a temp SENTINAL_HOME", () => {
  it("SENTINAL_HOME is set, under os.tmpdir(), and not the real home", () => {
    const home = process.env.SENTINAL_HOME;
    expect(home).toBeTruthy();
    expect(isInside(home!, tmpdir())).toBe(true);
    expect(isInside(home!, REAL_HOME)).toBe(false);
    expect(getSentinalHome()).toBe(testHome.home);
  });

  it("the default DB path is not under the real ~/.sentinal", () => {
    expect(isInside(getDbPath(), REAL_HOME)).toBe(false);
    expect(isInside(getDbPath(), testHome.home)).toBe(true);
  });

  it("sidecar socket / port / pid all live under the temp home", () => {
    for (const p of [
      getSidecarSocketPath(),
      getSidecarPortPath(),
      getSidecarPidPath(),
    ]) {
      expect(isInside(p, testHome.home)).toBe(true);
      expect(isInside(p, REAL_HOME)).toBe(false);
    }
  });

  it("SidecarClient.connect() cannot reach the user's live sidecar", async () => {
    // No test sidecar runs at the temp home, so there is nothing to reach.
    expect(existsSync(getSidecarSocketPath())).toBe(false);
    expect(await SidecarClient.connect()).toBeNull();
  });

  it("load-time constants (DEPS_DIR) are frozen to the TEMP home, not the real one", () => {
    // The preload must set SENTINAL_HOME before evaluating any module that
    // snapshots it; a hoisted static import used to freeze DEPS_DIR to ~/.sentinal.
    expect(isInside(DEPS_DIR, REAL_HOME)).toBe(false);
    expect(DEPS_DIR).toBe(getDepsDir());
  });

  it("the model cache is a shared temp cache — never the real ~/.sentinal/models", () => {
    const models = getModelsCacheDir();
    expect(models).toBe(join(testHome.home, "models"));
    expect(isInside(models, REAL_HOME)).toBe(false); // follows the link
    // Symlinked to a cache that survives the run, so the 23 MB model is not
    // re-downloaded on every `bun test`.
    expect(lstatSync(models).isSymbolicLink()).toBe(true);
    expect(isInside(readlinkSync(models), tmpdir())).toBe(true);
  });
});

describe("decideTestHome", () => {
  const tmpRoot = canon(tmpdir());
  const realHome = "/Users/someone/.sentinal";
  const mkTemp = () => join(tmpRoot, "sentinal-test-home-FRESH");

  it("creates a fresh, owned home when SENTINAL_HOME is unset", () => {
    expect(decideTestHome(undefined, { tmpRoot, realHome, mkTemp })).toEqual({
      home: mkTemp(),
      owned: true,
    });
    expect(decideTestHome("", { tmpRoot, realHome, mkTemp }).owned).toBe(true);
  });

  it("honours a pre-set home under the temp root, without taking ownership", () => {
    const preset = join(tmpRoot, "sentinal-e2e-abc", ".sentinal");
    expect(decideTestHome(preset, { tmpRoot, realHome, mkTemp })).toEqual({
      home: preset,
      owned: false,
    });
  });

  it("refuses a pre-set home that is the real home (or inside it)", () => {
    for (const preset of [realHome, join(realHome, "sub")]) {
      const d = decideTestHome(preset, { tmpRoot, realHome, mkTemp });
      expect(d).toEqual({ home: mkTemp(), owned: true, refused: preset });
    }
  });

  it("refuses a pre-set home outside the temp root (it may be a real, relocated store)", () => {
    const preset = "/opt/sentinal-data";
    const d = decideTestHome(preset, { tmpRoot, realHome, mkTemp });
    expect(d).toEqual({ home: mkTemp(), owned: true, refused: preset });
  });

  it("does not treat a sibling-prefixed path as inside the temp root", () => {
    const preset = tmpRoot + "-evil/home";
    expect(decideTestHome(preset, { tmpRoot, realHome, mkTemp }).owned).toBe(true);
  });
});

describe("linkSharedModels / removeTestHome", () => {
  function scratch(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "sentinal-isolation-")));
  }

  it("seeds the shared cache from the real models dir (read-only) and links it", () => {
    const root = scratch();
    try {
      const real = join(root, "real-models");
      mkdirSync(join(real, "Xenova"), { recursive: true });
      writeFileSync(join(real, "Xenova", "model.onnx"), "weights");
      const shared = join(root, "shared");
      const home = join(root, "home");
      mkdirSync(home);

      linkSharedModels(home, shared, real);

      expect(readlinkSync(join(home, "models"))).toBe(shared);
      expect(existsSync(join(home, "models", "Xenova", "model.onnx"))).toBe(true);
      // The real dir is only read: still exactly as it was.
      expect(existsSync(join(real, "Xenova", "model.onnx"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("links an empty shared cache when there is no real models dir", () => {
    const root = scratch();
    try {
      const home = join(root, "home");
      mkdirSync(home);
      linkSharedModels(home, join(root, "shared"), join(root, "absent"));
      expect(lstatSync(join(home, "models")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(root, "shared"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replace an existing shared cache", () => {
    const root = scratch();
    try {
      const shared = join(root, "shared");
      mkdirSync(shared);
      writeFileSync(join(shared, "keep"), "x");
      const real = join(root, "real");
      mkdirSync(real);
      writeFileSync(join(real, "other"), "y");
      const home = join(root, "home");
      mkdirSync(home);
      linkSharedModels(home, shared, real);
      expect(existsSync(join(shared, "keep"))).toBe(true);
      expect(existsSync(join(shared, "other"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removeTestHome deletes the home but never follows the models symlink", () => {
    const root = scratch();
    try {
      const shared = join(root, "shared");
      mkdirSync(shared);
      writeFileSync(join(shared, "model.onnx"), "weights");
      const home = join(root, "home");
      mkdirSync(home);
      writeFileSync(join(home, "memory.db"), "db");
      symlinkSync(shared, join(home, "models"));

      removeTestHome(home);

      expect(existsSync(home)).toBe(false);
      expect(existsSync(join(shared, "model.onnx"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sweepStaleTestHomes", () => {
  it("removes only sentinal-test-home-* dirs older than the cutoff", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-isolation-sweep-")));
    try {
      const old = join(root, "sentinal-test-home-OLD");
      const fresh = join(root, "sentinal-test-home-NEW");
      const other = join(root, "unrelated-OLD");
      for (const d of [old, fresh, other]) mkdirSync(d);
      const past = new Date(Date.now() - 48 * 3600_000);
      utimesSync(old, past, past);
      utimesSync(other, past, past);

      const removed = sweepStaleTestHomes(root, 24 * 3600_000);

      expect(removed).toEqual([old]);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws on an unreadable root", () => {
    expect(sweepStaleTestHomes("/definitely/not/here", 1)).toEqual([]);
  });
});

describe("the preload end to end (subprocess)", () => {
  it("a fresh run creates its own temp home and deletes it at exit", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-isolation-probe-")));
    try {
      const probe = join(dir, "probe.test.ts");
      writeFileSync(
        probe,
        `import { it } from "bun:test";\n` +
          `import { getDbPath } from ${JSON.stringify(join(import.meta.dir, "db-path.ts"))};\n` +
          `it("p", () => { getDbPath(); console.log("HOME=" + process.env.SENTINAL_HOME); });\n`,
      );
      const env = { ...process.env } as Record<string, string>;
      delete env.SENTINAL_HOME; // otherwise the child would honour OUR home
      const r = Bun.spawnSync(["bun", "test", probe], {
        cwd: join(import.meta.dir, "..", ".."), // repo root → bunfig preload
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = r.stdout.toString() + r.stderr.toString();
      expect(r.exitCode).toBe(0);
      const m = out.match(/HOME=(\S+)/);
      expect(m).not.toBeNull();
      const childHome = m![1];
      expect(childHome).not.toBe(process.env.SENTINAL_HOME);
      expect(isInside(childHome, tmpdir())).toBe(true);
      expect(existsSync(childHome)).toBe(false); // cleaned up at exit
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
