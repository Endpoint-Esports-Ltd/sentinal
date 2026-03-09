import { readStdin } from "../utils/hook-output.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../memory/store.js";

async function main(): Promise<void> {
  const input = await readStdin();

  // End session in SQLite
  try {
    const store = new MemoryStore();
    store.endSession(input.session_id);
    store.close();
  } catch {
    // Non-fatal — session may not have been started
  }

  // Clean up event buffer (no longer needed after session ends)
  const bufferPath = join(input.cwd, ".sentinal", "event-buffer.json");
  try {
    if (existsSync(bufferPath)) {
      unlinkSync(bufferPath);
    }
  } catch {
    // Non-fatal cleanup
  }
}
main().catch(() => {});
