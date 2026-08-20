/**
 * Isolated config seeding for a new worktree (D8).
 *
 * ## Why
 *
 * Git worktrees correctly do **not** inherit gitignored files, so a fresh
 * worktree has no `.env`. In the incident behind issue #2 the agent worked
 * around that by copying the **repo-root `.env`** in — which is why the worktree
 * hit LIVE databases. This module removes the *motive* for that copy by seeding
 * a per-slot `.env` from `.env.example` at creation time.
 *
 * It does **not** guarantee isolation. That is Phase 3's `isolation` map. When
 * the seed source carries no `${SENTINAL_WORKTREE_SLOT}` placeholder, the result
 * is a clean but shared config, and {@link notIsolatedWarning} says so in those
 * words. Phase 3 can enrich that one function with the specific shared resources
 * without restructuring any call site.
 *
 * ## Rules, in order
 *
 * 0. **⛔ NEVER overwrite an existing worktree `.env`.** Seeding runs at `create`
 *    *and* via `resolveWithReconcile`, which by nature operates on a directory
 *    that may already carry a hand-edited, untracked `.env`. Overwriting it is
 *    silent, unrecoverable loss. Skip and report.
 * 1. Discover seed sources at the repo root **and every workspace package root**
 *    — issue #2's reporter runs a TypeScript monorepo, for which root-only
 *    discovery finds nothing at all.
 * 2. No `.env.example` anywhere → **warn loudly**. Silence is precisely what
 *    sends the agent back to the root `.env`.
 * 3. Found but slot-free → seed verbatim **and state that it is not isolated**.
 * 4. Write the sourceable slot env file (`.sentinal/worktree.env`).
 * 5. Hide everything written via the Task 1 mechanism ({@link excludeFromGit}).
 *
 * ## Failure semantics
 *
 * - Missing / slot-free `.env.example` → **warn and continue**; the caller still
 *   gets a working worktree.
 * - I/O failure while reading or writing → **throw**. The caller's rollback
 *   envelope removes the git worktree *and* the DB row; a half-seeded worktree
 *   with no compensating teardown is worse than none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { excludeFromGit } from "./git-exclude.js";
import { SLOT_ENV_RELATIVE_PATH, SLOT_ENV_VAR } from "./slots.js";
import { discoverSeedSources, SEED_FILENAME } from "./seed-sources.js";

// Discovery lives in `seed-sources.ts` (it needs a pruned, depth-capped tree
// walk — see the module docblock there). Re-exported so this module stays the
// single import surface for seeding.
export { discoverSeedSources, workspacePackageDirs } from "./seed-sources.js";
export { SEED_FILENAME } from "./seed-sources.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** The token a project puts in `.env.example` to opt into per-slot isolation. */
export const SLOT_PLACEHOLDER = `\${${SLOT_ENV_VAR}}`;

/** What the seed source produces. */
export const SEED_TARGET_FILENAME = ".env";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SeedOptions {
  /** Repo root of the MAIN checkout — where seed sources are discovered. */
  repoRoot: string;
  /** The linked worktree to seed. */
  worktreePath: string;
  /** Allocated slot, or `null` for an unslotted (pre-V12 / exhausted) worktree. */
  slot: number | null;
  /**
   * Resources the project has explicitly declared `"shared"` (R11).
   *
   * ⛔ **Passed as DATA on purpose.** The natural implementation — have
   * {@link seedWorktreeConfig} call `loadRuntimeConfig` itself — would close a
   * `worktree → runtime → worktree` module cycle, since `src/runtime/loader.ts`
   * already imports {@link readSlotFromWorktree} from this directory. ESM
   * tolerates such a cycle at compile time and then fails at runtime with an
   * undefined binding, which is miserable to diagnose. Asserted against in
   * `src/runtime/no-module-cycle.test.ts`.
   *
   * Populate it from `loadRuntimeConfig(...).sharedResources`. Defaults to `[]`,
   * which reproduces Phase 2's warning **byte-for-byte** — the backward
   * compatibility guarantee for a project with no `.sentinal/runtime.json`.
   */
  sharedResources?: string[];
  /**
   * Every `${SENTINAL_*}` token in a seed source that is **not** in the closed
   * set — i.e. `unknownSentinalTokens` from `src/runtime/interpolate.ts`.
   *
   * ⛔ **Passed as DATA, for the same reason as {@link sharedResources}.**
   * `src/worktree/**` may import nothing from `src/runtime/**`, and
   * `src/runtime/no-module-cycle.test.ts` walks this file's tests too. The
   * production wiring is `WorktreeConfig.unknownSentinalTokens`, injected once
   * by `runtimeWorktreeConfig()`.
   *
   * ⛔ **Why the seeding path needs it at all.** The check was previously
   * applied to `runtime.json`'s three interpolated fields only, so a
   * `.env.example` containing `${SENTINAL_WORKTREE_SLOTT}` was seeded VERBATIM
   * with nothing but the generic "contains no placeholder" warning — and the
   * shell later expanded the typo to the empty string, pointing the worktree at
   * slot-less (i.e. the main checkout's) database. This is the path that writes
   * credentials config, so it is the path where the check matters most.
   *
   * Only `${SENTINAL_*}` is validated. `${PORT:-3000}` and bare `$VAR` belong to
   * the project and pass through verbatim (D6 as shipped).
   *
   * Optional here (unlike on `WorktreeConfig`) so the many direct unit-test
   * calls need not wire it; production reaches this through the required config
   * field.
   */
  unknownTokens?: (text: string) => string[];
  /**
   * Testing seam for staging an I/O failure deterministically. Production
   * callers omit it.
   */
  writeFile?: (absPath: string, content: string) => void;
}

