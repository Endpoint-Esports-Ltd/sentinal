/**
 * Sentinal Config Command
 *
 * CLI commands for managing settings stored in SQLite.
 *
 * Usage:
 *   sentinal config list              List all settings
 *   sentinal config get <key>         Get a setting (supports dot-path: model_routing.planning)
 *   sentinal config set <key> <value> Set a setting (supports dot-path for nested JSON)
 *   sentinal config reset [--yes]     Reset all settings to defaults
 */

import type { Command } from "commander";
import { MemoryStore } from "../../memory/store.js";
import {
  getModelRouting,
  setModelRouting,
  resetModelRouting,
  resolveModelRouting,
  applyModelRouting,
  findInstalledPluginDirs,
} from "../../config/model-routing.js";
import {
  DEFAULT_MODEL_ROUTING,
  MODEL_ROUTING_KEY,
} from "../../config/types.js";

// --- Register ---

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Manage settings — list, get, set, reset");

  config
    .command("list")
    .description("List all settings")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const store = new MemoryStore();
      const settings = store.listSettings();

      if (settings.length === 0) {
        // Show defaults even if nothing stored
        if (opts.json) {
          console.log(JSON.stringify({ model_routing: DEFAULT_MODEL_ROUTING }));
        } else {
          console.log("No custom settings. Defaults:");
          console.log(
            `  model_routing = ${JSON.stringify(DEFAULT_MODEL_ROUTING, null, 2).split("\n").join("\n  ")}`,
          );
        }
        store.close();
        return;
      }

      if (opts.json) {
        const obj: Record<string, unknown> = {};
        for (const s of settings) {
          try {
            obj[s.key] = JSON.parse(s.value);
          } catch {
            obj[s.key] = s.value;
          }
        }
        console.log(JSON.stringify(obj, null, 2));
      } else {
        for (const s of settings) {
          console.log(`  ${s.key} = ${s.value}`);
        }
      }

      store.close();
    });

  config
    .command("get <key>")
    .description(
      "Get a setting value (supports dot-path: model_routing.planning)",
    )
    .option("--json", "Output as JSON")
    .action((key: string, opts: { json?: boolean }) => {
      const store = new MemoryStore();
      const [rootKey, ...subPath] = key.split(".");

      const raw = store.getSetting(rootKey);

      if (raw === null) {
        // Check if it's a known key with defaults
        if (rootKey === MODEL_ROUTING_KEY) {
          const defaults = DEFAULT_MODEL_ROUTING;
          const value =
            subPath.length > 0 ? resolveSubPath(defaults, subPath) : defaults;
          outputValue(value, opts.json);
        } else {
          console.log(`Setting "${rootKey}" not found.`);
        }
        store.close();
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        const value =
          subPath.length > 0 ? resolveSubPath(parsed, subPath) : parsed;
        outputValue(value, opts.json);
      } catch {
        outputValue(raw, opts.json);
      }

      store.close();
    });

  config
    .command("set <key> <value>")
    .description(
      "Set a setting (supports dot-path: model_routing.planning opus)",
    )
    .action((key: string, value: string) => {
      const store = new MemoryStore();
      const [rootKey, ...subPath] = key.split(".");

      if (rootKey === MODEL_ROUTING_KEY && subPath.length > 0) {
        // Dot-path update for model_routing
        const partial: Record<string, string> = {};
        partial[subPath[0]] = value;
        const result = setModelRouting(store, partial);
        console.log(`Updated ${key} = "${value}"`);
        console.log(`  model_routing = ${JSON.stringify(result)}`);
        // Apply to installed plugin files immediately (with env var overrides)
        const dirs = findInstalledPluginDirs();
        if (dirs.length > 0) {
          const resolved = resolveModelRouting(store);
          const { patched } = applyModelRouting(dirs, resolved);
          if (patched.length > 0) {
            console.log(
              `  Applied to ${patched.length} installed plugin file(s)`,
            );
          }
        }
      } else if (subPath.length > 0) {
        // Generic dot-path: read existing, set nested, write back
        const existing = store.getSetting(rootKey);
        let obj: Record<string, unknown> = {};
        if (existing) {
          try {
            obj = JSON.parse(existing);
          } catch {
            /* start fresh */
          }
        }
        obj[subPath[0]] = tryParseJson(value);
        store.setSetting(rootKey, JSON.stringify(obj));
        console.log(`Updated ${key} = ${JSON.stringify(tryParseJson(value))}`);
      } else {
        // Direct set — try to detect JSON vs plain string
        const parsed = tryParseJson(value);
        store.setSetting(rootKey, JSON.stringify(parsed));
        console.log(`Set ${rootKey} = ${JSON.stringify(parsed)}`);
      }

      store.close();
    });

  config
    .command("reset")
    .description("Reset all settings to defaults")
    .option("-y, --yes", "Skip confirmation prompt")
    .action((opts: { yes?: boolean }) => {
      if (!opts.yes) {
        console.log("This will reset all settings to defaults.");
        console.log("Use --yes to confirm: sentinal config reset --yes");
        return;
      }

      const store = new MemoryStore();
      const settings = store.listSettings();
      for (const s of settings) {
        store.deleteSetting(s.key);
      }
      console.log(`Reset ${settings.length} setting(s) to defaults.`);
      // Restore default model routing in installed plugin files
      const dirs = findInstalledPluginDirs();
      if (dirs.length > 0) {
        const { patched } = applyModelRouting(dirs, DEFAULT_MODEL_ROUTING);
        if (patched.length > 0) {
          console.log(
            `  Restored default model routing in ${patched.length} plugin file(s)`,
          );
        }
      }
      store.close();
    });
}

// --- Helpers ---

function resolveSubPath(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function outputValue(value: unknown, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else if (typeof value === "object" && value !== null) {
    console.log(JSON.stringify(value, null, 2));
  } else if (value === undefined) {
    console.log("(not set)");
  } else {
    console.log(String(value));
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
