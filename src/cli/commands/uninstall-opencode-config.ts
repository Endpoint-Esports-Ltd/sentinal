/**
 * Sentinal Uninstall — OpenCode config cleanup helpers
 *
 * Removes Sentinal-managed entries from an OpenCode config. M7b contract:
 * a managed key is removed ONLY if its current value deep-equals the shipped
 * default — customised values are preserved with a note in the output
 * (preserving too much is the acceptable failure direction; deleting user
 * config is not). `explore`/`general` task permissions are NEVER touched:
 * Sentinal cannot claim ownership of generic agent names, even though the
 * installer writes defaults for them.
 *
 * M7c: `cleanupOpenCodeConfigFile` owns the file write — `.bak` (latest-wins)
 * before every write/delete; an unparseable config is skipped, never
 * overwritten, never "started fresh".
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { err, info, ok, stripJsoncComments } from "../../utils/shell.js";
import {
  MCP_SERVERS_OPENCODE,
  OPENCODE_LSP_DEFAULT,
} from "./install-constants.js";
import { EMBEDDED_OC_CONFIG_JSON } from "../embedded-assets.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** MCP server keys managed by Sentinal. */
export const MCP_KEYS = [
  "context7",
  "web-search",
  "grep-mcp",
  "web-fetch",
  "sentinal",
];

/** All possible plugin path strings that may appear in the opencode config plugin array. */
const PLUGIN_PATH_PATTERNS = [
  "@endpoint/sentinal/opencode-plugin",
  "./plugins/sentinal.mjs",
  "./plugins/sentinal.ts",
  "./plugins/sentinal.js",
];

/**
 * Agent task permission keys Sentinal may remove (value-matched).
 * ⛔ `explore` and `general` are deliberately NOT here: generic names the
 * user may rely on for their own agents — never touched on uninstall.
 */
const SENTINAL_TASK_KEYS = ["plan-reviewer", "spec-reviewer"];

/** Edit permission glob keys managed by Sentinal. */
const SENTINAL_EDIT_PLAN_KEYS = [
  "docs/plans/*.md",
  "docs/plans/**/*.md",
  "docs/plans/*.json",
];

/** Shipped defaults, parsed once from the embedded opencode.json. */
const SHIPPED = JSON.parse(EMBEDDED_OC_CONFIG_JSON) as Record<string, unknown>;
const SHIPPED_PERMISSION =
  (SHIPPED.permission as Record<string, unknown>) ?? {};
const SHIPPED_AGENTS =
  (SHIPPED.agent as Record<string, Record<string, unknown>>) ?? {};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive structural equality — key-order-insensitive for objects. */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEquals(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((k) => k in b && deepEquals(a[k], b[k]));
  }
  return false;
}

/**
 * Remove a "*"-only residual block if its value matches what Sentinal
 * shipped for that block; a customised "*" means the block is user content.
 */
