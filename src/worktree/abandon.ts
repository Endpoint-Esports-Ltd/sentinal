/**
 * Abandon a worktree — ownership-aware (D2 of
 * `docs/plans/2026-09-28-orca-orchestration.md`).
 *
 * - **Sentinal-owned** (`owner` absent or `"sentinal"`): stop the owned runtime,
 *   `git worktree remove --force` (with an `rmSync` + prune fallback), verify the
 *   directory is gone, `git branch -D`, mark `abandoned`. Moved verbatim from
 *   `manager.ts`.
 * - **External** (`owner === "external"`, e.g. an Orca worktree Sentinal adopted):
 *   RELEASE. Stop only Sentinal's own runtime, strip only the files Sentinal
 *   seeded and can prove are unchanged, mark `abandoned` (frees the slot).
 *
 * ⛔ The external path must NEVER run `git worktree remove`, `rmSync` on the
 * worktree, `git branch -D` or `git worktree prune`. Another tool owns that
 * directory and branch; deleting them is the incident this module prevents.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { WorktreeStore } from "./store.js";
import { gitExec } from "../git/utils.js";
import { inMainCheckout } from "./merge-guards.js";
import { isTracked } from "./git-exclude.js";
import { SLOT_ENV_RELATIVE_PATH } from "./slot-env.js";
import {
  discoverSeedSources,
  hasSlotPlaceholder,
  interpolateSlot,
  SEED_FILENAME,
  SEED_TARGET_FILENAME,
} from "./worktree-config.js";
import { WorktreeError, type Worktree, type WorktreeConfig } from "./types.js";

/** What `abandon` did. */
export interface AbandonResult {
  /** `removed`: directory + branch deleted. `released`: external, left in place. */
  outcome: "removed" | "released";
  message: string;
  /** Files deliberately left behind, and why. */
  warnings: string[];
}

/**
 * First line of every ignore file `excludeFromGit` CREATES (`git-exclude.ts`
 * `HEADER`). A file starting with it was made by Sentinal; any other file is
 * someone else's and is never rewritten. Tied to the real writer by
 * `abandon.test.ts`, which seeds through `seedWorktreeConfig`.
 */
const SENTINAL_IGNORE_HEADER = "# Written by Sentinal for this worktree only.";

/**
 * Stop the process group this worktree owns, before anything touches its
 * directory. Throws `RUNTIME_STOP_FAILED` if the stop refused or failed.
 *
 * ⛔ **Fast no-op** in the case that matters: `stopOwnedGroup` short-circuits
 * on an absent pidfile *before* it loads the runtime contract, so a worktree
 * that never started a runtime never runs `down` and never pays `graceMs`
 * (Pre-Mortem #2 — `abandon` is called on every worktree, not just the ones
 * that ran something).
 *
 * ⛔ A failed stop **aborts the exit path**. `stopOwnedGroup` reports
 * `ok: false` exactly when it could not prove ownership or could not signal;
 * removing the directory anyway would orphan a live process with its cwd
 * deleted, which is precisely the failure this phase exists to prevent. The
 * caller gets an actionable message naming what to do by hand. (A release
 * aborts too: it frees the slot, which a live process is still using.)
 *
 * ⛔ An **absent** resolver aborts it too. `stopOwnedRuntime` is required on
 * `WorktreeConfig`, so omission is a compile error; this branch catches the
 * JS caller and the `as any` that tsc never sees. A deliberate opt-out is
 * spelled `NO_RUNTIME_STOP`, which is a real function and never lands here.
 */
export async function stopOwnedRuntime(
  config: WorktreeConfig,
  wt: Worktree,
  verb: "remove" | "release" = "remove",
): Promise<void> {
  const stop = config.stopOwnedRuntime;
  if (!stop) {
    throw new WorktreeError(
      `Refusing to ${verb} ${wt.worktreePath}: this WorktreeManager was built with no ` +
        `\`stopOwnedRuntime\` resolver, so Sentinal cannot tell whether the worktree owns ` +
        `running processes. Removing the directory now could orphan a live process with a ` +
        `deleted working directory. ` +
        `Remedy: construct the manager via runtimeWorktreeConfig() (src/runtime/worktree-deps.ts), ` +
        `or — if this manager genuinely owns no runtime — declare that by setting ` +
        `stopOwnedRuntime: NO_RUNTIME_STOP.`,
      "RUNTIME_STOP_FAILED",
    );
  }

  const outcome = await stop(wt.worktreePath);
  if (outcome.ok) return;

  throw new WorktreeError(
    `Refusing to ${verb} ${wt.worktreePath}: the runtime it owns could not be stopped. ` +
      `${outcome.reason ?? "No reason was given."} ` +
      `Removing the directory now would leave a live process with a deleted working ` +
      `directory — resolve this first, then retry.`,
    "RUNTIME_STOP_FAILED",
  );
}

