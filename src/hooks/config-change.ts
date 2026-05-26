/**
 * Config Change Hook
 *
 * Async hook (async: true) — detects when Sentinal rules files change
 * and saves a memory observation via the sidecar.
 *
 * Relevant files:
 *   - Any .md file under .sentinal/rules/
 *   - CLAUDE.md (basename match)
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import type { HookInput } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";

/**
 * Determine whether a given file_path is a Sentinal rules file
 * that warrants a memory observation.
 */
function isRulesFile(filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  if (filePath.includes(".sentinal/rules/")) return true;
  if (basename(filePath) === "CLAUDE.md") return true;
  return false;
}

/**
 * Process a ConfigChange hook event.
 * Saves a memory observation when a Sentinal rules file changes.
 * No-ops for non-rules files.
 *
 * This hook is async (async: true) — it must NOT call output() or block.
 */
export async function processConfigChange(input: HookInput): Promise<void> {
  const filePath = input.file_path;
  if (!filePath) return;

  const client = await SidecarClient.connect();
  if (!client) return;

  // Case 1: Sentinal rules or CLAUDE.md changed → memory observation
  if (isRulesFile(filePath)) {
    try {
      await client.addObservation({
        sessionId: input.session_id,
        projectPath: input.cwd,
        type: "discovery",
        title: `Rules file changed: ${basename(filePath)}`,
        content: `Config change detected: ${filePath}`,
        filePaths: [filePath],
        tags: ["config-change", "rules"],
      });
    } catch {
      // Non-fatal
    }
    return;
  }

  // Case 2: settings.json or hooks.json changed → check if hooks were disabled
  if (filePath.endsWith("settings.json") || filePath.endsWith("hooks.json")) {
    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.includes('"disableAllHooks"')) {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed.disableAllHooks === true) {
          await client.insertNotification({
            type: "warning",
            title: "Sentinal hooks disabled",
            message: `'disableAllHooks: true' detected in ${basename(filePath)}`,
          });
        }
      }
    } catch {
      // Non-fatal — file may not be readable or not valid JSON
    }
  }
}
