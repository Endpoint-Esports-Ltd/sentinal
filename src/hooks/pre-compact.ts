/**
 * Pre-Compact Hook
 *
 * Saves the active plan + restored memory context to
 * `.sentinal/compact-state.json` so `post-compact-restore` can re-inject
 * them after the context window is compacted.
 *
 * `processPreCompact` is consumed by BOTH the standalone entry below and
 * the CLI dispatcher (`src/cli/commands/hook.ts`). Sidecar-first with a
 * direct-store fallback; bumps the session heartbeat and passes the
 * session id through to the spec sync (dispatcher behaviour, M10c).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin, type HookInput } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { findActivePlan } from "../spec/detect.js";
import { SidecarClient } from "../sidecar/client.js";

interface CompactState {
  activePlan: string | null;
  memoryContext: string | null;
  timestamp: string;
  cwd: string;
}

export async function processPreCompact(input: HookInput): Promise<void> {
  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;

  // Find active spec plan using the shared parser
  const active = findActivePlan(searchDir);
  const activePlan = active?.filePath ?? null;

  // Save memory context for post-compact restoration
  let memoryContext: string | null = null;
  let semanticQuery: string | undefined;
  try {
    const { buildSemanticQuery } = await import("../memory/restore.js");
    semanticQuery = buildSemanticQuery(input.cwd);
  } catch {
    /* non-fatal */
  }

  try {
    const client = await SidecarClient.connect();
    if (client) {
      // Bump heartbeat via sidecar (fire-and-forget — non-critical)
      client.touchSession(input.session_id).catch(() => {});
      const restored = await client.restoreContext(input.cwd, semanticQuery);
      if (restored.hasMemory) memoryContext = restored.markdown;
      if (active) {
        await client.syncSpec(active.filePath, input.cwd, input.session_id);
      }
    } else {
      // Direct fallback (no sidecar running)
      const { MemoryStore } = await import("../memory/store.js");
      const { MemoryService } = await import("../memory/service.js");
      const { restoreContext } = await import("../memory/restore.js");
      const { SpecStore } = await import("../spec/store.js");
      const store = new MemoryStore();
      // Bump heartbeat on every pre-compact (hook runs frequently → reliable liveness signal)
      store.touchSession(input.session_id);
      const service = new MemoryService(store);
      const restored = await restoreContext(service, {
        projectPath: input.cwd,
        semanticQuery,
      });
      if (restored.hasMemory) memoryContext = restored.markdown;
      if (active) {
        const specStore = new SpecStore(store);
        specStore.syncFromPlanFile(
          active.filePath,
          input.cwd,
          input.session_id,
        );
      }
      service.close();
    }
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
  writeFileSync(
    join(stateDir, "compact-state.json"),
    JSON.stringify(state, null, 2),
  );
}

async function main(): Promise<void> {
  await processPreCompact(await readStdin());
}

if (import.meta.main) {
  main().catch(() => {});
}