/** Abandon a worktree: remove it if Sentinal owns it, release it otherwise. */
export async function abandonWorktree(
  store: WorktreeStore,
  config: WorktreeConfig,
  worktreeId: string,
): Promise<AbandonResult> {
  const row = store.get(worktreeId);
  if (!row)
    throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");
  const wt = inMainCheckout(row); // D5: git runs in the main checkout

  if (wt.owner === "external") return releaseExternal(store, config, wt);

  // ⛔ Before the directory is touched at all — including the `rmSync`
  // fallback below, which git cannot veto.
  await stopOwnedRuntime(config, wt);

  // Remove worktree from disk (force in case of uncommitted changes)
  if (existsSync(wt.worktreePath)) {
    const result = gitExec(
      ["worktree", "remove", "--force", wt.worktreePath],
      wt.projectPath,
    );
    if (result.exitCode !== 0) {
      // Fallback: remove directory manually and prune
      try {
        rmSync(wt.worktreePath, { recursive: true, force: true });
        gitExec(["worktree", "prune"], wt.projectPath);
      } catch {
        // Swallowed deliberately — the existsSync verification below is
        // what the invariant is actually about (M3c).
      }
    }
    // ⛔ M3c: `abandoned` is terminal, so it frees the row's slot. Writing it
    // over a SURVIVING directory hands the next worktree this one's ports and
    // seeded `.env` — mirror `removeMergedWorktree`'s discipline.
    if (existsSync(wt.worktreePath)) {
      throw new WorktreeError(
        `Could not remove ${wt.worktreePath} — both \`git worktree remove --force\` and ` +
          `the manual fallback failed, and the directory is still on disk. Deliberately ` +
          `left active rather than marked abandoned: abandoning would release its slot ` +
          `while the directory survives. Remedy: resolve whatever blocks removal ` +
          `(permissions, a process holding the directory), then re-run worktree_abandon.`,
        "REMOVE_FAILED",
      );
    }
  }

  // Delete the branch — only after the directory is confirmed gone.
  gitExec(["branch", "-D", wt.branchName], wt.projectPath);

  // Update store
  store.updateStatus(worktreeId, "abandoned");
  return {
    outcome: "removed",
    message: `Worktree abandoned: ${wt.branchName} (was at ${wt.worktreePath})`,
    warnings: [],
  };
}

/**
 * D2 release of an external worktree. ⛔ No git command that mutates the
 * worktree list or refs, and no recursive delete — see the module docblock.
 */
async function releaseExternal(
  store: WorktreeStore,
  config: WorktreeConfig,
  wt: Worktree,
): Promise<AbandonResult> {
  await stopOwnedRuntime(config, wt, "release");

  const warnings = existsSync(wt.worktreePath)
    ? stripSeededFiles(config, wt)
    : [];

  store.updateStatus(wt.id, "abandoned");
  return {
    outcome: "released",
    message:
      `Worktree released (external worktree left in place): ${wt.branchName} at ` +
      `${wt.worktreePath}. Its directory and branch belong to another tool and were not ` +
      `touched; only Sentinal's seeded files were removed and its slot freed.`,
    warnings,
  };
}

/** What seeding would have written for the seed source in `dir`, or null. */
function renderedSeed(
  config: WorktreeConfig,
  repoRoot: string,
  dir: string,
  slot: number | null,
): string | null {
  const sourceRel = dir === "." ? SEED_FILENAME : `${dir}/${SEED_FILENAME}`;
  let text: string;
  try {
    text = readFileSync(join(repoRoot, sourceRel), "utf-8");
  } catch {
    return null;
  }
  // Seeding skips a source with unknown tokens — so Sentinal wrote nothing.
  if ((config.unknownSentinalTokens?.(text) ?? []).length > 0) return null;
  return hasSlotPlaceholder(text) && slot !== null
    ? interpolateSlot(text, slot)
    : text;
}