export interface SeedResult {
  /** Worktree-relative paths written. */
  seeded: string[];
  /** Worktree-relative paths that already existed and were left untouched. */
  skipped: string[];
  /** Paths still VISIBLE to `git status` — see {@link excludeFromGit} tier 3. */
  unexcluded: string[];
  /** Human/LLM-facing. Never silently empty when something went unseeded. */
  warnings: string[];
}

// ─── Interpolation ──────────────────────────────────────────────────────────

/** True when `text` opts into per-slot isolation. */
export function hasSlotPlaceholder(text: string): boolean {
  return text.includes(SLOT_PLACEHOLDER);
}

/**
 * Substitute **every** occurrence of the slot placeholder. Unrelated `${...}`
 * tokens are left alone — they belong to the project, not to Sentinal.
 */
export function interpolateSlot(text: string, slot: number): string {
  return text.split(SLOT_PLACEHOLDER).join(String(slot));
}

// ─── Warnings ───────────────────────────────────────────────────────────────

/** Rule 2. Names the RISK and the remedy, not merely the absence. */
function noSeedSourceWarning(repoRoot: string): string {
  return (
    `No ${SEED_FILENAME} found in ${repoRoot} or in any workspace package. Sentinal seeded NO ` +
    `config into this worktree, so anything needing database or service credentials has nothing ` +
    `to start from — and the usual workaround is to copy the repo-root .env in, which points the ` +
    `worktree at LIVE databases (exactly the failure this seeding exists to prevent). ` +
    `Remedy: commit a ${SEED_FILENAME} with per-slot placeholders, e.g. ` +
    `DATABASE_URL=postgres://localhost:5432/app_${SLOT_PLACEHOLDER}`
  );
}

/**
 * Rule 2, unreadable variant. Discovery saw the file; the read did not. Carries
 * the same risk as a missing source, so it names the same trap.
 */
function unreadableSeedWarning(sourceRel: string, err: unknown): string {
  return (
    `${sourceRel} exists but could NOT be read (${err instanceof Error ? err.message : String(err)}), ` +
    `so nothing was seeded from it. This worktree may have no config to start from — and the usual ` +
    `workaround is to copy the repo-root .env in, which points it at LIVE databases. ` +
    `Remedy: fix the permissions on ${sourceRel} (or replace it with a readable ${SEED_FILENAME}) ` +
    `and re-run detection.`
  );
}

/**
 * Rule 3.
 *
 * **Phase 3 (R11):** `sharedResources` carries the resources a project has
 * explicitly declared `"shared"` in `.sentinal/runtime.json`, turning a blanket
 * "may not be isolated" into a named one. It arrives via
 * {@link SeedOptions.sharedResources} rather than by importing the runtime
 * loader — see that field's docblock for the module-cycle argument.
 *
 * ⛔ The default `[]` must keep producing Phase 2's **byte-identical** string.
 * A project with no runtime contract supplies nothing, and "no contract" has to
 * mean "nothing changed", not "the same warning with an empty list glued on".
 */
