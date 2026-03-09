import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { restoreContext } from "../memory/restore.js";

interface CompactState {
  activePlan: string | null;
  memoryContext: string | null;
  timestamp: string;
  cwd: string;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;

  // Find active spec plan
  let activePlan: string | null = null;
  const plansDir = join(searchDir, "docs", "plans");
  if (existsSync(plansDir)) {
    const files = readdirSync(plansDir).filter((f: string) => f.endsWith(".md")).sort().reverse();
    for (const file of files) {
      const content = readFileSync(join(plansDir, file), "utf-8");
      if (content.includes("PENDING") || content.includes("COMPLETE")) {
        activePlan = join(plansDir, file);
        break;
      }
    }
  }

  // Save memory context for post-compact restoration
  let memoryContext: string | null = null;
  try {
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const restored = restoreContext(service, { projectPath: input.cwd });
    if (restored.hasMemory) {
      memoryContext = restored.markdown;
    }
    service.close();
  } catch {
    // Memory unavailable, continue without it
  }

  const stateDir = join(searchDir, ".sentinal");
  mkdirSync(stateDir, { recursive: true });
  const state: CompactState = {
    activePlan,
    memoryContext,
    timestamp: new Date().toISOString(),
    cwd: input.cwd,
  };
  writeFileSync(join(stateDir, "compact-state.json"), JSON.stringify(state, null, 2));
}
main().catch(() => {});
