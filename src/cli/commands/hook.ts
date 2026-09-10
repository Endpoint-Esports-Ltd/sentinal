/**
 * Hook Command — `sentinal hook shared|claude <name>`
 * Dispatches lifecycle hooks. Each reads HookInput JSON from stdin.
 * Shared hooks = target-agnostic; Claude hooks = Claude Code-specific.
 */

import type { Command } from "commander";
import { readStdin, output, hint, denyExit } from "../../utils/hook-output.js";
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
    denyExit(result.reason);
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
  // Pass version so dashboard restarts on binary update
  const { getVersion } = await import("../index.js");
  await autoStartDashboard(getVersion());

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
  // Shared with the standalone hook (M10c). Deliberately does NOT stop the
  // sidecar — post-v1.36.2 H1 it owns its own session-aware lifecycle.
  const { processSessionEnd } = await import("../../hooks/session-end.js");
  await processSessionEnd(await readStdin());
}

async function runMemoryObserver(): Promise<void> {
  const { processMemoryObserver } =
    await import("../../hooks/memory-observer.js");
  const input = await readStdin();
  await processMemoryObserver(input);
}

async function runMemoryRestore(): Promise<void> {
  const { processMemoryRestore } =
    await import("../../hooks/memory-restore.js");
  await processMemoryRestore(await readStdin());
}

async function runSpecStopGuard(): Promise<void> {
  const { processSpecStopGuard } =
    await import("../../hooks/spec-stop-guard.js");
  const input = await readStdin();
  await processSpecStopGuard(input);
}

async function runPreCompact(): Promise<void> {
  const { processPreCompact } = await import("../../hooks/pre-compact.js");
  await processPreCompact(await readStdin());
}

async function runPostCompactRestore(): Promise<void> {
  const { processPostCompactRestore } =
    await import("../../hooks/post-compact-restore.js");
  await processPostCompactRestore(await readStdin());
}

async function runToolRedirect(): Promise<void> {
  const { processToolRedirect } = await import("../../hooks/tool-redirect.js");
  const input = await readStdin();
  const result = processToolRedirect(
    input.tool_name ?? "",
    (input.tool_input as Record<string, unknown>) ?? {},
  );
  if (result) {
    if (
      "permissionDecision" in result &&
      result.permissionDecision === "deny"
    ) {
      denyExit(result.reason);
    }
    output(result);
  }
}

async function runFileChecker(): Promise<void> {
  const { processFileCheck } = await import("../../hooks/file-checker.js");
  const { blockExit } = await import("../../utils/hook-output.js");
  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath =
    (toolInput?.file_path as string) ?? (toolInput?.path as string);
  if (!filePath) return;
  const result = await processFileCheck(filePath, input.cwd);
  // Exit 2 + decision:block — paired with continueOnBlock:true in hooks.json
  // so Claude self-corrects instead of the turn ending (Phase 5, Section B).
  if (result) blockExit(result);
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

async function runPromptContext(): Promise<void> {
  const { main } = await import("../../hooks/prompt-context.js");
  await main();
}

async function runStopFailure(): Promise<void> {
  const { processStopFailure } = await import("../../hooks/stop-failure.js");
  await processStopFailure(await readStdin());
}

async function runConfigChange(): Promise<void> {
  const { processConfigChange } = await import("../../hooks/config-change.js");
  await processConfigChange(await readStdin());
}

async function runInstructionsLoaded(): Promise<void> {
  const { processInstructionsLoaded } =
    await import("../../hooks/instructions-loaded.js");
  await processInstructionsLoaded(await readStdin());
}

async function runCwdChanged(): Promise<void> {
  const { processCwdChanged } = await import("../../hooks/cwd-changed.js");
  await processCwdChanged(await readStdin());
}

async function runFileChanged(): Promise<void> {
  const { processFileChanged } = await import("../../hooks/file-changed.js");
  await processFileChanged(await readStdin());
}

async function runPostCompact(): Promise<void> {
  const { processPostCompact } = await import("../../hooks/post-compact.js");
  const result = await processPostCompact(await readStdin());
  if (result) output(hint("PostCompact", result));
}

async function runTaskCreated(): Promise<void> {
  const { processTaskCreated } = await import("../../hooks/task-created.js");
  await processTaskCreated(await readStdin());
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
  "prompt-context": runPromptContext,
  "stop-failure": runStopFailure,
  "config-change": runConfigChange,
  "instructions-loaded": runInstructionsLoaded,
  "cwd-changed": runCwdChanged,
  "file-changed": runFileChanged,
  "post-compact": runPostCompact,
  "task-created": runTaskCreated,
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