export function notIsolatedWarning(
  sourceRel: string,
  sharedResources: string[] = [],
): string {
  const named =
    sharedResources.length > 0
      ? ` Shared with the main checkout: ${sharedResources.join(", ")}.`
      : "";
  return (
    `Seeded from ${sourceRel}, but it contains no ${SLOT_PLACEHOLDER} placeholder — the result is ` +
    `NOT isolated.${named} Every worktree seeded from this file points at the SAME ports, ` +
    `databases and services as the main checkout, so concurrent work can corrupt shared state. ` +
    `This is a clean starting point, not a safety guarantee. ` +
    `Remedy: parameterise the shared values with ${SLOT_PLACEHOLDER}.`
  );
}

/**
 * Rule 2b — a seed source carrying a typo'd `${SENTINAL_*}` token.
 *
 * ⛔ **Skip-and-warn, not throw.** Exactly the reasoning already applied to an
 * unreadable source below: throwing runs `create()`'s rollback and destroys an
 * otherwise healthy worktree over a file Sentinal only ever wanted to COPY.
 * Not writing it is what satisfies the "no unsubstituted `${SENTINAL_*}` token"
 * guarantee — the bad file simply never reaches the worktree.
 *
 * ⛔ It also **replaces** rule 3's not-isolated warning for this file rather
 * than joining it. A typo'd token means there is no VALID placeholder either,
 * so rule 3 would fire and tell the reader to add a placeholder — sending them
 * to fix the wrong thing, when the placeholder is there and merely misspelt.
 */
function unknownTokenSeedWarning(
  sourceRel: string,
  targetRel: string,
  tokens: string[],
): string {
  return (
    `${sourceRel} contains unknown Sentinal token(s): ${tokens.join(", ")} — so ${targetRel} was ` +
    `NOT seeded. Sentinal substitutes exactly one token, ${SLOT_PLACEHOLDER}; anything else under ` +
    `the SENTINAL_ prefix is a typo, not a variable. Seeding it verbatim would leave the shell to ` +
    `expand it to the EMPTY STRING, silently pointing this worktree at slot-less — that is, the ` +
    `main checkout's — ports and databases, which is the exact failure per-slot seeding exists to ` +
    `prevent. Non-SENTINAL_ tokens (\${PORT:-3000}, \${DOCKER_HOST}) and bare $VAR are passed ` +
    `through verbatim and need no change. ` +
    `Remedy: fix the spelling in ${sourceRel}, then re-run detection.`
  );
}

/** Rule 0. */
function skipExistingWarning(targetRel: string): string {
  return (
    `${targetRel} already exists in this worktree and was left UNTOUCHED — Sentinal never ` +
    `overwrites a .env, because it is untracked and may be hand-edited, so an overwrite is ` +
    `unrecoverable. It was NOT re-seeded for this slot and may therefore point at the wrong ` +
    `resources. Delete it and re-run if you want it seeded.`
  );
}

/** No slot to substitute — leaving the placeholder beats inventing a value. */
function unsubstitutedPlaceholderWarning(targetRel: string): string {
  return (
    `${targetRel} still contains ${SLOT_PLACEHOLDER} because this worktree has no slot assigned. ` +
    `The placeholder was left in place deliberately — substituting an empty or invented value ` +
    `would silently point the worktree at a resource that is not its own. Assign a slot ` +
    `(free one with worktree_cleanup, then re-run detection) and re-seed.`
  );
}

/** Rule 4, unslotted case. */
function slotlessWarning(worktreePath: string): string {
  return (
    `${worktreePath} has no slot assigned (a pre-V12 record, or the slot pool was full), so ` +
    `${SLOT_ENV_RELATIVE_PATH} was NOT written — a literal null value there would be worse than ` +
    `its absence. Anything reading the slot falls back to defaults and may collide with the main ` +
    `checkout's ports and databases. Remedy: run worktree_cleanup to free a slot, then re-run ` +
    `detection to have one assigned.`
  );
}

// ─── Seeding ────────────────────────────────────────────────────────────────

function renderSlotEnvFile(slot: number): string {
  return (
    `# Written by Sentinal for this worktree. Sourceable: \`set -a; . ${SLOT_ENV_RELATIVE_PATH}; set +a\`\n` +
    `# Slot 0 is reserved for the main checkout and is never allocated.\n` +
    `${SLOT_ENV_VAR}=${slot}\n`
  );
}

