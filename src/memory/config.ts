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
import { homedir } from "node:os";
import { DB_CONSTANTS } from "./types.js";

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
