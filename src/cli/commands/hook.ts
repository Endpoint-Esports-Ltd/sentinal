/**
 * Hook Command — `sentinal hook shared|claude <name>`
 *
 * Dispatches Claude Code lifecycle hooks via the sentinal binary.
 * Each hook reads HookInput JSON from stdin and optionally writes
 * a response (deny/hint/block) JSON to stdout.
 *
 * Shared hooks: logic is target-agnostic, used by both Claude Code and OpenCode
 * Claude hooks: logic references Claude Code-specific tool names or conventions
 */

import type { Command } from "commander";
import { readStdin, output } from "../../utils/hook-output.js";

// ─── Shared Hooks ────────────────────────────────────────────────────────────

async function runTddGuard(): Promise<void> {
  const { processTddGuard } = await import("../../hooks/tdd-guard.js");
  const input = await readStdin();
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const filePath =
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined;

  const result = processTddGuard({ toolName, filePath, cwd: input.cwd });
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
  const filePath =
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined;
  const bashOutput =
    toolName === "Bash"
      ? ((input.tool_response?.output as string) ?? (toolInput.output as string) ?? undefined)
      : undefined;

  await processTddTracking({
    toolName,
    filePath,
    bashOutput,
    sessionId: input.session_id,
    cwd: input.cwd,
  });
}

async function runSessionStart(): Promise<void> {
  const { MemoryStore } = await import("../../memory/store.js");
  const { autoStartDashboard } = await import("../../dashboard/lifecycle.js");
  const { detectAssistant } = await import("../../hooks/session-start.js");
  const input = await readStdin();

  const store = new MemoryStore();
  store.insertSession({
    id: input.session_id,
    startTime: Date.now(),
    endTime: null,
    projectPath: input.cwd,
    assistant: detectAssistant(),
    summary: null,
    transcriptPath: input.transcript_path ?? null,
  });
  store.close();
  autoStartDashboard();
}

async function runSessionEnd(): Promise<void> {
  const { unlinkSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { MemoryStore } = await import("../../memory/store.js");
  const { stopServer } = await import("../../dashboard/lifecycle.js");
  const input = await readStdin();

  try {
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
    }
    store.close();
  } catch {
    // Non-fatal
  }

  const bufferPath = join(input.cwd, ".sentinal", "event-buffer.json");
  try {
    if (existsSync(bufferPath)) {
      unlinkSync(bufferPath);
    }
  } catch {
    // Non-fatal cleanup
  }
}

async function runMemoryObserver(): Promise<void> {
  const { isMemoryEnabled } = await import("../../memory/config.js");
  if (!isMemoryEnabled()) return;

  const { MemoryStore } = await import("../../memory/store.js");
  const { MemoryService } = await import("../../memory/service.js");
  const { analyzeEvent, EventBuffer, MIN_CAPTURE_CONFIDENCE } = await import("../../memory/capture.js");
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const input = await readStdin();
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const filePath =
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined;

  const event = {
    toolName,
    filePath,
    success: true,
    output: (toolInput.output as string)?.slice(0, 1000),
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
  } catch { /* corrupted buffer */ }

  buffer.push(event);
  const decision = analyzeEvent(event, buffer);
  writeFileSync(bufferPath, JSON.stringify(buffer.recent(20).reverse()));

  if (!decision.shouldCapture || decision.confidence < MIN_CAPTURE_CONFIDENCE) return;

  try {
    const store = new MemoryStore();
    const service = new MemoryService(store);
    service.addObservation({
      sessionId: input.session_id,
      projectPath: input.cwd,
      timestamp: Date.now(),
      type: decision.type,
      title: decision.title,
      content: decision.content,
      filePaths: decision.filePaths,
      tags: decision.tags,
      metadata: { source: "auto-capture", confidence: decision.confidence, toolName },
    });
    service.close();
  } catch {
    // Non-fatal
  }
}

async function runMemoryRestore(): Promise<void> {
  const { isMemoryEnabled } = await import("../../memory/config.js");
  if (!isMemoryEnabled()) return;

  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const { MemoryStore } = await import("../../memory/store.js");
  const { MemoryService } = await import("../../memory/service.js");
  const { restoreContext } = await import("../../memory/restore.js");
  const input = await readStdin();

  try {
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const result = restoreContext(service, { projectPath: input.cwd });
    service.close();
    if (result.hasMemory && result.markdown) {
      output(hintFn("SessionStart", result.markdown));
    }
  } catch {
    // Non-fatal
  }
}

