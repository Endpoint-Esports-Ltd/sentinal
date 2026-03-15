import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { restoreContext } from "../memory/restore.js";
import { findActivePlan } from "../spec/detect.js";
import { SpecStore } from "../spec/store.js";

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

  // Find active spec plan using the shared parser
  const active = findActivePlan(searchDir);
  const activePlan = active?.filePath ?? null;

  // Save memory context for post-compact restoration
  let memoryContext: string | null = null;
  try {
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const restored = await restoreContext(service, { projectPath: input.cwd });
    if (restored.hasMemory) {
      memoryContext = restored.markdown;
    }

    // Sync active spec to SQLite index before compaction
    if (active) {
      const specStore = new SpecStore(store);
      specStore.syncFromPlanFile(active.filePath, input.cwd);
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
