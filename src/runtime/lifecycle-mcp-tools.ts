/**
 * `runtime_up` / `runtime_stop` — the MCP surface over `lifecycle.ts`.
 *
 * ## Why these exist
 *
 * D4 builds **no guard** against destructive shell commands: shell safety is
 * user configuration, shipped as opt-out permission defaults. This phase's
 * contribution to the `pkill -f` problem is different and, on the evidence,
 * stronger — it makes the *correct alternative* trivially available. An agent
 * that has `runtime_stop` has no reason to reach for `pkill`, and one that does
 * not will invent something.
 *
 * ## A sibling module on purpose
 *
 * `mcp-tools.ts` is 212 lines; both tools inline there would breach the 400-line
 * warn threshold. `registerRuntimeTools` calls
 * {@link registerRuntimeLifecycleTools}, so `src/mcp/server.ts` needs no change.
 *
 * ## Conventions this file follows
 *
 * - **`project` is REQUIRED, never `process.cwd()`** — the runtime domain's
 *   convention (`mcp-tools.ts:132`), not `src/worktree/mcp-tools.ts`'s
 *   `project ?? process.cwd()`. The cwd of an MCP server is not the caller's
 *   worktree, and defaulting to it would point `up` at the wrong directory.
 * - **`runtime_stop` is labelled DESTRUCTIVE**, following `worktree_cleanup`.
 * - Every failure carries the log tail. A blind agent improvises.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import { runtimeUp, runtimeStop, type RuntimeUpResult } from "./lifecycle.js";
import { RUNTIME_LOG_RELATIVE_PATH } from "./schema.js";
import type { StopResult } from "./teardown.js";

// ─── Formatting ─────────────────────────────────────────────────────────────

function bulleted(heading: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return ["", `### ${heading}`, "", ...items.map((i) => `- ${i}`)];
}

function formatUp(project: string, r: RuntimeUpResult): string {
  if (!r.ok) {
    const lines = [
      `## \`runtime_up\` FAILED — nothing is running for ${project}`,
      "",
      r.reason ?? "unknown failure",
      ...bulleted("What was attempted", r.actions),
      ...bulleted("Warnings", r.warnings),
    ];
    if (r.logTail) {
      lines.push(
        "",
        `### Last lines of ${RUNTIME_LOG_RELATIVE_PATH}`,
        "",
        "```",
        r.logTail,
        "```",
      );
    }
    return lines.join("\n");
  }

  if (!r.configured) {
    return [
      `## No runtime contract in ${project}`,
      "",
      ...r.actions,
      ...bulleted("Warnings", r.warnings),
    ].join("\n");
  }

  if (r.reused) {
    return [
      `## Reusing the stack already running for ${project}`,
      "",
      `- **pid:** ${r.pid}`,
      `- **process group:** ${r.pgid ?? "not recorded on this platform"}`,
      "",
      `⛔ This stack was **not** started by this call, so **do not stop it** when the run ` +
        `finishes. Killing something we did not start is the same class of error as ` +
        `\`pkill -f\`. Leave it exactly as you found it.`,
      ...bulleted("Detail", r.actions),
      ...bulleted("Warnings", r.warnings),
    ].join("\n");
  }

  if (!r.started) {
    return [
      `## Nothing to start for ${project}`,
      "",
      ...r.actions,
      ...bulleted("Warnings", r.warnings),
    ].join("\n");
  }

  return [
    `## Runtime up for ${project}`,
    "",
    `- **pid:** ${r.pid}`,
    `- **process group:** ${r.pgid ?? "not recorded on this platform (no group to signal)"}`,
    `- **log:** ${RUNTIME_LOG_RELATIVE_PATH}`,
    "",
    `Started by this call, so **this call owns it**: run \`runtime_stop\` on the same ` +
      `\`project\` when the run finishes — including when it fails.`,
    ...bulleted("Detail", r.actions),
    ...bulleted("Warnings", r.warnings),
  ].join("\n");
}

function formatStop(project: string, r: StopResult): string {
  if (!r.ok) {
    return [
      `## \`runtime_stop\` REFUSED — the runtime for ${project} may still be running`,
      "",
      r.reason ?? "unknown failure",
      ...bulleted("What was attempted", r.actions),
      ...bulleted("Warnings", r.warnings),
    ].join("\n");
  }

  return [
    r.stopped
      ? `## Stopped the runtime Sentinal started for ${project}`
      : `## Nothing to stop for ${project}`,
    "",
    ...(r.pid !== undefined
      ? [
          `- **pid:** ${r.pid}`,
          `- **process group:** ${r.pgid ?? "none recorded"}`,
          "",
        ]
      : []),
    ...r.actions,
    ...bulleted("Warnings", r.warnings),
  ].join("\n");
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerRuntimeLifecycleTools(server: McpServer): void {
  registerRuntimeUpTool(server);
  registerRuntimeStopTool(server);
}

function registerRuntimeUpTool(server: McpServer): void {
  server.tool(
    "runtime_up",
    "Start the project's declared `up` command in a process group Sentinal owns, recording it " +
      "in a worktree-local pidfile, and return only once the declared readiness probe passes. " +
      "Reuses an already-running stack it started earlier (and says so). " +
      "An occupied port is a HARD FAILURE: it will never start the project on a different " +
      "port, because a free port proves nothing about what is behind it. " +
      "Inert success when the project has no .sentinal/runtime.json.",
    {
      project: z
        .string()
        .describe(
          "Absolute path to the project root or worktree root to start. Required — never " +
            "assumed from the server's working directory.",
        ),
    },
    async ({ project }) => {
      try {
        return mcpText(formatUp(project, await runtimeUp(project)));
      } catch (err) {
        return mcpError("Error starting the runtime", err);
      }
    },
  );
}

function registerRuntimeStopTool(server: McpServer): void {
  server.tool(
    "runtime_stop",
    "Terminate the process group Sentinal started for this project and nothing else — " +
      "DESTRUCTIVE: it sends SIGTERM then SIGKILL to that group, after running the declared " +
      "`down`. It REFUSES to signal any process it cannot prove belongs to this worktree " +
      "(by command line or working directory), which is what makes it a safe replacement for " +
      "`pkill -f`. Idempotent and a fast no-op when nothing was started. " +
      "Never use it on a stack `runtime_up` reported as reused.",
    {
      project: z
        .string()
        .describe(
          "Absolute path to the project root or worktree root whose runtime should be stopped. " +
            "Required — never assumed from the server's working directory.",
        ),
    },
    async ({ project }) => {
      try {
        return mcpText(formatStop(project, await runtimeStop(project)));
      } catch (err) {
        return mcpError("Error stopping the runtime", err);
      }
    },
  );
}
