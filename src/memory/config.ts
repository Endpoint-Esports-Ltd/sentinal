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
import { existsSync, readFileSync, accessSync, mkdirSync, constants } from "node:fs";
import { homedir } from "node:os";
import { DB_CONSTANTS } from "./types.js";

// ─── Database Path ────────────────────────────────────────────────────────────

/**
 * Get the path to the memory database file.
 *
 * Priority:
 * 1. `${CLAUDE_PLUGIN_DATA}/sentinal.db` if the env var is set and the directory is writable
 * 2. `~/.sentinal/memory.db` (default)
 */
export function getDbPath(): string {
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
  const dir = join(homedir(), DB_CONSTANTS.DB_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, DB_CONSTANTS.DB_NAME);
}

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
 * Get the config file path: ~/.sentinal/config.json
 */
export function getConfigPath(): string {
  return join(homedir(), DB_CONSTANTS.DB_DIR, "config.json");
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
