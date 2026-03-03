import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStdin, hint, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const stateFile = join(gitRoot ?? input.cwd, ".sentinal", "compact-state.json");
  if (!existsSync(stateFile)) return;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    const msgs: string[] = ["Session restored after compaction."];
    if (state.activePlan) { msgs.push(`Active plan: ${state.activePlan}`); msgs.push("Resume the /spec workflow by reading the plan file and continuing from where you left off."); }
    output(hint("PostToolUse", msgs.join("\n")));
  } catch { /* corrupted state */ }
}
main().catch(() => {});
