import { readStdin, block, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { findActivePlan, shouldBlockStop } from "../spec/detect.js";

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const active = findActivePlan(gitRoot ?? input.cwd);
  const reason = shouldBlockStop(active?.spec.status ?? null);
  if (reason) {
    output(block(reason));
    process.exit(2);
  }
}
if (import.meta.main) {
  main().catch(() => {});
}
