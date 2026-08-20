/**
 * Shared primitives for `sentinal install` / `sentinal update`.
 *
 * Pure helpers with no console output and no `process.exit()` — the pieces
 * both the Claude Code and the OpenCode installer need. Extracted from
 * `install.ts`, which had grown to ~1050 lines (Sentinal blocks at 600).
 *
 * ⛔ Extraction only: every function here is byte-identical in behaviour to
 * the version that lived in `install.ts`. `buildPluginList` and
 * `deepMergeAdditive` are re-exported from `install.ts` because
 * `install.test.ts` imports them from there.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Binary mode detection ──────────────────────────────────────────────────

/** True when running from compiled binary (no source tree / npm package). */
export function isBinaryMode(): boolean {
  return (process.argv[1] ?? "").startsWith("/$bunfs/");
}

/** Get the full path to the sentinal binary (for MCP server config). */
export function getSentinalBinPath(): string {
  const installed = join(homedir(), ".sentinal", "bin", "sentinal");
  if (existsSync(installed)) return installed;
  return "sentinal"; // fallback to PATH
}

// ─── Config merging ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Compute the `config.plugin` array for an OpenCode install.
 *
 * ⛔ The config entry is the ONLY load path for the binary-mode plugin file.
 * OpenCode's plugin loader (upstream packages/opencode/src/config/plugin.ts)
 * scans `{plugin,plugins}/*.{ts,js}` — `.mjs` is EXCLUDED from the glob, so
 * `plugins/sentinal.mjs` is never directory-auto-loaded. Removing this entry
 * (v1.31.2) silently disabled the entire plugin with no error anywhere.
 * Do not remove it again. Multiple same-timestamp init log lines are normal
 * per-instance plugin initialization (main/subagent/compaction instances),
 * NOT a double-load.
 *
 * Dedupes any legacy sentinal entries down to exactly one `pluginPath`.
 */
export function buildPluginList(
  existing: string[] | undefined,
  _binary: boolean,
  pluginPath: string,
): string[] {
  const others = (existing ?? []).filter((p) => !p.includes("sentinal"));
  return [...others, pluginPath];
}

/**
 * Additive deep merge: copies keys from `source` into `target` without
 * overwriting existing values. When both values are plain objects, recurse.
 * When the target already has a scalar or the source has a scalar, target wins.
 */
export function deepMergeAdditive(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (!(key in result)) {
      result[key] = source[key];
    } else if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMergeAdditive(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    }
    // else: target has a value (scalar or mismatched type) — keep it
  }
  return result;
}

// ─── Filesystem ─────────────────────────────────────────────────────────────

/** Safe readdirSync that returns [] if directory doesn't exist. */
export function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
