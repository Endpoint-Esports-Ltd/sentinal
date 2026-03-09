import { readStdin } from "../utils/hook-output.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

async function main(): Promise<void> {
  const input = await readStdin();

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
