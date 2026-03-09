import { readStdin, block, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { findActivePlan } from "../spec/detect.js";
import type { SpecStatus } from "../spec/types.js";

export function shouldBlockStop(status: SpecStatus | null): string | null {
  if (!status) return null;
  if (status === "PENDING") return `Active spec plan is PENDING (awaiting implementation). Resume with /spec <plan-path>. Do NOT stop.`;
  if (status === "COMPLETE") return `Active spec plan is COMPLETE (awaiting verification). Run verification phase. Do NOT stop.`;
  return null;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const active = findActivePlan(gitRoot ?? input.cwd);
  const reason = shouldBlockStop(active?.spec.status ?? null);
  if (reason) { output(block(reason)); process.exit(2); }
}
if (import.meta.main) {
  main().catch(() => {});
}
