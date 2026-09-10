/**
 * Locate, parse, validate and interpolate `.sentinal/runtime.json`.
 *
 * ## The one rule everything else is subordinate to
 *
 * **An absent file is an inert SUCCESS, not an error.** A project that never
 * adopts the contract must behave byte-identically to how it behaved before
 * the contract existed — no warning, no context line, no new code path. That
 * is the master plan's headline backward-compatibility guarantee, and it is
 * the reason {@link LoadedRuntimeConfig.warnings} and
 * {@link LoadedRuntimeConfig.unknownResources} are both empty in that case
 * rather than "helpfully" populated.
 *
 * ## Direction of dependency
 *
 * `src/runtime/` imports **from** `src/worktree/` (for the slot and the
 * ignore probe). `src/worktree/` must import **nothing** from here — a
 * `worktree → runtime → worktree` cycle is asserted against in
 * `no-module-cycle.test.ts`. The R11 enrichment therefore travels as data (an
 * optional `sharedResources` on `SeedOptions`), not as an import.
 *
 * ## Failure semantics
 *
 * This function **never throws**. A malformed contract is a *reportable*
 * condition, not a crash: the caller — an MCP tool, and later Phase 4's
 * runner — needs to tell the human which file and which field, and it cannot
 * do that from an exception thrown three frames deep during session startup.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIgnored } from "../worktree/git-exclude.js";
import { readSlotFromWorktree } from "../worktree/slots.js";
import { stripJsonComments } from "./jsonc.js";
import { interpolateStrict } from "./interpolate.js";
import {
  RESOURCE_CLASSES,
  RUNTIME_CONFIG_RELATIVE_PATH,
  RuntimeConfigSchema,
  sharedResourceNames,
  type ResourceClass,
  type RuntimeConfig,
} from "./schema.js";

// ─── Result ─────────────────────────────────────────────────────────────────

export interface LoadedRuntimeConfig {
  /** Absolute path inspected — always set, even when nothing is there. */
  path: string;
  /** Repo-relative form, for messages. */
  relPath: string;
  /** True when the file EXISTS. Says nothing about whether it is valid. */
  configured: boolean;
  /** The validated, interpolated contract — `null` when absent or invalid. */
  config: RuntimeConfig | null;
  /** The slot used for interpolation, or `null` for a slotless directory. */
  slot: number | null;
  /**
   * Resources explicitly declared `"shared"`. ⛔ **Only these gate anything.**
   */
  sharedResources: string[];
  /**
   * Classes with no declaration. Report these **non-blockingly** — they are
   * context, never a prompt. Empty when there is no file, because an
   * unconfigured project must not acquire a new line of noise on every run.
   */
  unknownResources: ResourceClass[];
  /** Non-fatal. Safe to show; never a reason to stop. */
  warnings: string[];
  /** Fatal for THIS file: it exists but could not be used. `null` otherwise. */
  error: string | null;
}

function notConfigured(path: string): LoadedRuntimeConfig {
  return {
    path,
    relPath: RUNTIME_CONFIG_RELATIVE_PATH,
    configured: false,
    config: null,
    slot: null,
    sharedResources: [],
    unknownResources: [],
    warnings: [],
    error: null,
  };
}

// ─── Warnings ───────────────────────────────────────────────────────────────

/**
 * ⛔ Silent-failure mode, mirroring Phase 2's tier-3 precedent: name the risk
 * AND the remedy, not merely the fact.
 *
 * A negation inside an excluded directory is **inert** — git never descends
 * into a pruned directory, so `!runtime.json` cannot re-include a file when a
 * parent `.gitignore` carries `.sentinal/`. The contract then works perfectly
 * on the author's machine and does not exist for anyone else, which is the
 * worst shape a failure can take.
 */
