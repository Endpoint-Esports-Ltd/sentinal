/**
 * Model Routing
 *
 * Convenience accessors for reading/writing model routing preferences
 * from the SQLite settings table. Falls back to defaults when no
 * setting exists or stored value is invalid.
 *
 * Also provides:
 * - resolveModelRouting: merges stored config with env var overrides
 * - applyModelRouting: patches model: frontmatter in installed plugin .md files
 * - findInstalledPluginDirs: discovers installed Sentinal plugin directories
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryStore } from "../memory/store.js";
import {
  ModelRoutingSchema,
  DEFAULT_MODEL_ROUTING,
  MODEL_ROUTING_KEY,
  type ModelRouting,
} from "./types.js";

/**
 * Get the current model routing config from the store.
 * Returns defaults if no setting exists or stored value is invalid.
 */
export function getModelRouting(store: MemoryStore): ModelRouting {
  const raw = store.getSetting(MODEL_ROUTING_KEY);
  if (!raw) return { ...DEFAULT_MODEL_ROUTING };

  try {
    const parsed = JSON.parse(raw);
    const result = ModelRoutingSchema.safeParse(parsed);
    return result.success ? result.data : { ...DEFAULT_MODEL_ROUTING };
  } catch {
    return { ...DEFAULT_MODEL_ROUTING };
  }
}

/**
 * Set model routing config. Merges partial updates with the current config.
 */
export function setModelRouting(
  store: MemoryStore,
  partial: Partial<ModelRouting>,
): ModelRouting {
  const current = getModelRouting(store);
  const merged = { ...current, ...partial };
  store.setSetting(MODEL_ROUTING_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Reset model routing to defaults by deleting the stored setting.
 */
export function resetModelRouting(store: MemoryStore): void {
  store.deleteSetting(MODEL_ROUTING_KEY);
}

// --- Env var overrides ---

const ENV_VAR_MAP: Record<keyof ModelRouting, string> = {
  planning: "SENTINAL_MODEL_PLANNING",
  implementation: "SENTINAL_MODEL_IMPLEMENTATION",
  verification: "SENTINAL_MODEL_VERIFICATION",
  plan_reviewer: "SENTINAL_MODEL_PLAN_REVIEWER",
  spec_reviewer: "SENTINAL_MODEL_SPEC_REVIEWER",
};

/**
 * Resolve model routing: stored config merged with env var overrides.
 * Env vars take precedence over stored config.
 */
export function resolveModelRouting(store: MemoryStore): ModelRouting {
  const config = getModelRouting(store);
  for (const [key, envVar] of Object.entries(ENV_VAR_MAP)) {
    const val = process.env[envVar];
    if (val) {
      (config as Record<string, string>)[key] = val;
    }
  }
  return config;
}

// --- Frontmatter patching ---

/** Maps skill filenames to their routing key. */
const FILE_ROUTING_MAP: Record<string, keyof ModelRouting> = {
  // commands/
  "spec-plan.md": "planning",
  "spec-bugfix-plan.md": "planning",
  "spec-master-plan.md": "planning",
  "spec-implement.md": "implementation",
  "spec-master-execute.md": "implementation",
  "spec-verify.md": "verification",
  "spec-bugfix-verify.md": "verification",
  // agents/
  "plan-reviewer.md": "plan_reviewer",
  "spec-reviewer.md": "spec_reviewer",
  "research.md": "spec_reviewer",
};

/**
 * Patch model: frontmatter in installed plugin .md files.
 * Replaces existing model: lines or adds one if missing (for files in the routing map).
 */
export function applyModelRouting(
  pluginDirs: string[],
  routing: ModelRouting,
): { patched: string[]; skipped: string[] } {
  const patched: string[] = [];
  const skipped: string[] = [];

  for (const dir of pluginDirs) {
    for (const subDir of ["commands", "agents"]) {
      const fullDir = join(dir, subDir);
      if (!existsSync(fullDir)) continue;

      let files: string[];
      try {
        files = readdirSync(fullDir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }

      for (const file of files) {
        const routingKey = FILE_ROUTING_MAP[file];
        if (!routingKey) {
          skipped.push(join(fullDir, file));
          continue;
        }

        const filePath = join(fullDir, file);
        const modelValue = routing[routingKey];

        try {
          let content = readFileSync(filePath, "utf-8");
          const hasModelLine = /^model:\s*\S+/m.test(content);

          if (hasModelLine) {
            content = content.replace(/^model:\s*\S+/m, `model: ${modelValue}`);
          } else {
            // Add model: after the first --- line
            content = content.replace(/^---\n/, `---\nmodel: ${modelValue}\n`);
          }

          writeFileSync(filePath, content);
          patched.push(filePath);
        } catch {
          skipped.push(filePath);
        }
      }
    }
  }

  return { patched, skipped };
}

/**
 * Find all installed Sentinal plugin directories by scanning ~/.claude/plugins/
 * for dirs containing commands/spec-plan.md.
 */
export function findInstalledPluginDirs(baseDir?: string): string[] {
  const root = baseDir ?? join(homedir(), ".claude", "plugins");
  if (!existsSync(root)) return [];

  const results: string[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > 5) return;

    // Check if this dir has commands/spec-plan.md
    if (existsSync(join(dir, "commands", "spec-plan.md"))) {
      results.push(dir);
      return; // Don't recurse further into a found plugin dir
    }

    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          scan(join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  scan(root, 0);
  return results;
}
