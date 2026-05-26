import { readStdin } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";
import { findActivePlan } from "../spec/detect.js";
import { findGitRoot } from "../utils/git.js";
import type { HookInput } from "../utils/hook-output.js";

/**
 * StopFailure hook — runs when a turn ends due to an API error.
 *
 * 1. Sends a warning notification to the dashboard.
 * 2. If an active spec is in progress, also saves a memory observation
 *    of type "error" so the failure is preserved in the memory store.
 *
 * Output is IGNORED by Claude Code; this hook is side-effect only.
 */
export async function processStopFailure(input: HookInput): Promise<void> {
  const client = await SidecarClient.connect();
  if (!client) {
    process.stderr.write(
      "[stop-failure] sidecar unavailable — skipping notification\n",
    );
    return;
  }

  const error = input.error ?? "unknown";
  const errorDetails = input.error_details;
  const lastMessage = input.last_assistant_message;

  await client.insertNotification({
    type: "warning",
    title: `API Error: ${error}`,
    message: errorDetails,
  });

  // If a spec is active, persist the error as a memory observation
  try {
    const gitRoot = await findGitRoot(input.cwd);
    const active = findActivePlan(gitRoot ?? input.cwd);
    if (active && active.spec.status === "IN_PROGRESS") {
      const snippet = lastMessage?.slice(0, 200) ?? "(none)";
      await client.addObservation({
        sessionId: input.session_id,
        projectPath: input.cwd,
        type: "error",
        title: `API Error during spec: ${error}`,
        content: `Error: ${errorDetails ?? error}\nLast assistant message: ${snippet}`,
        tags: ["api-error", "stop-failure", error],
      });
    }
  } catch {
    // Non-fatal — spec check failure should not break the hook
  }
}

async function main(): Promise<void> {
  const input = await readStdin();
  await processStopFailure(input);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(String(err));
    process.exit(1);
  });
}
