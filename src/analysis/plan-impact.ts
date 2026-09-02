/**
 * plan_impact MCP tool — prospective plan analysis.
 *
 * `impact_analysis` is driven by `git diff --name-only HEAD`. During planning
 * no edit exists yet, so it answers "0 files changed. Nothing to analyze." —
 * it is inherently post-hoc. This is the prospective counterpart: it reads the
 * plan and answers questions about the change *before* it happens.
 *
 * ## ⛔ D4 — the two halves have different epistemic standing
 *
 * **Wave-overlap detection** asks whether the plan is internally consistent
 * with its own stated rule (`spec-plan.md`: *tasks in the same wave MUST NOT
 * modify the same files*). That is a property of the **plan text**: true or
 * false regardless of what the implementation later touches. It needs no
 * injected source and no code-graph tool, and it is the highest-value output
 * because that rule is currently prose-only and nothing enforces it — while on
 * OpenCode a wave's tasks share one working directory, so a violation corrupts
 * work rather than merely racing.
 *
 * **Prospective reach** is bounded by how accurate the plan's `Files:` list
 * turns out to be. It is rendered as a hint, with that assumption named
 * **inline in the output** rather than only here.
 *
 * The output must not present them with equal confidence, and neither does
 * this file: overlap detection is a pure function over parsed tasks
 * ({@link detectWaveOverlaps}) with exact tests; reach is best-effort and
 * degrades to "unscored" rather than to a wrong number.
 *
 * ## Why `exists`, not the verb
 *
 * Reach is meaningful only for files already in the import graph:
 * `countTransitiveImporters` has no node for a file that does not exist, so it
 * returns 0, and a plan of mostly-new files would always score LOW. The gate is
 * therefore **on-disk existence**, never the verb — Task 4 found that the
 * inline `**Files:** \`a.ts\`, \`b.ts\`` form used throughout this repo's
 * bugfix plans carries no verb at all and defaults to `modify`.
 *
 * ## Layout
 *
 * This file holds the contract — {@link detectWaveOverlaps} and the tool
 * registration. All rendering lives in `./plan-impact-report.ts`, split off
 * purely for length exactly as `reach-sources.ts` was split off `reach.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { mcpText } from "../mcp/helpers.js";
import type { SpecStore } from "../spec/store.js";
import type { SidecarClient } from "../sidecar/client.js";
import { countImporters } from "./helpers.js";
import { buildImportGraph, moduleId } from "./imports.js";
import { parsePlanFiles, type PlanTaskFiles } from "./plan-files.js";
import {
  buildOverlapSection,
  buildReachSection,
  collectClaimed,
  planLabel,
  REACH_PREAMBLE,
  stripRejectionHeading,
  type ScoredFile,
} from "./plan-impact-report.js";
import {
  AgentReachSchema,
  isReachRelevantPath,
  resolveReach,
} from "./reach.js";

// --- Overlap detection ---

export interface OverlapTask {
  /** Heading label verbatim — `"1"`, `"1a"`, `"8.2"`. */
  id: string;
  title: string;
}

export interface WaveOverlap {
  wave: number;
  /** The contended path, repo-relative. */
  path: string;
  /** Every task in this wave claiming it, in document order. Always >= 2. */
  tasks: OverlapTask[];
}

/**
 * Every path claimed by two or more tasks **of the same wave**.
 *
 * Deterministic and total over the parsed plan: no filesystem access, no
 * injected source, no import graph. That is the whole point — this is the half
 * that works when the project has no code-graph tooling at all.
 *
 * Tasks with `wave: null` are **excluded**, never bucketed into wave 1. The
 * shipped template carries a literal `[1 | 2 | ...]` placeholder, so unfilled
 * waves are common; defaulting them would manufacture overlaps between tasks
 * whose ordering the plan never stated. The caller reports them as
 * unassessable instead — see {@link buildOverlapSection}.
 *
 * A path claimed twice by one task (`Create:` then `Modify:`) is not an
 * overlap; ownership is de-duplicated per task before counting.
 */
export function detectWaveOverlaps(tasks: PlanTaskFiles[]): WaveOverlap[] {
  // wave -> path -> owning tasks (insertion-ordered = document order)
  const byWave = new Map<number, Map<string, OverlapTask[]>>();

  for (const task of tasks) {
    if (task.wave === null) continue;
    let paths = byWave.get(task.wave);
    if (!paths) {
      paths = new Map();
      byWave.set(task.wave, paths);
    }
    for (const path of new Set(task.files.map((f) => f.path))) {
      const owners = paths.get(path) ?? [];
      owners.push({ id: task.id, title: task.title });
      paths.set(path, owners);
    }
  }

  const out: WaveOverlap[] = [];
  for (const [wave, paths] of [...byWave].sort((a, b) => a[0] - b[0])) {
    for (const path of [...paths.keys()].sort()) {
      const owners = paths.get(path)!;
      if (owners.length > 1) out.push({ wave, path, tasks: owners });
    }
  }
  return out;
}

// --- Tool ---

const DESCRIPTION =
  "Analyse a plan BEFORE implementation — the prospective counterpart to impact_analysis, which is diff-driven and therefore reports '0 files changed' while you are still planning. Two halves, of deliberately different confidence: (1) DETERMINISTIC same-wave file-overlap detection, which needs no code-graph tool and is the only enforcement of the plan rule that tasks in the same wave must not modify the same files — on OpenCode a wave shares one working directory, so an overlap corrupts work; (2) ADVISORY prospective reach over the plan's claimed files, bounded by how accurate the plan's `Files:` prediction turns out to be, and scored only for files that already exist on disk. Advisory throughout — it never blocks.";

