import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin, block, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

export function shouldBlockStop(status: string | null): string | null {
  if (!status) return null;
  if (status === "PENDING") return `Active spec plan is PENDING (awaiting implementation). Resume with /spec <plan-path>. Do NOT stop.`;
  if (status === "COMPLETE") return `Active spec plan is COMPLETE (awaiting verification). Run verification phase. Do NOT stop.`;
  return null;
}

function findActivePlanStatus(cwd: string): string | null {
  const plansDir = join(cwd, "docs", "plans");
  if (!existsSync(plansDir)) return null;
  try {
    const files = readdirSync(plansDir).filter((f) => f.endsWith(".md")).sort().reverse();
    for (const file of files) {
      const content = readFileSync(join(plansDir, file), "utf-8");
      const m = content.match(/\*\*Status:\*\*\s*(PENDING|COMPLETE|VERIFIED)/);
      if (m && m[1] !== "VERIFIED") return m[1];
    }
  } catch { return null; }
  return null;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const status = findActivePlanStatus(gitRoot ?? input.cwd);
  const reason = shouldBlockStop(status);
  if (reason) { output(block(reason)); process.exit(2); }
}
if (import.meta.main) {
  main().catch(() => {});
}
