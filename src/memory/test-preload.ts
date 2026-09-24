/**
 * Test Preload
 *
 * 1. Redirects the whole `~/.sentinal` tree (DB, sidecar socket/port/pid,
 *    deps, models) to a per-run temp dir via `SENTINAL_HOME` (Task 6b — H6),
 *    so no test run can ever write into the real user store or reach the
 *    user's LIVE sidecar socket.
 * 2. Loads Homebrew SQLite before any Database instances are created.
 *    This enables sqlite-vec extension loading in tests.
 *
 * Must be loaded via bunfig.toml preload or test --preload flag.
 *
 * ⛔ ORDERING: `SENTINAL_HOME` must be set before ANY sentinal module is
 * evaluated — some snapshot it at load time (`native-deps.ts` `DEPS_DIR`).
 * Static `import`s are hoisted above top-level statements, so this file
 * imports only `node:*` statically and loads `vector-store.js` with a dynamic
 * `import()` AFTER the assignment. Do not turn that back into a static import.
 *
 * Why this exists: 205 "Fixed issue in foo.ts" rows leaked into the real
 * `~/.sentinal/memory.db` (2026-05-26 → 2026-09-01), one per full run, from
 * `src/hooks/memory-observer.test.ts` calling `processMemoryObserver()`, which
 * stores via the live sidecar or a default-path `MemoryStore`. Pinned by
 * `src/memory/test-isolation.test.ts`.
 */

import { afterAll } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export const TEST_HOME_PREFIX = "sentinal-test-home-";

export interface TestHomeDecision {
  home: string;
  /** True when this run created the home and must delete it at exit. */
  owned: boolean;
  /** A pre-set SENTINAL_HOME that was ignored as unsafe. */
  refused?: string;
}

/** realpath of the deepest existing ancestor + the rest (macOS /var → /private/var). */
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

/**
 * Choose this run's SENTINAL_HOME. A pre-set value is honoured only when it
 * is under the temp root and outside the real home: a nested `bun test` or a
 * harness shares its parent's temp home, but a developer's exported
 * `SENTINAL_HOME` (possibly a relocated REAL store) is never trusted.
 */
export function decideTestHome(
  preset: string | undefined,
  opts: { tmpRoot: string; realHome: string; mkTemp: () => string },
): TestHomeDecision {
  if (!preset) return { home: opts.mkTemp(), owned: true };
  const safe =
    isInside(preset, opts.tmpRoot) && !isInside(preset, opts.realHome);
  if (safe) return { home: preset, owned: false };
  return { home: opts.mkTemp(), owned: true, refused: preset };
}

/**
 * Point `<home>/models` at a cache that outlives the run, so the embedding
 * model is not re-downloaded on every `bun test`. The cache is seeded ONCE
 * by copying (read-only) from the real models dir when present; the real
 * dir is never linked, so a download can never write into it.
 */
export function linkSharedModels(
  home: string,
  sharedDir: string,
  realModelsDir: string,
): void {
  if (!existsSync(sharedDir)) {
    const parent = resolve(sharedDir, "..");
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(parent, ".sentinal-models-staging-"));
    try {
      if (existsSync(realModelsDir)) {
        cpSync(realModelsDir, staging, { recursive: true });
      }
      renameSync(staging, sharedDir); // atomic; loses to a concurrent seeder
    } catch {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(sharedDir, { recursive: true });
    }
  }
  symlinkSync(sharedDir, join(home, "models"));
}

/** Delete a test home. `rmSync` unlinks symlinks without following them. */
export function removeTestHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort at exit */
  }
}

/** Remove temp homes left behind by runs that died before their exit hook. */
export function sweepStaleTestHomes(root: string, maxAgeMs: number): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.startsWith(TEST_HOME_PREFIX)) continue;
    const dir = join(root, name);
    try {
      const st = statSync(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        removeTestHome(dir);
        removed.push(dir);
      }
    } catch {
      /* raced with another run */
    }
  }
  return removed;
}

const tmpRoot = tmpdir();
const realHome = join(homedir(), ".sentinal");

sweepStaleTestHomes(tmpRoot, 24 * 3600_000);

export const testHome: TestHomeDecision = decideTestHome(
  process.env.SENTINAL_HOME,
  {
    tmpRoot,
    realHome,
    mkTemp: () => mkdtempSync(join(tmpRoot, TEST_HOME_PREFIX)),
  },
);
process.env.SENTINAL_HOME = testHome.home;

if (testHome.owned) {
  try {
    linkSharedModels(
      testHome.home,
      join(tmpRoot, "sentinal-test-models"),
      join(realHome, "models"),
    );
  } catch {
    /* no shared cache — tests download into the temp home instead */
  }
  // NOT process.on("exit"/"beforeExit") — neither fires under `bun test`
  // (Bun 1.3.10, probed). A preload-level afterAll runs once after ALL files.
  afterAll(() => removeTestHome(testHome.home));
}

const { loadCustomSqlite } = await import("./vector-store.js");
loadCustomSqlite();
