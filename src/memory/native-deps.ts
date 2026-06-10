/**
 * Native Dependency Resolution
 *
 * `@xenova/transformers` and `sqlite-vec` cannot live inside `bun --compile`
 * binaries (native .node/.dylib artifacts resolve from node_modules, which
 * does not exist inside a standalone executable). Both are therefore marked
 * external at build time, and this module resolves them at runtime:
 *
 *   1. Bare import — works when running from source (repo node_modules)
 *   2. ~/.sentinal/deps/node_modules — provisioned by `sentinal memory setup`
 *
 * All resolvers degrade to null; `nativeDepsStatus()` reports what's missing
 * with the remediation command so callers can surface it loudly.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir, platform, arch } from "node:os";
import { DB_CONSTANTS } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Where `sentinal memory setup` installs runtime deps for compiled binaries. */
export const DEPS_DIR = join(homedir(), DB_CONSTANTS.DB_DIR, "deps");

export const SETUP_HINT = "Run: sentinal memory setup";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal surface of @xenova/transformers that we use. */
export interface TransformersModule {
  pipeline: (task: string, model?: string) => Promise<unknown>;
  env: {
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    useBrowserCache?: boolean;
    cacheDir?: string;
  };
}

interface SqliteVecModule {
  getLoadablePath: () => string;
}

export interface ResolveOptions {
  /** Injectable importer for tests. Defaults to dynamic import(). */
  importer?: (specifier: string) => Promise<unknown>;
  /** Override deps directory for tests. Defaults to DEPS_DIR. */
  depsDir?: string;
  /** Collector for resolution error details (diagnosis). */
  errors?: string[];
}

export interface NativeDepsStatus {
  transformers: boolean;
  sqliteVec: boolean;
  /** Remediation command when anything is missing, null when all available. */
  hint: string | null;
  /** Captured resolution errors (empty when everything resolved). */
  errors: string[];
}

// ─── Resolution ───────────────────────────────────────────────────────────────

const defaultImporter = (specifier: string): Promise<unknown> =>
  import(specifier);

/**
 * Resolve @xenova/transformers: bare import, then the deps-dir entry point
 * (read from its package.json `module`/`main` field). Returns null when
 * unavailable — callers surface SETUP_HINT.
 */
export async function resolveTransformers(
  opts: ResolveOptions = {},
): Promise<TransformersModule | null> {
  const importer = opts.importer ?? defaultImporter;
  const depsDir = opts.depsDir ?? DEPS_DIR;
  const errors = opts.errors;

  try {
    return (await importer("@xenova/transformers")) as TransformersModule;
  } catch (e) {
    errors?.push(`transformers bare import: ${(e as Error).message}`);
  }

  try {
    const pkgDir = join(depsDir, "node_modules", "@xenova", "transformers");
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      errors?.push(`transformers deps dir: ${pkgJsonPath} not found`);
      return null;
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
      module?: string;
      main?: string;
    };
    const entry = pkg.module ?? pkg.main;
    if (!entry) {
      errors?.push("transformers deps dir: package.json has no main/module");
      return null;
    }
    const entryUrl = pathToFileURL(join(pkgDir, entry)).href;
    return (await importer(entryUrl)) as TransformersModule;
  } catch (e) {
    errors?.push(`transformers deps dir import: ${(e as Error).message}`);
  }

  // Last resort for compiled binaries: dynamic import() of external files
  // does not walk node_modules for the file's OWN bare imports, but a
  // createRequire anchored inside the deps dir does (Bun supports require()
  // of ESM). Only attempted when the import() path failed.
  try {
    const { createRequire } = await import("node:module");
    const anchor = join(depsDir, "node_modules", "sentinal-anchor.cjs");
    const req = createRequire(anchor);
    return req("@xenova/transformers") as TransformersModule;
  } catch (e) {
    errors?.push(`transformers createRequire: ${(e as Error).message}`);
    return null;
  }
}

/** npm publishes per-platform packages: sqlite-vec-darwin-arm64 etc. */
function sqliteVecPlatformPackage(): string {
  return `sqlite-vec-${platform()}-${arch()}`;
}

/**
 * Resolve the sqlite-vec loadable extension path: bare import's
 * getLoadablePath(), then the platform package inside the deps dir.
 */
export async function resolveSqliteVecPath(
  opts: ResolveOptions = {},
): Promise<string | null> {
  const importer = opts.importer ?? defaultImporter;
  const depsDir = opts.depsDir ?? DEPS_DIR;
  const errors = opts.errors;

  try {
    const mod = (await importer("sqlite-vec")) as SqliteVecModule;
    const path = mod.getLoadablePath();
    if (path && existsSync(path)) return path;
    if (path && opts.importer) return path; // injected importer in tests
  } catch (e) {
    errors?.push(`sqlite-vec bare import: ${(e as Error).message}`);
  }

  const ext = platform() === "darwin" ? ".dylib" : ".so";
  const fallback = join(
    depsDir,
    "node_modules",
    sqliteVecPlatformPackage(),
    `vec0${ext}`,
  );
  if (existsSync(fallback)) return fallback;
  errors?.push(`sqlite-vec deps dir: ${fallback} not found`);
  return null;
}

/** Availability report with remediation hint. */
export async function nativeDepsStatus(
  opts: ResolveOptions = {},
): Promise<NativeDepsStatus> {
  const errors: string[] = [];
  const optsWithErrors = { ...opts, errors };
  const [transformers, sqliteVecPath] = await Promise.all([
    resolveTransformers(optsWithErrors),
    resolveSqliteVecPath(optsWithErrors),
  ]);
  const transformersOk = transformers !== null;
  const sqliteVecOk = sqliteVecPath !== null;
  return {
    transformers: transformersOk,
    sqliteVec: sqliteVecOk,
    hint: transformersOk && sqliteVecOk ? null : SETUP_HINT,
    errors,
  };
}