/** Delete `rel` if it is an untracked file. Returns whether it was deleted. */
function removeUntrackedFile(worktreePath: string, rel: string): boolean {
  const abs = join(worktreePath, rel);
  if (!existsSync(abs) || isTracked(worktreePath, rel)) return false;
  rmSync(abs, { force: true });
  return !existsSync(abs);
}

/**
 * Remove only what Sentinal seeded. Returns warnings for anything left behind.
 *
 * Nothing records what seeding wrote, so a `.env` is Sentinal's only if it is
 * untracked and byte-identical to the template rendered for the row's slot.
 * Anything else (edited, pre-existing, re-slotted since) is LEFT with a warning:
 * deleting another tool's credentials file is the worse error.
 *
 * Also used by the external squash merge (`merge.ts`, D2). ⛔ Never deletes
 * anything but these files and an emptied `.sentinal/` (non-recursive).
 */
export function stripSeededFiles(
  config: WorktreeConfig,
  wt: Worktree,
): string[] {
  const warnings: string[] = [];
  const removed: string[] = [];
  const root = wt.worktreePath;

  if (removeUntrackedFile(root, SLOT_ENV_RELATIVE_PATH)) {
    removed.push(SLOT_ENV_RELATIVE_PATH);
  }

  for (const dir of discoverSeedSources(wt.projectPath)) {
    const rel =
      dir === "." ? SEED_TARGET_FILENAME : `${dir}/${SEED_TARGET_FILENAME}`;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const expected = renderedSeed(config, wt.projectPath, dir, wt.slot ?? null);
    let actual: string | null = null;
    try {
      actual = readFileSync(abs, "utf-8");
    } catch {
      // unreadable — treated as not provably Sentinal's
    }
    if (
      expected !== null &&
      actual === expected &&
      removeUntrackedFile(root, rel)
    ) {
      removed.push(rel);
    } else {
      warnings.push(
        `${rel} left in place in ${root}: it is not byte-identical to what Sentinal would ` +
          `have seeded for slot ${wt.slot ?? "none"} (edited, pre-existing, or tracked), so it ` +
          `may belong to the worktree's owner. Remove it by hand if it is Sentinal's.`,
      );
    }
  }

  pruneSentinalIgnoreEntries(root, removed);
  removeDirIfEmpty(join(root, ".sentinal"));
  return warnings;
}

/**
 * Drop the ignore lines for `removedRels` from ignore files SENTINAL CREATED
 * (header check), deleting the file once only its self-entry remains. An ignore
 * file without the header, or a tracked one, is never touched.
 */
function pruneSentinalIgnoreEntries(
  worktreePath: string,
  removedRels: string[],
): void {
  const byIgnoreFile = new Map<string, Set<string>>();
  for (const rel of removedRels) {
    const d = dirname(rel);
    const ignoreRel = d === "." || d === "" ? ".gitignore" : `${d}/.gitignore`;
    const set = byIgnoreFile.get(ignoreRel) ?? new Set<string>();
    set.add(`/${basename(rel)}`);
    byIgnoreFile.set(ignoreRel, set);
  }

  for (const [ignoreRel, entries] of byIgnoreFile) {
    const abs = join(worktreePath, ignoreRel);
    if (!existsSync(abs) || isTracked(worktreePath, ignoreRel)) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (!text.startsWith(SENTINAL_IGNORE_HEADER)) continue;

    const kept = text.split("\n").filter((l) => !entries.has(l.trim()));
    const meaningful = kept.filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("#") && t !== "/.gitignore";
    });
    if (meaningful.length === 0) rmSync(abs, { force: true });
    else writeFileSync(abs, kept.join("\n"));
  }
}

/** `rmdir` (never recursive) — only an EMPTY directory can go. */
function removeDirIfEmpty(abs: string): void {
  try {
    if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs);
  } catch {
    // best-effort
  }
}
