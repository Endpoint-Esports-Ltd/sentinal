/**
 * Hook Command — `sentinal hook shared|claude <name>`
 * Dispatches lifecycle hooks. Each reads HookInput JSON from stdin.
 * Shared hooks = target-agnostic; Claude hooks = Claude Code-specific.
 */

import type { Command } from "commander";
import { readStdin, output } from "../../utils/hook-output.js";
import { SidecarClient } from "../../sidecar/client.js";
import { autoStartSidecar } from "../../sidecar/lifecycle.js";

function extractFilePath(
  toolInput: Record<string, unknown>,
): string | undefined {
  return (
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined
  );
}

async function runTddGuard(): Promise<void> {
  const { processTddGuard } = await import("../../hooks/tdd-guard.js");
  const input = await readStdin();
  const filePath = extractFilePath(input.tool_input ?? {});
  const result = processTddGuard({
    toolName: input.tool_name ?? "",
    filePath,
    cwd: input.cwd,
  });
  if (result) {
    output(result);
    process.exit(2);
  }
}

async function runTddTracker(): Promise<void> {
  const { processTddTracking } = await import("../../hooks/tdd-tracker.js");
  const input = await readStdin();
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const bashOutput =
    toolName === "Bash"
      ? ((input.tool_response?.output as string) ??
        (toolInput.output as string) ??
        undefined)
      : undefined;
  await processTddTracking({
    toolName,
    filePath: extractFilePath(toolInput),
    bashOutput,
    sessionId: input.session_id,
    cwd: input.cwd,
  });
}

async function runSessionStart(): Promise<void> {
  const { autoStartDashboard } = await import("../../dashboard/lifecycle.js");
  const { detectAssistant } = await import("../../hooks/session-start.js");
  const input = await readStdin();
  const assistant = detectAssistant();

  autoStartSidecar();
  autoStartDashboard();

  try {
    const client = await SidecarClient.connect();
    if (client) {
      await client.createSession({
        id: input.session_id,
        projectPath: input.cwd,
        assistant,
        transcriptPath: input.transcript_path ?? null,
      });
      return;
    }
  } catch {
    /* fall back to direct */
  }

  const { MemoryStore } = await import("../../memory/store.js");
  const store = new MemoryStore();
  store.insertSession({
    id: input.session_id,
    startTime: Date.now(),
    endTime: null,
    projectPath: input.cwd,
    assistant,
    summary: null,
    transcriptPath: input.transcript_path ?? null,
  });
  store.close();
}

