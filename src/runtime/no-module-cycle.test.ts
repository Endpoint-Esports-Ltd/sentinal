/**
 * ⛔ `src/worktree/` must import NOTHING from `src/runtime/`.
 *
 * The dependency runs one way only: `src/runtime/loader.ts` imports
 * `readSlotFromWorktree` and `isIgnored` from `src/worktree/`. If
 * `src/worktree/` imported the loader back — the obvious way to enrich
 * `notIsolatedWarning` with named shared resources — it would close a
 * `worktree → runtime → worktree` cycle.
 *
 * The R11 enrichment therefore travels as **data**: an optional
 * `sharedResources?: string[]` on `SeedOptions`, populated by whoever already
 * has a loaded config. A grep test is the right tool here precisely because
 * the cycle would still *compile* — ESM tolerates cycles and fails later, at
 * runtime, with an undefined binding that is miserable to diagnose.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

const SRC = join(import.meta.dir, "..");
const WORKTREE_DIR = join(SRC, "worktree");
const RUNTIME_DIR = join(SRC, "runtime");
/** The barrel re-exports the whole runtime domain (src/index.ts:274-306). */
const BARREL = join(SRC, "index");

/** Every `from "..."` / `require("...")` specifier in a file. */
function importsOf(path: string): string[] {
  const text = readFileSync(path, "utf-8");
  const out: string[] = [];
  for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push(m[1]!);
  }
  for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push(m[1]!);
  }
  return out;
}

/** `.ts` files under `dir`, recursively, as paths relative to `dir`. */
function walkTs(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkTs(join(dir, e.name), rel));
    else if (e.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

const withoutExt = (p: string) => p.replace(/\.(ts|tsx|js|mjs|cjs)$/, "");

/**
 * Resolve each relative specifier and reject anything that lands inside
 * `src/runtime/` **or** on the `src/index` barrel.
 *
 * Resolution beats a regex on two counts: it survives a future
 * `src/worktree/<subdir>/` (where the cycle reads `../../runtime/`), and it
 * catches the indirect cycle through the barrel, which re-exports the runtime
 * domain and so closes `worktree → index → runtime → worktree` just as surely.
 */
function offendersIn(file: string): string[] {
  const dir = dirname(file);
  return importsOf(file).filter((s) => {
    if (!s.startsWith(".")) return false;
    const abs = withoutExt(resolve(dir, s));
    if (abs === RUNTIME_DIR || abs.startsWith(RUNTIME_DIR + sep)) return true;
    return abs === BARREL;
  });
}

describe("no worktree → runtime module cycle", () => {
  const files = walkTs(WORKTREE_DIR);

  it("finds the worktree module (guard against a silently empty assertion)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("worktree-config.ts");
  });

  it.each(files)(
    "src/worktree/%s imports nothing from src/runtime/ (directly or via the barrel)",
    (f) => {
      expect(offendersIn(join(WORKTREE_DIR, f))).toEqual([]);
    },
  );

  it("src/runtime/ DOES import from src/worktree/ — the one legal direction", () => {
    // Asserted so that a refactor which accidentally severs it (and then
    // "resolves" the cycle by reversing it) is visible.
    const loader = importsOf(join(SRC, "runtime", "loader.ts"));
    expect(loader.some((s) => s.includes("../worktree/"))).toBe(true);
  });
});
