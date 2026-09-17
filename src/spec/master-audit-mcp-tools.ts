/**
 * `spec_master_audit` — reconcile a master plan against its child plans.
 *
 * Exists because `spec-master-execute` documents a check ("all child plans are
 * VERIFIED") that `spec-verify` never performed, and because the master↔child
 * relation — though parsed and persisted — was never queried. Prose in a skill
 * file cannot fail a test; this tool can.
 *
 * ⛔ DIRECT-FS ONLY, and deliberately so. The audit is a stateless read of plan
 * files derived from the tool's own `plan_path` argument, so there is nothing
 * warm for the sidecar to hold. More importantly, MCP tools receive
 * `store: null` in production whenever the sidecar is running — a tool built on
 * `store` would pass every test and silently do nothing in the field, which is
 * precisely the defect class this tool detects. Do not add a sidecar route and
 * do not reintroduce a `store` dependency here.
 *
 * Lives in its own module because `./mcp-tools.ts` is already at 332 lines and
 * the repo blocks edits at 600 / warns at 400 — the same reason
 * `./status-mcp-tools.ts` and `./events-mcp-tools.ts` exist.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import { auditMasterPlan, type MasterAuditResult } from "./master-audit.js";

// --- Rendering ---

function checkboxCell(r: MasterAuditResult, slug: string): string {
  const phase = [...r.children, ...r.excluded].find(
    (c) => c.slug === slug,
  )?.phase;
  if (phase === undefined) return "—";
  const box = r.checkboxes.find((c) => c.phase === phase);
  if (!box) return "— (no row)";
  return `${box.checked ? "[x]" : "[ ]"}${
    box.declaredStatus ? ` ${box.declaredStatus}` : ""
  }`;
}

function render(r: MasterAuditResult): string {
  const lines: string[] = [];
  const verdict = r.ok ? "PASS" : "FAIL";

  lines.push(`## Master Plan Audit: ${verdict}`);
  lines.push("");
  lines.push(`- **Master:** ${r.master.slug} (Status: ${r.master.status})`);
  lines.push(`- **Children VERIFIED:** ${r.verifiedCount}/${r.totalCount}`);
  if (r.excluded.length > 0) {
    lines.push(
      `- **Excluded (CANCELLED):** ${r.excluded.map((c) => c.slug).join(", ")}`,
    );
  }
  lines.push("");

  if (r.children.length > 0 || r.excluded.length > 0) {
    lines.push("| Child | Status | Master checkbox |");
    lines.push("|---|---|---|");
    for (const c of [...r.children, ...r.excluded]) {
      const box = checkboxCell(r, c.slug);
      const disagrees = r.findings.some(
        (f) => f.kind === "checkbox-disagrees" && f.slug === c.slug,
      );
      const status = c.status === "VERIFIED" ? "VERIFIED" : `⛔ ${c.status}`;
      lines.push(
        `| ${c.slug} | ${status} | ${box}${disagrees ? " — DISAGREES" : ""} |`,
      );
    }
    lines.push("");
  }

  if (r.findings.length === 0) {
    lines.push(
      "Every child plan is VERIFIED and every master checkbox agrees with its " +
        "child file. Master verification may proceed.",
    );
    return lines.join("\n");
  }

  lines.push(`### must_fix (${r.findings.length})`);
  lines.push("");
  for (const f of r.findings) {
    lines.push(`- **[${f.kind}] ${f.slug}** — ${f.message}`);
  }
  lines.push("");
  lines.push(
    "⛔ Do NOT set the master plan to VERIFIED while any finding above stands. " +
      "A disagreement is itself the finding: it means the master's checkbox was " +
      "written from a subagent report rather than from the child file.",
  );

  return lines.join("\n");
}

// --- Registration ---

export function registerSpecMasterAuditTool(server: McpServer): void {
  server.tool(
    "spec_master_audit",
    "Reconcile a master plan against its child plans. Resolves children via " +
      "their `Parent:` back-link (NOT by filename), fails on any child that is " +
      "not VERIFIED, and reports any disagreement between a child's Status and " +
      "the master's Progress Tracking checkbox in either direction. Read-only.",
    {
      plan_path: z
        .string()
        .describe("Absolute path to the master plan .md file (Type: Master)"),
    },
    async ({ plan_path }) => {
      try {
        return mcpText(render(auditMasterPlan(plan_path)));
      } catch (err) {
        return mcpError("Master plan audit failed", err);
      }
    },
  );
}