async function runSessionEnd(): Promise<void> {
  const { unlinkSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { stopServer } = await import("../../dashboard/lifecycle.js");
  const { stopSidecarProcess } = await import("../../sidecar/lifecycle.js");
  const input = await readStdin();

  try {
    const client = await SidecarClient.connect();
    if (client) {
      await client.endSession(input.session_id, { notification: true });
      const active = await client.getActiveSessions();
      if (active.length === 0) {
        stopServer();
        stopSidecarProcess();
      }
    } else {
      // Direct fallback
      const { MemoryStore } = await import("../../memory/store.js");
      const store = new MemoryStore();
      store.endSession(input.session_id);
      store.insertNotification({
        type: "info",
        title: "Session ended",
        message: `Session ${input.session_id.slice(0, 8)} ended`,
        source: "session-end",
        sessionId: input.session_id,
      });
      const active = store.getActiveSessions();
      if (active.length === 0) {
        stopServer();
        stopSidecarProcess();
      }
      store.close();
    }
  } catch {
    // Non-fatal
  }

  const bufferPath = join(input.cwd, ".sentinal", "event-buffer.json");
  try {
    if (existsSync(bufferPath)) unlinkSync(bufferPath);
  } catch {
    /* non-fatal */
  }
}

async function runMemoryObserver(): Promise<void> {
  const { isMemoryEnabled } = await import("../../memory/config.js");
  if (!isMemoryEnabled()) return;

  const { analyzeEvent, EventBuffer, MIN_CAPTURE_CONFIDENCE } =
    await import("../../memory/capture.js");
  const { existsSync, readFileSync, writeFileSync, mkdirSync } =
    await import("node:fs");
  const { join } = await import("node:path");

  const input = await readStdin();
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const filePath = extractFilePath(toolInput);
  // Use tool_response for actual output (esp. Bash results); fall back to tool_input
  const rawOutput =
    (input.tool_response?.output as string) ??
    (toolInput.output as string) ??
    undefined;
  const event = {
    toolName,
    filePath,
    success: true,
    output: rawOutput?.slice(0, 2000),
    timestamp: Date.now(),
  };

  // Load persisted event buffer
  const bufferDir = join(input.cwd, ".sentinal");
  mkdirSync(bufferDir, { recursive: true });
  const bufferPath = join(bufferDir, "event-buffer.json");
  const buffer = new EventBuffer(20);
  try {
    if (existsSync(bufferPath)) {
      const data = JSON.parse(readFileSync(bufferPath, "utf-8"));
      if (Array.isArray(data)) {
        for (const e of data) buffer.push(e);
      }
    }
  } catch {
    /* corrupted buffer */
  }

  buffer.push(event);
  const decision = analyzeEvent(event, buffer);
  writeFileSync(bufferPath, JSON.stringify(buffer.recent(20).reverse()));

  if (!decision.shouldCapture || decision.confidence < MIN_CAPTURE_CONFIDENCE)
    return;

  const obsPayload = {
    sessionId: input.session_id,
    projectPath: input.cwd,
    type: decision.type,
    title: decision.title,
    content: decision.content,
    filePaths: decision.filePaths,
    tags: decision.tags,
    metadata: {
      source: "auto-capture",
      confidence: decision.confidence,
      toolName,
    },
  };

  try {
    const client = await SidecarClient.connect();
    if (client) {
      await client.addObservation(obsPayload);
      return;
    }
  } catch {
    /* fall back */
  }

  try {
    const { MemoryStore } = await import("../../memory/store.js");
    const { MemoryService } = await import("../../memory/service.js");
    const store = new MemoryStore();
    const service = new MemoryService(store);
    service.addObservation({ ...obsPayload, timestamp: Date.now() });
    service.close();
  } catch {
    /* non-fatal */
  }
}

async function runMemoryRestore(): Promise<void> {
  const { isMemoryEnabled } = await import("../../memory/config.js");
  if (!isMemoryEnabled()) return;

  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const input = await readStdin();

  // Build semantic query for context-aware restore
  let semanticQuery: string | undefined;
  try {
    const { buildSemanticQuery } = await import("../../memory/restore.js");
    semanticQuery = buildSemanticQuery(input.cwd);
  } catch {
    /* non-fatal */
  }

  try {
    const client = await SidecarClient.connect();
    if (client) {
      const result = await client.restoreContext(input.cwd, semanticQuery);
      if (result.hasMemory && result.markdown) {
        output(hintFn("SessionStart", result.markdown));
      }
      return;
    }
  } catch {
    /* fall back */
  }

  try {
    const { MemoryStore } = await import("../../memory/store.js");
    const { MemoryService } = await import("../../memory/service.js");
    const { restoreContext } = await import("../../memory/restore.js");
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const result = await restoreContext(service, {
      projectPath: input.cwd,
      semanticQuery,
    });
    service.close();
    if (result.hasMemory && result.markdown) {
      output(hintFn("SessionStart", result.markdown));
    }
  } catch {
    /* non-fatal */
  }
}

async function runSpecStopGuard(): Promise<void> {
  const { block: blockFn } = await import("../../utils/hook-output.js");
  const { findGitRoot } = await import("../../utils/git.js");
  const { findActivePlan, shouldBlockStop } =
    await import("../../spec/detect.js");
  const input = await readStdin();

  const gitRoot = await findGitRoot(input.cwd);
  const active = findActivePlan(gitRoot ?? input.cwd);
  const reason = shouldBlockStop(active?.spec.status ?? null);
  if (reason) {
    output(blockFn(reason));
    process.exit(2);
  }
}

async function runPreCompact(): Promise<void> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { findGitRoot } = await import("../../utils/git.js");
  const { findActivePlan } = await import("../../spec/detect.js");
  const input = await readStdin();

  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;
  const active = findActivePlan(searchDir);
  const activePlan = active?.filePath ?? null;

  let memoryContext: string | null = null;
  let semanticQuery: string | undefined;
  try {
    const { buildSemanticQuery } = await import("../../memory/restore.js");
    semanticQuery = buildSemanticQuery(input.cwd);
  } catch {
    /* non-fatal */
  }

  try {
    const client = await SidecarClient.connect();
    if (client) {
      const restored = await client.restoreContext(input.cwd, semanticQuery);
      if (restored.hasMemory) memoryContext = restored.markdown;
      if (active) await client.syncSpec(active.filePath, input.cwd);
    } else {
      // Direct fallback
      const { MemoryStore } = await import("../../memory/store.js");
      const { MemoryService } = await import("../../memory/service.js");
      const { restoreContext } = await import("../../memory/restore.js");
      const { SpecStore } = await import("../../spec/store.js");
      const store = new MemoryStore();
      const service = new MemoryService(store);
      const restored = await restoreContext(service, {
        projectPath: input.cwd,
        semanticQuery,
      });
      if (restored.hasMemory) memoryContext = restored.markdown;
      if (active) {
        const specStore = new SpecStore(store);
        specStore.syncFromPlanFile(active.filePath, input.cwd);
      }
      service.close();
    }
  } catch {
    /* non-fatal */
  }

  const stateDir = join(searchDir, ".sentinal");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "compact-state.json"),
    JSON.stringify(
      {
        activePlan,
        memoryContext,
        timestamp: new Date().toISOString(),
        cwd: input.cwd,
      },
      null,
      2,
    ),
  );
}