type PlanResolution =
  | { ok: true; planPath: string; specTitle: string | null }
  | { ok: false; message: string };

/**
 * Resolve which plan to analyse.
 *
 * A down sidecar costs the default-to-active-spec convenience, never the tool:
 * an explicit `plan_path` never touches the store or the client at all.
 */
async function resolvePlan(
  project: string,
  planPath: string | undefined,
  specStore: SpecStore | null,
  client: SidecarClient | null,
): Promise<PlanResolution> {
  if (planPath) {
    return {
      ok: true,
      planPath: isAbsolute(planPath) ? planPath : join(project, planPath),
      specTitle: null,
    };
  }

  let spec: { title: string; planFile: string } | null = null;
  try {
    spec = specStore?.getCurrentSpec(project) ?? null;
    if (!spec && client) spec = (await client.getCurrentSpec(project)) ?? null;
  } catch {
    spec = null;
  }
  if (!spec) {
    return {
      ok: false,
      message:
        "## Plan Impact\n\nNo `plan_path` was given and there is **no active spec** for this project, so there is no plan to analyse. Pass `plan_path` explicitly (absolute, or relative to `project`).",
    };
  }
  return { ok: true, planPath: spec.planFile, specTitle: spec.title };
}

/**
 * @param specStore Direct SQLite access. `null` in production, where
 *   `src/mcp/server.ts` sets `store = client ? null : ...` and a client always
 *   exists — which is why `client` is the load-bearing parameter here, exactly
 *   as it is for `impact_analysis`.
 */
export function registerPlanImpactTool(
  server: McpServer,
  specStore: SpecStore | null,
  client: SidecarClient | null = null,
): void {
  // ⛔ M9a: `registerTool` + a full `.strict()` ZodObject — see the matching
  // comment in `impact.ts`. A raw shape is wrapped NON-strict by the SDK, so a
  // mis-nested top-level `moduleCount` was silently stripped; the deprecated
  // `tool()` overload would treat a full ZodObject as annotations (no
  // validation), so `registerTool` is the only correct registration.
  server.registerTool(
    "plan_impact",
    {
      description: DESCRIPTION,
      inputSchema: z
        .object({
          project: z.string().describe("Absolute path to the project root"),
          plan_path: z
            .string()
            .optional()
            .describe(
              "Path to the plan `.md`, absolute or relative to `project`. Defaults to the project's active spec.",
            ),
          reach: AgentReachSchema.describe(
            `Optional, and only ever used by the ADVISORY reach half. **Wave-overlap detection needs none of it** — that half is deterministic on the plan text and runs with zero sources, so call this tool even with no code-graph server installed. ${AgentReachSchema.description ?? ""}`,
          ).optional(),
        })
        .strict(),
    },
    async ({ project, plan_path, reach }) => {
      try {
        const found = await resolvePlan(project, plan_path, specStore, client);
        if (!found.ok) return mcpText(found.message);

        const tasks = parsePlanFiles(found.planPath, project);
        const label = planLabel(project, found.planPath);
        if (tasks.length === 0) {
          return mcpText(
            `## Plan Impact\n\n**No tasks found** in \`${label}\` — no \`### Task N:\` headings were parsed, so there is nothing to analyse. Check the path, and that the plan uses the standard task headings.`,
          );
        }

        const claimed = collectClaimed(tasks);
        // ⛔ Keyed on `exists`, NEVER on the verb — see the file docblock.
        const candidates = claimed.filter(
          (f) => f.exists && isReachRelevantPath(f.path),
        );
        const missing = claimed.filter((f) => !f.exists);
        const nonCode = claimed.filter(
          (f) => f.exists && !isReachRelevantPath(f.path),
        );

        const graph = buildImportGraph(project);
        const resolution = await resolveReach({
          project,
          changedRelPaths: candidates.map((f) => f.path),
          fallbackModuleCount: graph.modules.size,
          agentReach: reach ?? null,
        });

        const header = [
          `## Plan Impact — \`${label}\``,
          "",
          ...(found.specTitle ? [`_Active spec: ${found.specTitle}_`] : []),
          `**${tasks.length} task${tasks.length === 1 ? "" : "s"}** · ${claimed.length} distinct file${claimed.length === 1 ? "" : "s"} claimed`,
          "",
        ];
        const overlapSection = buildOverlapSection(
          tasks,
          detectWaveOverlaps(tasks),
        );

        // ⛔ D4 in the failure path: the overlap half never depended on an
        // injected source, so a rejected map must not be able to suppress it.
        if (!resolution.ok) {
          return mcpText(
            [
              ...header,
              ...overlapSection,
              "",
              ...REACH_PREAMBLE,
              "**Supplied `reach` was rejected — nothing was scored.** The overlap section above is unaffected.",
              "",
              stripRejectionHeading(resolution.error),
            ].join("\n"),
          );
        }

        const scored: ScoredFile[] = candidates.map((f) => ({
          ...f,
          inGraph: graph.modules.has(moduleId(resolve(project, f.path))),
          reach:
            resolution.overrides.get(f.path) ??
            countImporters(f.path, project, graph),
        }));

        return mcpText(
          [
            ...header,
            ...overlapSection,
            "",
            ...buildReachSection(
              scored,
              { missing, nonCode, total: claimed.length },
              resolution.moduleCount,
              resolution.attribution,
            ),
          ].join("\n"),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(
          `Error running plan_impact: ${msg}\n\nFallback: read the plan's per-task **Files:** and **Wave:** fields directly.`,
        );
      }
    },
  );
}
