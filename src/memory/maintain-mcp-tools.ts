/**
 * Memory MCP Tools — maintenance
 *
 * `memory_maintain`, split out of `./mcp-tools.ts` purely for file length
 * (Task 9 of docs/plans/2026-09-02-audit-medium-remediation.md), following
 * the `src/spec/mcp-tools.ts` precedent: the parent keeps the single
 * `registerMemoryTools` entry point, so no import path changes anywhere.
 *
 * Registered UNCONDITIONALLY (M6b): in sidecar/client mode (`store: null`)
 * the handler opens a scoped direct `MemoryStore` per call and closes it in
 * a `finally`.
 *
 * WHY no sidecar route instead: maintenance is a destructive, rare, explicit
 * operation — the sidecar's warm-state benefit (~100ms cold-open saved) is
 * irrelevant here, and the direct open is CORRECT because `new MemoryStore()`
 * resolves the same `getDbPath()` database the sidecar serves. SQLite runs
 * in WAL mode (set in the MemoryStore constructor), which explicitly allows
 * this second connection to open and write while the sidecar holds the DB
 * open — verified by maintain-mcp-tools.test.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryStore } from "./store.js";
import { VectorStore, loadCustomSqlite } from "./vector-store.js";
import { EmbeddingService } from "./embeddings.js";
import { mcpText } from "../mcp/helpers.js";
import { requiredEnum } from "../utils/schema.js";
import { decayQualityScores } from "./maintenance.js";

// --- Maintain ---

const MAINTAIN_ACTIONS = ["decay", "prune", "stats"] as const;

interface MaintainArgs {
  action: (typeof MAINTAIN_ACTIONS)[number];
  prune_threshold?: number;
  dry_run?: boolean;
}

export function registerMaintainTool(
  server: McpServer,
  store: MemoryStore | null,
): void {
  server.tool(
    "memory_maintain",
    "Maintain memory quality: decay scores, prune low-quality observations, or view quality distribution. DESTRUCTIVE: prune permanently deletes observations below the quality threshold — irrecoverable. Use dry_run to preview first.",
    {
      action: requiredEnum(
        MAINTAIN_ACTIONS,
        "Action: decay (reduce scores by age), prune (delete low-quality), stats (quality distribution)",
      ),
      prune_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Prune observations below this quality score (default 0.15)"),
      dry_run: z
        .boolean()
        .optional()
        .describe("Preview without changes (default false)"),
    },
    async (args: MaintainArgs) => {
      // Client mode: open a scoped store on the shared DB for this one call.
      const owned = store ? null : await openScopedStore();
      const activeStore = store ?? owned!;
      try {
        return runMaintainAction(activeStore, args);
      } finally {
        owned?.close();
      }
    },
  );
}

/**
 * Open a per-call direct store on the sidecar's DB (same `getDbPath()`), and
 * best-effort load the vec0 extension on that connection so a prune can also
 * delete the pruned observations' vector rows (M6a). If sqlite-vec is
 * unavailable, vector cleanup degrades gracefully (see ./vector-cleanup.ts).
 */
async function openScopedStore(): Promise<MemoryStore> {
  loadCustomSqlite();
  const scoped = new MemoryStore();
  const vec = new VectorStore(scoped.getRawDb(), new EmbeddingService());
  await vec.initialize();
  return scoped;
}

function runMaintainAction(
  store: MemoryStore,
  { action, prune_threshold, dry_run }: MaintainArgs,
): ReturnType<typeof mcpText> {
  const dryRun = dry_run ?? false;
  const db = store.getRawDb();

  if (action === "decay") {
    const result = decayQualityScores(store, { dryRun });
    const prefix = dryRun ? "[DRY RUN] " : "";
    return mcpText(
      `${prefix}Quality decay complete: ${result.decayed} observations would decay, ${result.updated} updated.`,
    );
  }

  if (action === "prune") {
    const threshold = prune_threshold ?? 0.15;

    if (dryRun) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM observations WHERE quality_score < ?",
        )
        .get(threshold) as { count: number };
      return mcpText(
        `[DRY RUN] Would prune ${row.count} observations with quality_score < ${threshold}.`,
      );
    }

    // Collect the doomed IDs first, then delete through the store so each
    // observation's vector rows are removed with it (M6a) — a raw DELETE
    // here would orphan rows in `observation_vectors`.
    const doomed = db
      .prepare("SELECT id FROM observations WHERE quality_score < ?")
      .all(threshold) as { id: number }[];
    const pruned = store.deleteObservationsByIds(doomed.map((r) => r.id));
    const countAfter = (
      db.prepare("SELECT COUNT(*) as count FROM observations").get() as {
        count: number;
      }
    ).count;

    return mcpText(
      `Pruned ${pruned} observations with quality_score < ${threshold}. ${countAfter} remaining.`,
    );
  }

  // stats action
  const buckets = [
    { label: "0.0–0.2", min: 0, max: 0.2 },
    { label: "0.2–0.4", min: 0.2, max: 0.4 },
    { label: "0.4–0.6", min: 0.4, max: 0.6 },
    { label: "0.6–0.8", min: 0.6, max: 0.8 },
    { label: "0.8–1.0", min: 0.8, max: 1.01 },
  ];

  const lines = ["## Quality Score Distribution", ""];
  let total = 0;
  for (const bucket of buckets) {
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM observations WHERE quality_score >= ? AND quality_score < ?",
      )
      .get(bucket.min, bucket.max) as { count: number };
    lines.push(`- **${bucket.label}:** ${row.count}`);
    total += row.count;
  }
  lines.push("", `**Total:** ${total} observations`);

  return mcpText(lines.join("\n"));
}
