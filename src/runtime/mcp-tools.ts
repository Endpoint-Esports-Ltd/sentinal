/**
 * Runtime MCP Tools
 *
 * Registers the `.sentinal/runtime.json` contract tools on an MCP server.
 * Provides:
 *   - runtime_config: resolve, validate and interpolate the contract
 *   - runtime_init:   DRAFT a contract from what the project already declares
 *
 * ## ⛔ Direct-only, on purpose — not for want of a sidecar route
 *
 * Every other domain here delegates to the sidecar to reuse a warm SQLite
 * handle, embedding model or LSP client. **None of that applies.** This is a
 * stateless filesystem read of a path derived from the tool's own `project`
 * argument; a round trip to the sidecar would add a hop and buy nothing.
 *
 * `RuntimeToolsDeps` therefore exists to keep `createSentinalServer`'s
 * registration chain uniform, and its `client` is **deliberately unused**.
 * That is a design decision, not an oversight — do not "fix" it by adding a
 * sidecar route. (`src/sidecar/client.ts` also sits at 582/600 lines, which is
 * a second, independent reason, but the first one is the real one.)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mcpText, mcpError } from "../mcp/helpers.js";
import type { MemoryStore } from "../memory/store.js";
import type { SidecarClient } from "../sidecar/client.js";
import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./loader.js";
import { scaffoldRuntimeConfig } from "./scaffold.js";
import { registerRuntimeLifecycleTools } from "./lifecycle-mcp-tools.js";
import { RESOURCE_CLASSES, RUNTIME_CONFIG_RELATIVE_PATH } from "./schema.js";

// --- Public API ---

export interface RuntimeToolsDeps {
  /** ⛔ Deliberately unused — see the module docblock. */
  client?: SidecarClient | null;
  /** ⛔ Deliberately unused — see the module docblock. */
  store?: MemoryStore | null;
}

export function registerRuntimeTools(
  server: McpServer,
  _deps: RuntimeToolsDeps = {},
): void {
  registerRuntimeConfigTool(server);
  registerRuntimeInitTool(server);
  // Sibling module: both lifecycle tools inline here would breach the 400-line
  // warn threshold. Delegating keeps `src/mcp/server.ts` unchanged.
  registerRuntimeLifecycleTools(server);
}

// --- runtime_config ---

function formatLoaded(r: LoadedRuntimeConfig): string {
  if (!r.configured) {
    return (
      `No ${r.relPath} in this project. Runtime behaviour is unchanged: start and stop ` +
      `the project however you normally would. Run \`runtime_init\` (or \`/sync\`) to draft one.`
    );
  }

  if (r.error) {
    const lines = [`## ${r.relPath} could NOT be used`, "", r.error];
    if (r.warnings.length) lines.push("", ...r.warnings.map((w) => `- ${w}`));
    return lines.join("\n");
  }

  const c = r.config!;
  const lines = [`## ${r.relPath}`, ""];

  lines.push(`- **Slot:** ${r.slot === null ? "not assigned" : r.slot}`);
  lines.push(`- **up:** ${c.up ?? "(none — nothing to start)"}`);
  lines.push(`- **down:** ${c.down ?? "(none — signal escalation on teardown)"}`);
  if (c.up) lines.push(`- **detached:** ${c.detached}`);
  if (c.readiness) {
    lines.push(
      `- **readiness:** ${c.readiness.type} \`${c.readiness.target}\` ` +
        `(timeout ${c.readiness.startupTimeoutMs}ms, poll ${c.readiness.pollIntervalMs}ms)`,
    );
  }
  lines.push(
    `- **shutdown:** ${c.shutdown.signal}, then SIGKILL after ${c.shutdown.graceMs}ms`,
  );

  // ⛔ The ONLY blocking signal: an explicit, human-written "shared".
  if (r.sharedResources.length > 0) {
    lines.push(
      "",
      `### ⛔ Declared SHARED — confirm with the user before starting anything`,
      "",
      `This project declares these resources shared with the main checkout: ` +
        `**${r.sharedResources.join(", ")}**. Ask before running \`up\` — or before ` +
        `starting the program by hand — because a verification run can write to them. ` +
        `Do not try to decide first whether your change is "stateful": a run writes ` +
        `session rows, migrations and audit logs whether or not you meant it to.`,
    );
  }

  // Context only. ⛔ NEVER a prompt — a prompt that always fires carries no
  // information, and a reflexively-accepted one teaches the user to wave
  // through "not isolated".
  //
  // The same argument applies to the *list*. Every scaffolded file omits
  // `isolation` entirely (R13), so the naive rendering enumerates all nine
  // classes on every single call — noise that buries the one version of this
  // line that carries information, the partially-filled map. So: condense when
  // the author said nothing at all, enumerate when they said something.
  // ⛔ Presentation only — the blocking branch above is untouched, and
  // `unknown` still never prompts either way (D10 rule 1).
  if (r.unknownResources.length > 0) {
    const allUnknown = r.unknownResources.length === RESOURCE_CLASSES.length;
    lines.push(
      "",
      (allUnknown
        ? `_No isolation declared (all classes unknown, non-blocking)._ `
        : `_Undeclared (treated as unknown, non-blocking): ${r.unknownResources.join(", ")}._ `) +
        `Silence is not an all-clear — Sentinal simply has nothing to go on, and will not ` +
        `spend the user's attention guessing.`,
    );
  }

  if (r.warnings.length) {
    lines.push("", "### Warnings", "", ...r.warnings.map((w) => `- ${w}`));
  }

  return lines.join("\n");
}