function parentIgnoreWarning(relPath: string): string {
  return (
    `${relPath} is IGNORED by git, so it will never reach your teammates or CI — the ` +
    `runtime contract would work on this machine and silently not exist anywhere else. ` +
    `The usual cause is a parent .gitignore containing \`.sentinal/\`: git does not ` +
    `descend into an excluded directory, so the \`!runtime.json\` negation inside ` +
    `.sentinal/.gitignore is inert. Remedy: replace \`.sentinal/\` in your root ` +
    `.gitignore with \`.sentinal/*\` (which git CAN descend into), or add ` +
    `\`!.sentinal/runtime.json\` after it, then \`git add -f ${relPath}\`.`
  );
}

/** No slot to substitute — leaving the placeholder beats inventing a value. */
function slotlessWarning(relPath: string, worktreePath: string): string {
  return (
    `${relPath} uses \${SENTINAL_WORKTREE_SLOT} but ${worktreePath} has no slot assigned, so ` +
    `the placeholder was LEFT IN PLACE. It was not substituted with an empty or invented ` +
    `value, because doing so would silently point the run at resources that are not this ` +
    `worktree's — most likely the main checkout's. The commands are therefore not ready to ` +
    `run as-is. Remedy: assign a slot (free one with worktree_cleanup, then re-run ` +
    `detection), or run from the main checkout where per-slot isolation does not apply.`
  );
}

// ─── Load ───────────────────────────────────────────────────────────────────

/**
 * Read the contract for `projectPath`.
 *
 * @param projectPath the repo root **or** worktree root to inspect. ⛔ Always
 *   an explicit argument — never `process.cwd()`. An MCP tool is invoked from
 *   whatever directory the agent host happens to be in, and silently reading a
 *   different project's contract is a data-corruption-shaped bug.
 */
export function loadRuntimeConfig(projectPath: string): LoadedRuntimeConfig {
  const path = join(projectPath, RUNTIME_CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) return notConfigured(path);

  const base = notConfigured(path);
  base.configured = true;
  const warnings: string[] = [];

  // The file exists locally; does it exist for anyone else?
  try {
    if (isIgnored(projectPath, RUNTIME_CONFIG_RELATIVE_PATH)) {
      warnings.push(parentIgnoreWarning(RUNTIME_CONFIG_RELATIVE_PATH));
    }
  } catch {
    // Not a repo, or no git — not this function's problem to report.
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(readFileSync(path, "utf-8")));
  } catch (err) {
    return {
      ...base,
      warnings,
      error:
        `${RUNTIME_CONFIG_RELATIVE_PATH} could not be parsed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Comments (// and /* */) are allowed; trailing commas are not.`,
    };
  }

  const result = RuntimeConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message)
      .join("\n  ");
    return {
      ...base,
      warnings,
      error: `${RUNTIME_CONFIG_RELATIVE_PATH} is invalid:\n  ${detail}`,
    };
  }

  // ── Substitution, once the slot is known ────────────────────────────────
  const slot = readSlotFromWorktree(projectPath);
  const config = result.data;
  const before = [config.up, config.down, config.readiness?.target];

  config.up = config.up ? interpolateStrict(config.up, slot) : config.up;
  config.down = config.down ? interpolateStrict(config.down, slot) : config.down;
  if (config.readiness) {
    config.readiness.target = interpolateStrict(config.readiness.target, slot);
  }

  // Warn only if a token actually survived — a config with no slot token has
  // nothing to say about slots, and an unconditional warning would be noise.
  if (
    slot === null &&
    before.some((v) => v?.includes("${SENTINAL_WORKTREE_SLOT}"))
  ) {
    warnings.push(
      slotlessWarning(RUNTIME_CONFIG_RELATIVE_PATH, projectPath),
    );
  }

  return {
    ...base,
    config,
    slot,
    sharedResources: sharedResourceNames(config),
    unknownResources: RESOURCE_CLASSES.filter(
      (c) => config.isolation?.[c] === undefined,
    ),
    warnings,
    error: null,
  };
}