async function runPostCompactRestore(): Promise<void> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const { findGitRoot } = await import("../../utils/git.js");
  const input = await readStdin();

  const gitRoot = await findGitRoot(input.cwd);
  const stateFile = join(
    gitRoot ?? input.cwd,
    ".sentinal",
    "compact-state.json",
  );
  if (!existsSync(stateFile)) return;

  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    const msgs: string[] = ["Session restored after compaction."];
    if (state.activePlan) {
      msgs.push(`Active plan: ${state.activePlan}`);
      msgs.push(
        "Resume the /spec workflow by reading the plan file and continuing from where you left off.",
      );
    }
    if (state.memoryContext) {
      msgs.push("");
      msgs.push(state.memoryContext);
    }
    output(hintFn("PostToolUse", msgs.join("\n")));
  } catch {
    // Corrupted state
  }
}

async function runToolRedirect(): Promise<void> {
  const { processToolRedirect } = await import("../../hooks/tool-redirect.js");
  const input = await readStdin();
  const result = processToolRedirect(
    input.tool_name ?? "",
    (input.tool_input as Record<string, unknown>) ?? {},
  );
  if (result) {
    output(result);
    if (
      "permissionDecision" in result &&
      result.permissionDecision === "deny"
    ) {
      process.exit(2);
    }
  }
}

async function runFileChecker(): Promise<void> {
  const { processFileCheck } = await import("../../hooks/file-checker.js");
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath =
    (toolInput?.file_path as string) ?? (toolInput?.path as string);
  if (!filePath) return;
  const result = await processFileCheck(filePath, input.cwd);
  if (result) output(hintFn("PostToolUse", result));
}

async function runContextMonitor(): Promise<void> {
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const { estimateContextUsage } = await import("../../sessions/context.js");
  const { getContextWarning } =
    await import("../../sessions/context-display.js");
  const input = await readStdin();
  const usage = estimateContextUsage(input.transcript_path);
  const warning = getContextWarning(usage);
  if (warning) output(hintFn("PostToolUse", warning));
}

async function runPreEditGuide(): Promise<void> {
  const { processPreEditGuide } = await import("../../hooks/pre-edit-guide.js");
  const { detectFileConflict } = await import("../../session/conflict.js");
  const { MemoryStore: Store } = await import("../../memory/store.js");
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const input = await readStdin();
  const filePath = extractFilePath(input.tool_input ?? {});
  if (!filePath) return;
  let client: SidecarClient | null = null;
  try {
    client = await SidecarClient.connect();
  } catch {
    /* no sidecar */
  }

  const parts: string[] = [];

  // File-level conflict check (uses session_id from hook input)
  if (input.session_id) {
    let store: InstanceType<typeof Store> | null = null;
    try {
      store = new Store();
      const conflict = detectFileConflict(
        store,
        filePath,
        input.cwd,
        input.session_id,
      );
      if (conflict) parts.push(conflict.message);
    } catch {
      /* non-fatal */
    } finally {
      store?.close();
    }
  }

  // Observation-based pre-edit guidance
  const guide = await processPreEditGuide({ filePath, cwd: input.cwd, client });
  if (guide) parts.push(guide);

  if (parts.length > 0) output(hintFn("PreToolUse", parts.join("\n")));
}

const SHARED_HOOKS: Record<string, () => Promise<void>> = {
  "tdd-guard": runTddGuard,
  "tdd-tracker": runTddTracker,
  "session-start": runSessionStart,
  "session-end": runSessionEnd,
  "memory-observer": runMemoryObserver,
  "memory-restore": runMemoryRestore,
  "spec-stop-guard": runSpecStopGuard,
  "pre-compact": runPreCompact,
  "post-compact-restore": runPostCompactRestore,
  "pre-edit-guide": runPreEditGuide,
};

const CLAUDE_HOOKS: Record<string, () => Promise<void>> = {
  "tool-redirect": runToolRedirect,
  "file-checker": runFileChecker,
  "context-monitor": runContextMonitor,
};

export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description("Execute lifecycle hooks (used by Claude Code and OpenCode)");

  hook
    .command("shared")
    .description("Target-agnostic hooks")
    .argument("<name>", `Hook name: ${Object.keys(SHARED_HOOKS).join(", ")}`)
    .action(async (name: string) => {
      const hookFn = SHARED_HOOKS[name];
      if (!hookFn) {
        process.stderr.write(
          `Unknown shared hook: ${name}\nAvailable: ${Object.keys(SHARED_HOOKS).join(", ")}\n`,
        );
        process.exit(1);
      }
      await hookFn();
    });

  hook
    .command("claude")
    .description("Claude Code-specific hooks")
    .argument("<name>", `Hook name: ${Object.keys(CLAUDE_HOOKS).join(", ")}`)
    .action(async (name: string) => {
      const hookFn = CLAUDE_HOOKS[name];
      if (!hookFn) {
        process.stderr.write(
          `Unknown claude hook: ${name}\nAvailable: ${Object.keys(CLAUDE_HOOKS).join(", ")}\n`,
        );
        process.exit(1);
      }
      await hookFn();
    });
}