function registerRuntimeConfigTool(server: McpServer): void {
  server.tool(
    "runtime_config",
    "Resolve, validate and interpolate a project's .sentinal/runtime.json runtime contract (up/readiness/down + the isolation map). Returns an inert not-configured result when the file is absent — that is not an error.",
    {
      project: z
        .string()
        .describe(
          "Absolute path to the project root or worktree root to inspect",
        ),
    },
    async ({ project }) => {
      try {
        return mcpText(formatLoaded(loadRuntimeConfig(project)));
      } catch (err) {
        return mcpError("Error reading runtime contract", err);
      }
    },
  );
}

// --- runtime_init ---

function registerRuntimeInitTool(server: McpServer): void {
  server.tool(
    "runtime_init",
    "Draft a .sentinal/runtime.json from docker-compose.yml, package.json scripts and Procfile, for human review. Returns the draft as text and NEVER writes it. Offered by /sync.",
    {
      project: z.string().describe("Absolute path to the project root"),
    },
    async ({ project }) => {
      try {
        if (existsSync(join(project, RUNTIME_CONFIG_RELATIVE_PATH))) {
          return mcpText(
            `${RUNTIME_CONFIG_RELATIVE_PATH} already exists — nothing drafted. It is ` +
              `project-authored, so Sentinal will not regenerate over it. Read it with ` +
              `\`runtime_config\`, or delete it first if you want a fresh draft.`,
          );
        }

        const r = scaffoldRuntimeConfig(project);
        const lines = [
          `## Draft ${r.targetRel}`,
          "",
          `⛔ NOT written. Review it, edit it, then save it yourself — this file is ` +
            `project-authored and committed by the project.`,
          "",
          r.sources.length
            ? `Inferred from: ${r.sources.join(", ")}`
            : `Nothing to infer from (no docker-compose.yml, package.json scripts or Procfile).`,
          "",
          "```jsonc",
          r.content.trimEnd(),
          "```",
        ];

        if (r.notes.length) lines.push("", ...r.notes.map((n) => `- ${n}`));

        // ⛔ Say the detected resources OUT LOUD here, in the conversation —
        // never in the file. A human reading /sync output is paying attention;
        // a human reading a generated file tends to accept it.
        if (r.detectedResources.length) {
          lines.push(
            "",
            `**Detected:** ${r.detectedResources.join(", ")}. \`isolation\` is left unset, ` +
              `so Sentinal treats these as **unknown** and will note them without ever ` +
              `interrupting a run. If your \`up\` command namespaces them per-slot, set them ` +
              `to \`"isolated"\`; if they are genuinely shared with the main checkout, set ` +
              `\`"shared"\` and Sentinal will ask before any run that could touch them.`,
          );
        } else {
          lines.push(
            "",
            `No shared-resource classes detected. \`isolation\` is left unset (**unknown**), ` +
              `which never interrupts a run.`,
          );
        }

        return mcpText(lines.join("\n"));
      } catch (err) {
        return mcpError("Error drafting runtime contract", err);
      }
    },
  );
}
