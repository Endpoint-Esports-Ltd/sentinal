/**
 * Database Path Resolution
 *
 * Single source of truth for where the memory database lives.
 * Extracted from `store.ts` (Task 6a of
 * docs/plans/2026-09-01-audit-high-remediation.md).
 *
 * ⛔ Must never import `bun:sqlite` (directly or transitively) — this module
 * is reachable from hook entry points via `config.ts`, and hooks must not pay
 * SQLite's cold-start cost.
 */

import { join } from "node:path";
import { mkdirSync, existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { DB_CONSTANTS } from "./types.js";

/**
 * The root of the sentinal state tree (Task 6b seam — H6).
 *
 * `SENTINAL_HOME`, when set, redirects the WHOLE `~/.sentinal` tree: the
 * memory DB here plus the sidecar socket/port/pid in `src/sidecar/paths.ts`.
 * A DB-only override would be insufficient — test pollution of the real user
 * store was observed arriving via the LIVE sidecar socket as well as via
 * direct `new MemoryStore()`. `src/memory/test-preload.ts` sets the var to a
 * per-run temp dir for every `bun test` invocation.
 *
 * Read fresh on every call (never cached at module load) so tests can
 * save/mutate/restore the env var safely.
 *
 * Unset-var behaviour is byte-identical to the pre-seam path:
 * `os.homedir()/.sentinal`.
 */
export function getSentinalHome(): string {
  const override = process.env.SENTINAL_HOME;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), DB_CONSTANTS.DB_DIR);
}

/**
 * The production DB path: `$SENTINAL_HOME/memory.db`, defaulting to
 * `~/.sentinal/memory.db` when the var is unset.
 */
export function getDbPath(): string {
  const dir = getSentinalHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, DB_CONSTANTS.DB_NAME);
}

/**
 * The documented-but-unwired `CLAUDE_PLUGIN_DATA` relocation variant,
 * absorbed from the former duplicate in `config.ts:37-59`.
 *
 * ⚠️ NOT used by any production code path — `MemoryStore` resolves via
 * `getDbPath()` above. It is kept (behaviour byte-equivalent) solely because
 * `config.test.ts` covers the documented relocation contract; whether to
 * enable it for real is Task 6b's decision
 * (docs/plans/2026-09-01-audit-high-remediation.md).
 *
 * Priority:
 * 1. `${CLAUDE_PLUGIN_DATA}/sentinal.db` if the env var is set and the directory is writable
 * 2. `~/.sentinal/memory.db` (default)
 */
export function getPluginAwareDbPath(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    const dbPath = join(pluginData, "sentinal.db");
    try {
      // Only create the directory if it doesn't already exist.
      // Check writability after creation attempt — if creation fails
      // (e.g. path is under a read-only root), the catch falls through.
      if (!existsSync(pluginData)) {
        mkdirSync(pluginData, { recursive: true });
      }
      accessSync(pluginData, constants.W_OK);
      return dbPath;
    } catch {
      // Fall through to default
    }
  }
  return getDbPath();
}
