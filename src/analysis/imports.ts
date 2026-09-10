/**
 * Parsed-import resolution.
 *
 * Promoted from `src/runtime/no-module-cycle.test.ts:28-71`, where the same
 * approach — extract specifiers, resolve each one against the *importing
 * file's* directory, strip the extension, compare **resolved paths** — had
 * already been proven. It replaces the basename grep in `helpers.ts`, which was
 * file-granular, single-hop and substring-matched, and so produced both false
 * positives (barrel re-exports, comments, any path containing the substring)
 * and false negatives (every transitive caller).
 *
 * Additions this module makes over the original:
 *   - re-exports (`export … from`) are classified separately and do NOT create
 *     an importer edge — a barrel forwards a symbol, it does not call it
 *   - comments are stripped before scanning
 *   - the graph is inverted and traversed transitively, with cycle protection
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// --- Types ---

export type SpecifierKind = "import" | "reexport";

export interface ParsedSpecifier {
  specifier: string;
  kind: SpecifierKind;
}

export interface ImportGraph {
  /** module id → ids of modules that import it (direct edges only). */
  importers: Map<string, Set<string>>;
  /** every module id discovered in the scanned tree. */
  modules: Set<string>;
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".sentinal",
  ".next",
  "out",
]);

/** Canonical id for a file: absolute path with the extension removed. */
export function moduleId(absPath: string): string {
  return absPath.replace(SOURCE_EXT, "");
}

// --- Parsing ---

/**
 * Remove line and block comments so a specifier mentioned in prose is not
 * mistaken for a dependency. The `[^:]` guard keeps `https://` intact.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * `import`/`export … from "…"` — the leading keyword is captured so a
 * re-export can be told apart from an import.
 */
const FROM_RE =
  /\b(import|export)\b(?:[^;{}]*(?:\{[^}]*\})?[^;{}]*?)\bfrom\s*(["'])([^"']+)\2/g;
const REQUIRE_RE = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
const DYNAMIC_RE = /\bimport\(\s*(["'])([^"']+)\1\s*\)/g;

/** Every module specifier in a source text, tagged as import or re-export. */
export function parseImports(text: string): ParsedSpecifier[] {
  const src = stripComments(text);
  const out: ParsedSpecifier[] = [];

  for (const m of src.matchAll(FROM_RE)) {
    out.push({
      specifier: m[3]!,
      kind: m[1] === "export" ? "reexport" : "import",
    });
  }
  for (const m of src.matchAll(REQUIRE_RE)) {
    out.push({ specifier: m[2]!, kind: "import" });
  }
  for (const m of src.matchAll(DYNAMIC_RE)) {
    out.push({ specifier: m[2]!, kind: "import" });
  }
  return out;
}

// --- Graph ---

function walkSources(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkSources(full, out);
    } else if (SOURCE_EXT.test(e.name)) {
      out.push(full);
    }
  }
}

/**
 * Roots to scan. `src/` when it exists — preserving the scope the grep had —
 * otherwise the project root.
 */
function scanRoots(project: string): string[] {
  const src = join(project, "src");
  try {
    if (existsSync(src) && statSync(src).isDirectory()) return [src];
  } catch {
    /* fall through */
  }
  return [project];
}

/**
 * Build the inverted import graph for a project.
 *
 * Only relative specifiers are resolved; bare (package) specifiers leave the
 * tree and are irrelevant to in-repo reach.
 */
export function buildImportGraph(project: string): ImportGraph {
  const files: string[] = [];
  for (const root of scanRoots(project)) walkSources(root, files);

  const modules = new Set(files.map(moduleId));
  const importers = new Map<string, Set<string>>();

  for (const file of files) {
    const from = moduleId(file);
    const dir = dirname(file);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const { specifier, kind } of parseImports(text)) {
      // A barrel forwards a symbol; it does not call it.
      if (kind === "reexport") continue;
      if (!specifier.startsWith(".")) continue;

      let target = moduleId(resolve(dir, specifier));
      if (!modules.has(target) && modules.has(join(target, "index"))) {
        target = join(target, "index");
      }
      if (!modules.has(target) || target === from) continue;

      let set = importers.get(target);
      if (!set) {
        set = new Set<string>();
        importers.set(target, set);
      }
      set.add(from);
    }
  }

  return { importers, modules };
}

/**
 * Every module that reaches `target`, directly or transitively.
 * `target` itself is never included, even when a cycle leads back to it.
 */
export function transitiveImporters(
  graph: ImportGraph,
  target: string,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [target];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const importer of graph.importers.get(current) ?? []) {
      if (importer === target || seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return seen;
}

/**
 * Number of modules that reach `relPath` (relative to `project`), transitively.
 * Returns 0 when the file is not part of the scanned tree.
 */
export function countTransitiveImporters(
  relPath: string,
  project: string,
  graph?: ImportGraph,
): number {
  const g = graph ?? buildImportGraph(project);
  const target = moduleId(resolve(project, relPath));
  if (!g.modules.has(target)) return 0;
  return transitiveImporters(g, target).size;
}
