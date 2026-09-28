/**
 * `worktree_ensure` — create-or-adopt as an MCP tool (orca Task 9, D4).
 *
 * A thin surface over {@link ensureWorktree}. Like `worktree_create` it runs
 * DIRECT (no sidecar route): it needs git in the caller's checkout, and the
 * `setup` runner arrives on the injected {@link WorktreeConfig}
 * (`config.runSetup`, filled by `runtimeWorktreeConfig()` and threaded down from
 * `src/mcp/server.ts`).
 *
 * The report helpers are exported for `sentinal worktree ensure`, so the CLI's
 * `--json` shape and the tool's Markdown are built from one object.
 *
 * ⛔ Must import NOTHING from `src/runtime/` (`no-module-cycle.test.ts`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpError, mcpText } from "../mcp/helpers.js";
import { ensureWorktree, type EnsuredWorktree } from "./adopt.js";
import type { WorktreeSetupOutcome } from "./create.js";
import { formatSlot } from "./slots.js";
import type { WorktreeStore } from "./store.js";
import type { WorktreeConfig, WorktreeOwner } from "./types.js";

export const ENSURE_TOOL_DESCRIPTION =
  "Create or ADOPT the worktree for a plan slug, and give it the full Sentinal treatment " +
  "(slot, per-slot config seeding, the runtime contract's once-per-worktree `setup`). Idempotent: " +
  "a live worktree already recorded for the slug is returned as-is. Without `path` it creates a " +
  "Sentinal-owned worktree (like worktree_create). With `path` it adopts an EXISTING linked worktree " +
  "of the repo that Sentinal did not create — e.g. one made by Orca — recording its branch, `base` " +
  "and `owner`. owner=external (requires path AND base) means Sentinal only borrows it: abandon " +
  "RELEASES it (frees the slot, strips only the files Sentinal seeded), cleanup and merge never " +
  "remove it — an external worktree and its branch are never deleted by Sentinal. " +
  "owner=sentinal with a path is an explicit takeover: Sentinal may then remove it like its own.";

export interface EnsureInput {
  owner?: WorktreeOwner;
  path?: string;
  base?: string;
}

/** A clear refusal for invalid input, or `null`. Runs before any git work. */
export function ensureInputError(input: EnsureInput): string | null {
  if ((input.owner ?? "sentinal") !== "external") return null;
  const missing = [
    input.path ? null : "path",
    input.base ? null : "base",
  ].filter(Boolean);
  if (missing.length === 0) return null;
  return (
    `owner "external" requires both a path and a base branch; missing ${missing.join(" and ")}. ` +
    `Pass the worktree directory as \`path\` and the branch it was created from as \`base\`. ` +
    `Nothing was recorded.`
  );
}

export interface EnsureReport {
  action: "created" | "adopted" | "existing";
  id: string;
  path: string;
  branch: string;
  base: string;
  slot: number | null;
  slotNote: string;
  owner: WorktreeOwner;
  slug: string | null;
  /** `null` when setup was not attempted (existing worktree, or no runner). */
  setup: WorktreeSetupOutcome | null;
  warnings: string[];
}

/** The machine-readable result — the CLI's `--json` output verbatim. */
export function ensureReport(
  wt: EnsuredWorktree,
  warnings: string[],
): EnsureReport {
  return {
    action: wt.created ? "created" : wt.adopted ? "adopted" : "existing",
    id: wt.id,
    path: wt.worktreePath,
    branch: wt.branchName,
    base: wt.baseBranch,
    slot: wt.slot ?? null,
    slotNote: formatSlot(wt.slot),
    owner: wt.owner ?? "sentinal",
    slug: wt.slug ?? null,
    setup: wt.setup ?? null,
    warnings,
  };
}

/** One line describing a setup outcome; `undefined`/`null` = not attempted. */
export function formatSetupLine(
  setup: WorktreeSetupOutcome | null | undefined,
): string {
  if (!setup) return "**Setup:** not run";
  if (!setup.ran && setup.ok) return "**Setup:** none declared";
  if (setup.ok) return "**Setup:** ran, ok";
  const why = setup.timedOut
    ? "timed out"
    : setup.exitCode !== null
      ? `exit ${setup.exitCode}`
      : "did not complete";
  return `**Setup:** ${setup.ran ? "ran, " : ""}FAILED (${why}) — see warnings`;
}

const HEADINGS = {
  created: "## Created Worktree",
  adopted: "## Adopted Worktree",
  existing: "## Existing Worktree",
} as const;

/** Markdown for the tool; warnings (which carry any setup tail) come last. */
export function formatEnsureMarkdown(r: EnsureReport): string {
  const lines = [
    HEADINGS[r.action],
    "",
    `- **ID:** ${r.id}`,
    `- **Path:** ${r.path}`,
    `- **Branch:** ${r.branch}`,
    `- **Base Branch:** ${r.base}`,
    `- **Slot:** ${r.slotNote}`,
    `- **Owner:** ${r.owner}` +
      (r.owner === "external"
        ? " (never deleted by Sentinal; abandon releases it)"
        : ""),
    `- ${formatSetupLine(r.setup)}`,
  ];
  if (r.warnings.length > 0) {
    lines.push("", "### Warnings", "", ...r.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}

export function registerWorktreeEnsureTool(
  server: McpServer,
  store: WorktreeStore,
  config: WorktreeConfig,
): void {
  server.tool(
    "worktree_ensure",
    ENSURE_TOOL_DESCRIPTION,
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z
        .string()
        .optional()
        .describe("Any checkout of the repo (defaults to CWD)"),
      path: z
        .string()
        .optional()
        .describe(
          "An existing linked worktree of the repo to ADOPT. Omit to create a new one.",
        ),
      base: z
        .string()
        .optional()
        .describe(
          "Base branch the worktree merges back into. Required for owner=external.",
        ),
      owner: z
        .enum(["sentinal", "external"])
        .optional()
        .describe(
          "Who owns the directory (default sentinal). external = never deleted by Sentinal; " +
            "requires path and base.",
        ),
      seed: z
        .boolean()
        .optional()
        .describe(
          "Seed per-slot config into an ADOPTED worktree (default true). A created worktree is always seeded.",
        ),
      takeover: z
        .boolean()
        .optional()
        .describe(
          "Required to adopt an existing path as owner=sentinal: Sentinal may then DELETE it like its own. Never needed for owner=external.",
        ),
    },
    async ({ plan_slug, project, path, base, owner, seed, takeover }) => {
      const refusal = ensureInputError({ owner, path, base });
      if (refusal) return mcpText(`Error ensuring worktree: ${refusal}`);
      try {
        const warnings: string[] = [];
        const wt = await ensureWorktree(
          store,
          config,
          {
            slug: plan_slug,
            project: project ?? process.cwd(),
            path,
            base,
            owner,
            seed,
            takeover,
          },
          warnings,
        );
        return mcpText(formatEnsureMarkdown(ensureReport(wt, warnings)));
      } catch (err) {
        return mcpError("Error ensuring worktree", err);
      }
    },
  );
}
