/**
 * Tool Failure Observer Hook (Claude Code `PostToolUseFailure`)
 *
 * `PostToolUse` fires only on success; a failed tool call (non-zero Bash exit,
 * Edit whose old_string is missing, MCP error, …) fires `PostToolUseFailure`
 * with the failure text in a top-level `error` string ("Exit code N\n…" for
 * Bash). This hook:
 *
 *   1. classifies the failure with `classifyToolFailure` (D2 exclusions);
 *   2. when worth keeping, saves an `error` observation — de-duplicated by
 *      signature (D3) through the sidecar's `POST /observation`, or directly
 *      through `MemoryService.addObservationDeduped` when no sidecar runs;
 *   3. pushes a `success: false` event into the per-checkout event buffer that
 *      memory-observer reads, so error → fix sequences are detected on Claude
 *      Code (they never were: only successful calls ever reached the buffer).
 *
 * ⛔ Error and command text go into `title`/`content` ONLY. They are redacted
 * here, BEFORE classification — the classifier truncates titles, and a secret
 * cut below the redactor's minimum length would otherwise survive as a
 * fragment. `metadata` and `tags` carry no error text at all.
 *
 * Registered async (output is additionalContext-only). Never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SidecarClient } from "../sidecar/client.js";
import { isMemoryEnabled } from "../memory/config.js";
import { EventBuffer, type ToolEvent } from "../memory/capture.js";
import { sanitize } from "../memory/sanitize.js";
import {
  classifyToolFailure,
  type ToolFailureInput,
  type ToolFailureSkipReason,
} from "../memory/tool-failure.js";
import type { CreateObservation } from "../memory/types.js";
import { resolveProjectIdentity } from "../project/identity.js";
import type { HookInput } from "../utils/hook-output.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ObservationPayload = Parameters<SidecarClient["addObservation"]>[0];

/** The subset of `SidecarClient` this hook uses. */
export interface FailureSidecar {
  addObservation(obs: ObservationPayload): Promise<unknown>;
}

/** The subset of `MemoryService` this hook uses. */
export interface FailureDirectSink {
  addObservationDeduped(obs: CreateObservation): unknown;
  close(): void;
}

export interface ToolFailureDeps {
  /** Default: `SidecarClient.connect()` — never autostarts from a hook. */
  connect?: () => Promise<FailureSidecar | null>;
  /** Default: a `MemoryService` over the default store. */
  openService?: () => FailureDirectSink | Promise<FailureDirectSink>;
}

export interface ToolFailureOutcome {
  captured: boolean;
  skipReason?: ToolFailureSkipReason | "no-error" | "memory-disabled";
  via?: "sidecar" | "direct";
  signature?: string;
}

/** Failures that are not errors worth "fixing" — kept out of the buffer. */
const NOT_BUFFERED: ReadonlySet<string> = new Set([
  "interrupted",
  "sentinal-guard",
  "no-match-exit",
  "empty-output",
]);

const MAX_BUFFER_OUTPUT_CHARS = 2000;

// ─── Payload mapping ─────────────────────────────────────────────────────────

/** Map a `PostToolUseFailure` payload to classifier input (null: nothing to classify). */
export function buildToolFailureInput(
  input: HookInput,
): ToolFailureInput | null {
  const toolName = input.tool_name;
  if (!toolName || typeof input.error !== "string") return null;
  const toolInput = input.tool_input ?? {};
  const command =
    typeof toolInput.command === "string" ? toolInput.command : undefined;
  const filePath =
    (toolInput.file_path as string | undefined) ??
    (toolInput.filePath as string | undefined) ??
    (toolInput.path as string | undefined) ??
    undefined;
  return {
    toolName,
    command,
    filePath,
    error: input.error,
    interrupted: input.is_interrupt === true,
  };
}

// ─── Event buffer ────────────────────────────────────────────────────────────

/**
 * Same file and same load → push → save sequence as memory-observer
 * (`<cwd>/.sentinal/event-buffer.json`, newest last, 20 events), so the next
 * successful Edit there sees this failure via `buffer.hasRecentError()`.
 */
