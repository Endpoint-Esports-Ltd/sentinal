/**
 * Memory Restore Hook (Claude Code)
 *
 * SessionStart hook that restores relevant memory context at the
 * beginning of a session. Outputs a compact markdown context block
 * as a hint that gets injected into the conversation.
 *
 * Also triggers on compaction (SessionStart with "compact" matcher)
 * to re-inject memory after context window is compacted.
 *
 * `processMemoryRestore` is consumed by BOTH the standalone entry below
 * and the CLI dispatcher (`src/cli/commands/hook.ts`). Sidecar-first with
 * a direct-store fallback; builds a semantic query from the project for
 * context-aware restore (dispatcher behaviour, M10c).
 */

import {
  readStdin,
  hint,
  output,
  type HookInput,
} from "../utils/hook-output.js";
import { isMemoryEnabled } from "../memory/config.js";
import { SidecarClient } from "../sidecar/client.js";

export async function processMemoryRestore(input: HookInput): Promise<void> {
  if (!isMemoryEnabled()) return;

  // Build semantic query for context-aware restore
  let semanticQuery: string | undefined;
  try {
    const { buildSemanticQuery } = await import("../memory/restore.js");
    semanticQuery = buildSemanticQuery(input.cwd);
  } catch {
    /* non-fatal */
  }

  try {
    const client = await SidecarClient.connect();
    if (client) {
      const result = await client.restoreContext(input.cwd, semanticQuery);
      if (result.hasMemory && result.markdown) {
        output(hint("SessionStart", result.markdown));
      }
      return;
    }
  } catch {
    /* fall back to direct */
  }

  try {
    const { MemoryStore } = await import("../memory/store.js");
    const { MemoryService } = await import("../memory/service.js");
    const { restoreContext } = await import("../memory/restore.js");
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const result = await restoreContext(service, {
      projectPath: input.cwd,
      semanticQuery,
    });
    service.close();
    if (result.hasMemory && result.markdown) {
      output(hint("SessionStart", result.markdown));
    }
  } catch {
    // Memory restore failure is non-fatal
  }
}

async function main(): Promise<void> {
  await processMemoryRestore(await readStdin());
}

if (import.meta.main) {
  main().catch(() => {});
}
