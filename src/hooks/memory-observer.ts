/**
 * Memory Observer Hook — extracted from src/cli/commands/hook.ts
 *
 * Analyses tool events and captures significant ones as memory observations.
 * Supports agent attribution fields (agent_id, agent_type) and tool timing
 * (duration_ms) in observation metadata.
 */

import { SidecarClient } from "../sidecar/client.js";
import { isMemoryEnabled } from "../memory/config.js";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
} from "../memory/capture.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HookInput } from "../utils/hook-output.js";

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

export async function processMemoryObserver(input: HookInput): Promise<void> {
  if (!isMemoryEnabled()) return;

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
      // Agent attribution (CC 2.1.47+ / 2.1.69+)
      ...(input.agent_id !== undefined && { agent_id: input.agent_id }),
      ...(input.agent_type !== undefined && { agent_type: input.agent_type }),
      // Tool timing (CC 2.1.119+)
      ...(input.duration_ms !== undefined && {
        duration_ms: input.duration_ms,
      }),
      // Last assistant message snippet for context
      ...(input.last_assistant_message !== undefined && {
        last_assistant_message: input.last_assistant_message.slice(0, 200),
      }),
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
    const { MemoryStore } = await import("../memory/store.js");
    const { MemoryService } = await import("../memory/service.js");
    const store = new MemoryStore();
    const service = new MemoryService(store);
    service.addObservation({ ...obsPayload, timestamp: Date.now() });
    service.close();
  } catch {
    /* non-fatal */
  }
}