function pushFailureEvent(cwd: string, event: ToolEvent): void {
  const bufferDir = join(cwd, ".sentinal");
  mkdirSync(bufferDir, { recursive: true });
  const bufferPath = join(bufferDir, "event-buffer.json");
  const buffer = new EventBuffer(20);
  try {
    if (existsSync(bufferPath)) {
      const data = JSON.parse(readFileSync(bufferPath, "utf-8"));
      if (Array.isArray(data)) for (const e of data) buffer.push(e);
    }
  } catch {
    /* corrupted buffer — start fresh */
  }
  buffer.push(event);
  writeFileSync(bufferPath, JSON.stringify(buffer.recent(20).reverse()));
}

// ─── Core ─────────────────────────────────────────────────────────────────────

async function defaultOpenService(): Promise<FailureDirectSink> {
  const { MemoryStore } = await import("../memory/store.js");
  const { MemoryService } = await import("../memory/service.js");
  return new MemoryService(new MemoryStore());
}

export async function processToolFailure(
  input: HookInput,
  deps: ToolFailureDeps = {},
): Promise<ToolFailureOutcome> {
  try {
    if (!isMemoryEnabled())
      return { captured: false, skipReason: "memory-disabled" };

    const raw = buildToolFailureInput(input);
    if (!raw) return { captured: false, skipReason: "no-error" };

    // Redact BEFORE classifying: every derived string (title, content,
    // buffered output) then starts from clean text.
    const failureInput: ToolFailureInput = {
      ...raw,
      error: sanitize(raw.error).text,
      command:
        raw.command === undefined ? undefined : sanitize(raw.command).text,
    };
    const result = classifyToolFailure(failureInput);

    if (result.capture || !NOT_BUFFERED.has(result.skipReason ?? "")) {
      try {
        pushFailureEvent(input.cwd, {
          toolName: failureInput.toolName,
          filePath: failureInput.filePath,
          success: false,
          output: failureInput.error.slice(0, MAX_BUFFER_OUTPUT_CHARS),
          timestamp: Date.now(),
        });
      } catch {
        /* buffer is best-effort */
      }
    }

    if (!result.capture) {
      return {
        captured: false,
        skipReason: result.skipReason,
        signature: result.signature,
      };
    }

    const payload: ObservationPayload = {
      sessionId: input.session_id,
      // STORAGE KEY — the canonical main checkout (never the raw cwd).
      projectPath: resolveProjectIdentity(input.cwd),
      type: "error",
      title: result.title,
      content: result.content,
      filePaths: failureInput.filePath ? [failureInput.filePath] : [],
      tags: result.tags,
      // ⛔ No error or command text in here — metadata is not redacted.
      metadata: {
        source: "auto-capture-failure",
        signature: result.signature,
        toolName: failureInput.toolName,
        ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        ...(input.duration_ms !== undefined && {
          duration_ms: input.duration_ms,
        }),
        ...(input.tool_use_id !== undefined && {
          tool_use_id: input.tool_use_id,
        }),
        ...(input.agent_id !== undefined && { agent_id: input.agent_id }),
        ...(input.agent_type !== undefined && { agent_type: input.agent_type }),
      },
    };

    const connect = deps.connect ?? (() => SidecarClient.connect());
    try {
      const client = await connect();
      if (client) {
        await client.addObservation(payload);
        return { captured: true, via: "sidecar", signature: result.signature };
      }
    } catch {
      /* fall back to the direct store */
    }

    try {
      const service = await (deps.openService ?? defaultOpenService)();
      try {
        // ⛔ The DEDUPED path — plain addObservation would insert a row per
        // retry, the flood D3 exists to prevent.
        service.addObservationDeduped({
          ...payload,
          filePaths: payload.filePaths ?? [],
          tags: payload.tags ?? [],
          metadata: payload.metadata ?? {},
          type: "error",
          timestamp: Date.now(),
        });
      } finally {
        service.close();
      }
      return { captured: true, via: "direct", signature: result.signature };
    } catch {
      return {
        captured: false,
        signature: result.signature,
      };
    }
  } catch {
    return { captured: false };
  }
}