function removeResidualStar(
  parent: Record<string, unknown>,
  blockKey: string,
  block: Record<string, unknown>,
  shippedStar: unknown,
): void {
  const keys = Object.keys(block);
  if (keys.length === 0) {
    delete parent[blockKey];
  } else if (
    keys.length === 1 &&
    keys[0] === "*" &&
    shippedStar !== undefined &&
    deepEquals(block["*"], shippedStar)
  ) {
    delete parent[blockKey];
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Pure function to clean up Sentinal-managed entries from an OpenCode config
 * object. A managed key is removed only when its value deep-equals the
 * shipped default; customised values are preserved and reported via `notes`.
 * Returns a new config object (does not mutate input).
 */
export function cleanupOpenCodeConfig(
  input: Record<string, unknown>,
  notes: string[] = [],
): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;

  cleanupPlugins(config, notes);
  cleanupMcp(config, notes);
  cleanupPermission(config, notes);
  cleanupAgents(config, notes);

  return config;
}

/**
 * Basename match for the shipped plugin file — covers absolute-path variants
 * of `plugins/sentinal.mjs|ts|js`. Deliberately anchored on the exact
 * basename: `my-sentinal-extras.ts` must NOT match.
 */
const SENTINAL_PLUGIN_BASENAME = /(^|\/)sentinal\.(mjs|ts|js)$/;

/** Is this plugin entry one Sentinal itself installed? */
function isSentinalPluginEntry(p: string): boolean {
  return (
    PLUGIN_PATH_PATTERNS.includes(p) ||
    SENTINAL_PLUGIN_BASENAME.test(p) ||
    p === "@endpoint/sentinal" ||
    p.startsWith("@endpoint/sentinal/") ||
    p.startsWith("@endpoint/sentinal@")
  );
}

/**
 * Remove sentinal plugin entries (shape-validated: non-array left as-is).
 * Removal is tightly scoped to entries Sentinal itself installs (exact
 * patterns, the shipped plugin file's basename, the @endpoint/sentinal
 * package) — a user entry that merely MENTIONS sentinal is preserved with
 * a note, matching the customised-value paths' failure direction.
 */
function cleanupPlugins(
  config: Record<string, unknown>,
  notes: string[],
): void {
  if (config.plugin === undefined) return;
  if (!Array.isArray(config.plugin)) {
    notes.push("config.plugin is not an array — left untouched");
    return;
  }
  config.plugin = (config.plugin as unknown[]).filter((p) => {
    if (typeof p !== "string") return true;
    if (isSentinalPluginEntry(p)) return false;
    if (p.includes("sentinal")) {
      notes.push(
        `plugin "${p}" mentions sentinal but is not a Sentinal-managed entry — left in place`,
      );
    }
    return true;
  });
  if ((config.plugin as unknown[]).length === 0) delete config.plugin;
}

/** Remove managed MCP servers whose value still deep-equals the default. */
function cleanupMcp(config: Record<string, unknown>, notes: string[]): void {
  if (config.mcp === undefined) return;
  if (!isPlainObject(config.mcp)) {
    notes.push("config.mcp is not an object — left untouched");
    return;
  }
  const mcp = config.mcp;
  const defaults = MCP_SERVERS_OPENCODE as Record<string, unknown>;
  const shippedMcp = (SHIPPED.mcp as Record<string, unknown>) ?? {};
  for (const key of MCP_KEYS) {
    if (!(key in mcp)) continue;
    // `sentinal` is force-managed on install (its value carries the binary
    // path), so ANY value is Sentinal-written — always remove. Leaving it
    // would strand a server entry pointing at an uninstalled binary.
    if (
      key === "sentinal" ||
      deepEquals(mcp[key], defaults[key]) ||
      deepEquals(mcp[key], shippedMcp[key])
    ) {
      delete mcp[key];
    } else {
      notes.push(`mcp.${key} was customised — left in place`);
    }
  }
  if (Object.keys(mcp).length === 0) delete config.mcp;
}

/** Value-matched cleanup of the top-level permission block. */
function cleanupPermission(
  config: Record<string, unknown>,
  notes: string[],
): void {
  const perm = config.permission;
  if (!isPlainObject(perm)) return;

  if ("skill" in perm) {
    if (deepEquals(perm.skill, SHIPPED_PERMISSION.skill)) {
      delete perm.skill;
    } else {
      notes.push("permission.skill was customised — left in place");
    }
  }

  if (isPlainObject(perm.edit)) {
    const edit = perm.edit as Record<string, unknown>;
    const shippedEdit =
      (SHIPPED_PERMISSION.edit as Record<string, unknown>) ?? {};
    for (const key of SENTINAL_EDIT_PLAN_KEYS) {
      if (!(key in edit)) continue;
      if (deepEquals(edit[key], shippedEdit[key])) delete edit[key];
      else
        notes.push(`permission.edit["${key}"] was customised — left in place`);
    }
    removeResidualStar(perm, "edit", edit, shippedEdit["*"]);
  }

  if (Object.keys(perm).length === 0) delete config.permission;
}

/** Value-matched cleanup of the agents Sentinal shipped (build/plan only). */
function cleanupAgents(config: Record<string, unknown>, notes: string[]): void {
  const agents = config.agent;
  if (!isPlainObject(agents)) return;

  for (const [name, agentCfg] of Object.entries(agents)) {
    // Only agents Sentinal shipped defaults for are cleaned; a same-named
    // key on any other agent is the user's.
    const shippedAgent = SHIPPED_AGENTS[name];
    if (!isPlainObject(agentCfg) || !shippedAgent) continue;
    const permission = agentCfg.permission;
    if (!isPlainObject(permission)) continue;
    const shippedPerm =
      (shippedAgent.permission as Record<string, unknown>) ?? {};

    if (isPlainObject(permission.task)) {
      const task = permission.task as Record<string, unknown>;
      const shippedTask = (shippedPerm.task as Record<string, unknown>) ?? {};
      for (const key of SENTINAL_TASK_KEYS) {
        if (!(key in task)) continue;
        if (deepEquals(task[key], shippedTask[key])) delete task[key];
        else
          notes.push(
            `agent.${name}.permission.task["${key}"] was customised — left in place`,
          );
      }
      // A block still holding explore/general is never removed (never-touch).
      removeResidualStar(permission, "task", task, shippedTask["*"]);
    }

    if (isPlainObject(permission.edit)) {
      const edit = permission.edit as Record<string, unknown>;
      const shippedEdit = (shippedPerm.edit as Record<string, unknown>) ?? {};
      for (const key of SENTINAL_EDIT_PLAN_KEYS) {
        if (!(key in edit)) continue;
        if (deepEquals(edit[key], shippedEdit[key])) delete edit[key];
        else
          notes.push(
            `agent.${name}.permission.edit["${key}"] was customised — left in place`,
          );
      }
      removeResidualStar(permission, "edit", edit, shippedEdit["*"]);
    }

    if (Object.keys(permission).length === 0) delete agentCfg.permission;
    if (Object.keys(agentCfg).length === 0) delete agents[name];
  }
  if (Object.keys(agents).length === 0) delete config.agent;
}

// ─── Emptiness ──────────────────────────────────────────────────────────────

/**
 * Check if an opencode config is effectively empty after removing Sentinal
 * entries. `$schema` never counts as content; `lsp` counts as empty ONLY when
 * it still deep-equals the shipped default — a customised `lsp` block is user
 * content and the config file must survive (M7d).
 */
export function isConfigEffectivelyEmpty(
  config: Record<string, unknown>,
): boolean {
  return Object.keys(config).every((k) => {
    if (k === "$schema") return true;
    if (k === "lsp") return deepEquals(config.lsp, OPENCODE_LSP_DEFAULT);
    return false;
  });
}

// ─── File orchestration ─────────────────────────────────────────────────────

export interface CleanupConfigFileResult {
  status: "cleaned" | "removed" | "skipped-unparseable" | "not-found";
  configFile?: string;
  notes: string[];
}

/**
 * Find, clean, and rewrite (or delete) the OpenCode config in `configDir`.
 * Owns the M7c write-safety contract: `.bak` (latest-wins) before every
 * write/delete; unparseable config → skip with a warning, file untouched.
 */
export function cleanupOpenCodeConfigFile(
  configDir: string,
): CleanupConfigFileResult {
  let configFile: string | null = null;
  if (existsSync(join(configDir, "opencode.json"))) {
    configFile = join(configDir, "opencode.json");
  } else if (existsSync(join(configDir, "opencode.jsonc"))) {
    configFile = join(configDir, "opencode.jsonc");
  }
  if (!configFile) {
    info("  ! No opencode config found");
    return { status: "not-found", notes: [] };
  }

  const originalRaw = readFileSync(configFile, "utf-8");
  let content = originalRaw;
  if (configFile.endsWith(".jsonc")) content = stripJsoncComments(content);

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(content) as Record<string, unknown>;
  } catch (e) {
    err(
      `  ! Config cleanup skipped — could not parse ${configFile}: ` +
        `${e instanceof Error ? e.message : String(e)}. File left untouched.`,
    );
    return { status: "skipped-unparseable", configFile, notes: [] };
  }

  const notes: string[] = [];
  const cleaned = cleanupOpenCodeConfig(config, notes);
  for (const n of notes) info(`  ! ${n}`);

  // Back up the pre-write content before any modification — latest-wins.
  writeFileSync(`${configFile}.bak`, originalRaw);

  if (isConfigEffectivelyEmpty(cleaned)) {
    unlinkSync(configFile);
    ok(`  Config was Sentinal-only, removed: ${configFile} (.bak kept)`);
    return { status: "removed", configFile, notes };
  }

  writeFileSync(configFile, JSON.stringify(cleaned, null, 2) + "\n");
  ok("  Sentinal entries removed from config");
  return { status: "cleaned", configFile, notes };
}
