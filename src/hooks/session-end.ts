import { readStdin } from "../utils/hook-output.js";

async function main(): Promise<void> {
  await readStdin();
  // Cleanup: remove any temporary session files
}
main().catch(() => {});
