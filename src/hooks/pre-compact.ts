import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

interface CompactState { activePlan: string | null; timestamp: string; cwd: string; }

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;
  let activePlan: string | null = null;
  const plansDir = join(searchDir, "docs", "plans");
  if (existsSync(plansDir)) {
    const files = readdirSync(plansDir).filter((f: string) => f.endsWith(".md")).sort().reverse();
    for (const file of files) {
      const content = readFileSync(join(plansDir, file), "utf-8");
      if (content.includes("PENDING") || content.includes("COMPLETE")) { activePlan = join(plansDir, file); break; }
    }
  }
  const stateDir = join(searchDir, ".sentinal");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "compact-state.json"), JSON.stringify({ activePlan, timestamp: new Date().toISOString(), cwd: input.cwd } as CompactState, null, 2));
}
main().catch(() => {});
