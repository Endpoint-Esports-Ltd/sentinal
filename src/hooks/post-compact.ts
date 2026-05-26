import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { HookInput } from "../utils/hook-output.js";

/**
 * PostCompact hook — verifies compacted context was restored correctly.
 *
 * Reads `.sentinal/compact-state.json` from `input.cwd`. If an active plan
 * is present, returns a message directing the user to resume with /spec.
 * If the file is missing or corrupt, returns a "no active plan" message.
 *
 * @returns A hint string to inject as additionalContext, or null on unexpected error.
 */
export async function processPostCompact(
  input: HookInput,
): Promise<string | null> {
  const stateFile = join(input.cwd, ".sentinal", "compact-state.json");

  if (!existsSync(stateFile)) {
    return "Context compacted. No active plan found.";
  }

  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
      activePlan?: string | null;
    };

    if (state.activePlan) {
      const planName = basename(state.activePlan);
      return `Context compacted. Active plan: ${planName}. Run /spec to resume.`;
    }

    return "Context compacted. No active plan found.";
  } catch {
    return "Context compacted. No active plan found.";
  }
}