/**
 * Seed per-slot config into `worktreePath` and hide it from git.
 *
 * @throws on I/O failure — the caller MUST run this inside its rollback
 *   envelope so a half-written worktree is torn down.
 */
export function seedWorktreeConfig(opts: SeedOptions): SeedResult {
  const { repoRoot, worktreePath, slot } = opts;
  const write =
    opts.writeFile ??
    ((abs: string, content: string) => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    });

  const seeded: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  // ── Rules 0-3: the .env files ────────────────────────────────────────────
  const sources = discoverSeedSources(repoRoot);
  if (sources.length === 0) warnings.push(noSeedSourceWarning(repoRoot));

  for (const dir of sources) {
    const sourceRel = dir === "." ? SEED_FILENAME : `${dir}/${SEED_FILENAME}`;
    const targetRel =
      dir === "." ? SEED_TARGET_FILENAME : `${dir}/${SEED_TARGET_FILENAME}`;

    // Rule 0 — never overwrite.
    if (existsSync(join(worktreePath, targetRel))) {
      skipped.push(targetRel);
      warnings.push(skipExistingWarning(targetRel));
      continue;
    }

    // ⛔ An unreadable source is functionally a MISSING one — warn and skip.
    // Throwing here runs the caller's rollback and destroys an otherwise
    // healthy worktree over a file Sentinal only ever wanted to COPY. The
    // `write` below stays unguarded: a genuine WRITE failure IS fatal.
    let text: string;
    try {
      text = readFileSync(join(repoRoot, sourceRel), "utf-8");
    } catch (err) {
      warnings.push(unreadableSeedWarning(sourceRel, err));
      continue;
    }

    // Rule 2b — BEFORE rule 3, because a typo'd token is also a file with no
    // valid placeholder, and rule 3's remedy ("add a placeholder") is the wrong
    // advice for a placeholder that is present but misspelt.
    const unknown = opts.unknownTokens?.(text) ?? [];
    if (unknown.length > 0) {
      warnings.push(unknownTokenSeedWarning(sourceRel, targetRel, unknown));
      continue;
    }

    let content: string;
    if (!hasSlotPlaceholder(text)) {
      content = text;
      // Rule 3. `sharedResources` is empty unless the caller loaded a runtime
      // contract, in which case the warning NAMES what is shared instead of
      // gesturing at "ports, databases and services" in general.
      warnings.push(notIsolatedWarning(sourceRel, opts.sharedResources ?? []));
    } else if (slot === null) {
      content = text;
      warnings.push(unsubstitutedPlaceholderWarning(targetRel));
    } else {
      content = interpolateSlot(text, slot);
    }

    write(join(worktreePath, targetRel), content);
    seeded.push(targetRel);
  }

  // ── Rule 4: the sourceable slot env file ─────────────────────────────────
  if (slot === null) {
    warnings.push(slotlessWarning(worktreePath));
  } else {
    // Sentinal-owned and derived from the DB, so overwriting is correct here —
    // unlike `.env`, a stale value would contradict the authoritative record.
    write(join(worktreePath, SLOT_ENV_RELATIVE_PATH), renderSlotEnvFile(slot));
    seeded.push(SLOT_ENV_RELATIVE_PATH);
  }

  // ── Rule 5: hide it all from git ─────────────────────────────────────────
  const exclusion = excludeFromGit(worktreePath, [...seeded, ...skipped]);
  warnings.push(...exclusion.warnings);

  return { seeded, skipped, unexcluded: exclusion.unexcluded, warnings };
}

/**
 * {@link seedWorktreeConfig} for **read-shaped** callers.
 *
 * `worktree_detect` → `resolveWithReconcile` must never hard-fail because
 * seeding hit an I/O error, so the failure is downgraded to a warning and
 * `null` is returned. `create()` uses the throwing form instead, because it has
 * a rollback envelope that can actually undo the half-made worktree.
 */
export function seedNonFatally(
  opts: SeedOptions,
  warnings?: string[],
): SeedResult | null {
  try {
    const seed = seedWorktreeConfig(opts);
    warnings?.push(...seed.warnings);
    return seed;
  } catch (err) {
    warnings?.push(
      `Could not seed config into ${opts.worktreePath}: ` +
        `${err instanceof Error ? err.message : String(err)}. The worktree is usable but has no ` +
        `per-slot config — do NOT copy the repo-root .env in, it points at live resources.`,
    );
    return null;
  }
}