async function runSpecStopGuard(): Promise<void> {
  const { block: blockFn } = await import("../../utils/hook-output.js");
  const { findGitRoot } = await import("../../utils/git.js");
  const { findActivePlan, shouldBlockStop } = await import("../../spec/detect.js");
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
  const { MemoryStore } = await import("../../memory/store.js");
  const { MemoryService } = await import("../../memory/service.js");
  const { restoreContext } = await import("../../memory/restore.js");
  const { findActivePlan } = await import("../../spec/detect.js");
  const { SpecStore } = await import("../../spec/store.js");
  const input = await readStdin();

  const gitRoot = await findGitRoot(input.cwd);
  const searchDir = gitRoot ?? input.cwd;
  const active = findActivePlan(searchDir);
  const activePlan = active?.filePath ?? null;

  let memoryContext: string | null = null;
  try {
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const restored = restoreContext(service, { projectPath: input.cwd });
    if (restored.hasMemory) memoryContext = restored.markdown;
    if (active) {
      const specStore = new SpecStore(store);
      specStore.syncFromPlanFile(active.filePath, input.cwd);
    }
    service.close();
  } catch {
    // Non-fatal
  }

  const stateDir = join(searchDir, ".sentinal");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "compact-state.json"),
    JSON.stringify({ activePlan, memoryContext, timestamp: new Date().toISOString(), cwd: input.cwd }, null, 2),
  );
}

async function runPostCompactRestore(): Promise<void> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const { findGitRoot } = await import("../../utils/git.js");
  const input = await readStdin();

  const gitRoot = await findGitRoot(input.cwd);
  const stateFile = join(gitRoot ?? input.cwd, ".sentinal", "compact-state.json");
  if (!existsSync(stateFile)) return;

  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    const msgs: string[] = ["Session restored after compaction."];
    if (state.activePlan) {
      msgs.push(`Active plan: ${state.activePlan}`);
      msgs.push("Resume the /spec workflow by reading the plan file and continuing from where you left off.");
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

// ─── Claude-Specific Hooks ───────────────────────────────────────────────────

async function runToolRedirect(): Promise<void> {
  const { processToolRedirect } = await import("../../hooks/tool-redirect.js");
  const input = await readStdin();
  const result = processToolRedirect(
    input.tool_name ?? "",
    (input.tool_input as Record<string, unknown>) ?? {},
  );
  if (result) {
    output(result);
    if ("permissionDecision" in result && result.permissionDecision === "deny") {
      process.exit(2);
    }
  }
}

async function runFileChecker(): Promise<void> {
  const { processFileCheck } = await import("../../hooks/file-checker.js");
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath = (toolInput?.file_path as string) ?? (toolInput?.path as string);
  if (!filePath) return;
  const result = await processFileCheck(filePath, input.cwd);
  if (result) output(hintFn("PostToolUse", result));
}

async function runContextMonitor(): Promise<void> {
  const { hint: hintFn } = await import("../../utils/hook-output.js");
  const { estimateContextUsage } = await import("../../sessions/context.js");
  const { getContextWarning } = await import("../../sessions/context-display.js");
  const input = await readStdin();
  const usage = estimateContextUsage(input.transcript_path);
  const warning = getContextWarning(usage);
  if (warning) output(hintFn("PostToolUse", warning));
}

// ─── Dispatch Maps ───────────────────────────────────────────────────────────

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
};

const CLAUDE_HOOKS: Record<string, () => Promise<void>> = {
  "tool-redirect": runToolRedirect,
  "file-checker": runFileChecker,
  "context-monitor": runContextMonitor,
};

// ─── Registration ────────────────────────────────────────────────────────────

export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description("Execute lifecycle hooks (used by Claude Code and OpenCode)");

  // sentinal hook shared <name>
  const shared = hook
    .command("shared")
    .description("Target-agnostic hooks shared by both Claude Code and OpenCode")
    .argument("<name>", `Hook name: ${Object.keys(SHARED_HOOKS).join(", ")}`)
    .action(async (name: string) => {
      const hookFn = SHARED_HOOKS[name];
      if (!hookFn) {
        process.stderr.write(`Unknown shared hook: ${name}\nAvailable: ${Object.keys(SHARED_HOOKS).join(", ")}\n`);
        process.exit(1);
      }
      await hookFn();
    });

  // sentinal hook claude <name>
  const claude = hook
    .command("claude")
    .description("Claude Code-specific hooks")
    .argument("<name>", `Hook name: ${Object.keys(CLAUDE_HOOKS).join(", ")}`)
    .action(async (name: string) => {
      const hookFn = CLAUDE_HOOKS[name];
      if (!hookFn) {
        process.stderr.write(`Unknown claude hook: ${name}\nAvailable: ${Object.keys(CLAUDE_HOOKS).join(", ")}\n`);
        process.exit(1);
      }
      await hookFn();
    });
}
