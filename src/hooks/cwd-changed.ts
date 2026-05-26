/**
 * CwdChanged Hook
 *
 * Invalidates the project-context cache in the sidecar when the
 * working directory changes. This ensures the next project_context
 * MCP tool call re-analyzes the new directory from disk.
 *
 * Runs on: CwdChanged
 */

import { readStdin } from "../utils/hook-output.js";
import type { HookInput } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";

type ClientLike = Pick<SidecarClient, "invalidateProjectContext">;

/**
 * Default connect function — exported for testing so it can be replaced
 * with a mock.
 */
export async function connectSidecar(): Promise<SidecarClient | null> {
  return SidecarClient.connect();
}

/**
 * Process a CwdChanged event by invalidating the project-context cache
 * for the new working directory.
 *
 * @param input      - The hook input from Claude Code
 * @param connect    - Optional connect function (injected in tests)
 */
export async function processCwdChanged(
  input: HookInput,
  connect: () => Promise<ClientLike | null> = connectSidecar,
): Promise<void> {
  const projectPath = input.new_cwd ?? input.cwd;

  try {
    const client = await connect();
    if (!client) return;
    await client.invalidateProjectContext(projectPath);
  } catch {
    // Non-fatal — cache invalidation is best-effort
  }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    await processCwdChanged(input);
  } catch {
    // Non-fatal — hook errors should never block the assistant
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
