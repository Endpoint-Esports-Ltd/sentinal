/**
 * Memory Observer Hook (Claude Code)
 *
 * PostToolUse hook that analyzes tool events for learning moments
 * and auto-captures observations to the memory system.
 *
 * Triggered after: Write, Edit, MultiEdit, Bash
 * Reads tool context from stdin, runs capture heuristics,
 * and persists observations when confidence is high enough.
 */

import { readStdin } from "../utils/hook-output.js";
import { isMemoryEnabled } from "../memory/config.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  type ToolEvent,
} from "../memory/capture.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Event Buffer Persistence ─────────────────────────────────────────────────

/**
 * The event buffer is persisted to disk so it survives across hook invocations.
 * Each hook call is a separate process, so we can't keep state in memory.
 */
function getBufferPath(cwd: string): string {
  const dir = join(cwd, ".sentinal");
  mkdirSync(dir, { recursive: true });
  return join(dir, "event-buffer.json");
}

function loadBuffer(cwd: string): EventBuffer {
  const buffer = new EventBuffer(20);
  const path = getBufferPath(cwd);
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (Array.isArray(data)) {
        for (const event of data) {
          buffer.push(event as ToolEvent);
        }
      }
    }
  } catch {
    // Corrupted buffer, start fresh
  }
  return buffer;
}

function saveBuffer(cwd: string, buffer: EventBuffer): void {
  const path = getBufferPath(cwd);
  writeFileSync(path, JSON.stringify(buffer.recent(20).reverse()));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!isMemoryEnabled()) return;

  const input = await readStdin();

  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};

  // Build tool event from hook input
  const filePath =
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined;

  const event: ToolEvent = {
    toolName,
    filePath,
    success: true, // PostToolUse only fires on success
    output: (toolInput.output as string)?.slice(0, 1000),
    timestamp: Date.now(),
  };

  // Load persisted event buffer
  const buffer = loadBuffer(input.cwd);
  buffer.push(event);

  // Run capture heuristics
  const decision = analyzeEvent(event, buffer);

  // Save buffer (even if no capture, for future pattern detection)
  saveBuffer(input.cwd, buffer);

  if (!decision.shouldCapture || decision.confidence < MIN_CAPTURE_CONFIDENCE) {
    return;
  }

  // Persist observation
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
      metadata: {
        source: "auto-capture",
        confidence: decision.confidence,
        toolName,
      },
    });

    service.close();
  } catch {
    // Memory capture failure is non-fatal
  }
}

main().catch(() => {});
