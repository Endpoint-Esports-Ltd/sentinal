/**
 * Memory Configuration
 *
 * Loads and validates user configuration from ~/.sentinal/config.json.
 * Provides opt-out toggle for memory and other settings.
 *
 * Config file format:
 * {
 *   "memory": {
 *     "enabled": true
 *   }
 * }
 *
 * If the config file doesn't exist, defaults are used (memory enabled).
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getSentinalHome } from "./db-path.js";

// ─── Database Path ────────────────────────────────────────────────────────────

// The divergent `CLAUDE_PLUGIN_DATA`-aware `getDbPath` that used to live here
// was absorbed into `./db-path.ts` (Task 6a of
// docs/plans/2026-09-01-audit-high-remediation.md). It is re-exported under
// its old name solely for `config.test.ts`; production resolves the DB path
// via `getDbPath` in `./db-path.ts` (re-exported from `./store.ts`).
export { getPluginAwareDbPath as getDbPath } from "./db-path.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryConfig {
  memory: {
    /** Whether persistent memory is enabled (default: true) */
    enabled: boolean;
  };
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MemoryConfig = {
  memory: {
    enabled: true,
  },
};

// ─── Loader ───────────────────────────────────────────────────────────────────

let cachedConfig: MemoryConfig | null = null;

/**
 * Get the config file path (`$SENTINAL_HOME/config.json`, D2 seam —
 * defaults to `~/.sentinal/config.json`). A READ path, routed for test
 * determinism: a user's real config must never leak into test runs.
 */
export function getConfigPath(): string {
  return join(getSentinalHome(), "config.json");
}

/**
 * Load configuration from disk. Returns defaults if file doesn't exist
 * or is invalid. Result is cached after first load.
 */
export function loadConfig(): MemoryConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();

  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      cachedConfig = mergeWithDefaults(raw);
    } else {
      cachedConfig = { ...DEFAULT_CONFIG };
    }
  } catch {
    // Invalid JSON or read error — use defaults
    cachedConfig = { ...DEFAULT_CONFIG };
  }

  return cachedConfig;
}

/**
 * Check if memory is enabled. Convenience function for guard clauses.
 */
export function isMemoryEnabled(): boolean {
  return loadConfig().memory.enabled;
}

/**
 * Clear the config cache. Useful for testing.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mergeWithDefaults(raw: unknown): MemoryConfig {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };

  const obj = raw as Record<string, unknown>;
  const memory =
    typeof obj.memory === "object" && obj.memory !== null
      ? (obj.memory as Record<string, unknown>)
      : {};

  return {
    memory: {
      enabled:
        typeof memory.enabled === "boolean"
          ? memory.enabled
          : DEFAULT_CONFIG.memory.enabled,
    },
  };
}
