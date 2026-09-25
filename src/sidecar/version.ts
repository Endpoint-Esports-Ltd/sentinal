/**
 * Sidecar Version Helper (M2c)
 *
 * Single source for "what version of sentinal is this process running?".
 * Used by /health (server side) and the client's advisory skew check.
 *
 * Resolution order (same pattern as serve.ts / self-heal.ts):
 *   1. `__SENTINAL_VERSION__` — injected at compile time by `bun build --define`.
 *   2. package.json relative to this source file (source/dev mode).
 *   3. "0.0.0" — never throws.
 *
 * ⛔ node:* imports ONLY, lazily — client.ts is hook-reachable and must stay
 * dependency-light (same rule as utils/file-log.ts).
 */

declare const __SENTINAL_VERSION__: string | undefined;

let cached: string | null = null;

export function getSentinalVersion(): string {
  if (typeof __SENTINAL_VERSION__ !== "undefined") {
    return __SENTINAL_VERSION__;
  }
  if (cached !== null) return cached;
  try {
    // Lazy by design (see header ⛔): client.ts is hook-reachable, and the
    // compiled binary never takes this branch (__SENTINAL_VERSION__ is set).
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: dev-mode-only fallback on a hook-reachable path
    const { readFileSync } = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: see above
    const { join, dirname } = require("node:path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: see above
    const { fileURLToPath } = require("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
