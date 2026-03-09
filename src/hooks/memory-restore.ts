/**
 * Memory Restore Hook (Claude Code)
 *
 * SessionStart hook that restores relevant memory context at the
 * beginning of a session. Outputs a compact markdown context block
 * as a hint that gets injected into the conversation.
 *
 * Also triggers on compaction (SessionStart with "compact" matcher)
 * to re-inject memory after context window is compacted.
 */

import { readStdin, hint, output } from "../utils/hook-output.js";
import { isMemoryEnabled } from "../memory/config.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { restoreContext } from "../memory/restore.js";

async function main(): Promise<void> {
  if (!isMemoryEnabled()) return;

  const input = await readStdin();

  try {
    const store = new MemoryStore();
    const service = new MemoryService(store);

    const result = restoreContext(service, {
      projectPath: input.cwd,
    });

    service.close();

    if (result.hasMemory && result.markdown) {
      output(hint("SessionStart", result.markdown));
    }
  } catch {
    // Memory restore failure is non-fatal
  }
}

main().catch(() => {});
