export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /**
   * PostToolUse only: the tool's response. Its shape is tool-specific. For
   * Bash it is `{stdout, stderr, interrupted, isImage, noOutputExpected}` —
   * there is NO `output` field (kept only for older/synthetic payloads). Read
   * Bash text through `bashOutputOf()`, never a field directly.
   */
  tool_response?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    /** Legacy / non-Claude-Code payloads only. */
    output?: string;
    [key: string]: unknown;
  };
  /** PostToolUse / PostToolUseFailure: id of the tool call */
  tool_use_id?: string;
  /** PostToolUseFailure: whether the failure was a user interrupt */
  is_interrupt?: boolean;
  /** PostToolUse (CC 2.1.119+): duration of the tool call in milliseconds */
  duration_ms?: number;

  // ── Stop / StopFailure / SubagentStop fields ─────────────────────────────
  /** Whether a stop hook is currently active (prevents infinite loops) */
  stop_hook_active?: boolean;
  /** The last message the assistant produced before stopping */
  last_assistant_message?: string;
  /** Subagent identifier (CC 2.1.47+) */
  agent_id?: string;
  /** Subagent type, e.g. "main", "Explore", or a custom agent name (CC 2.1.69+) */
  agent_type?: string;
  /** Active background tasks at stop time (CC 2.1.145+) */
  background_tasks?: unknown[];
  /** Active session crons at stop time (CC 2.1.145+) */
  session_crons?: unknown[];

  // ── StopFailure / PostToolUseFailure fields ───────────────────────────────
  /**
   * StopFailure: error type ("rate_limit" | "authentication_failed" | …).
   * PostToolUseFailure: the failure text — for Bash, `Exit code N` then the
   * interleaved stdout/stderr (possibly middle-truncated).
   */
  error?: string;
  /** Human-readable error details, e.g. "429 Too Many Requests" */
  error_details?: string;

  // ── ConfigChange fields ───────────────────────────────────────────────────
  /** Config source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills" */
  source?: string;

  // ── InstructionsLoaded / FileChanged / ConfigChange fields ───────────────
  /** File path of the loaded/changed file */
  file_path?: string;

  // ── InstructionsLoaded fields ─────────────────────────────────────────────
  /** Memory type: "Project" | "User" | "System" */
  memory_type?: string;
  /** Why the file was loaded: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact" */
  load_reason?: string;

  // ── CwdChanged fields ─────────────────────────────────────────────────────
  /** Previous working directory */
  old_cwd?: string;
  /** New working directory after the change */
  new_cwd?: string;

  // ── FileChanged fields ────────────────────────────────────────────────────
  /** File system event type: "change" | "create" | "delete" */
  event?: string;

  // ── TaskCreated fields ────────────────────────────────────────────────────
  /** Unique task identifier */
  task_id?: string;
  /** Short task subject/title */
  task_subject?: string;
  /** Detailed task description */
  task_description?: string;
  /** Name of the teammate assigned to the task */
  teammate_name?: string;
  /** Name of the team */
  team_name?: string;

  // ── Effort fields (CC 2.1.133+) ───────────────────────────────────────────
  /** Effort level for the current session: "low" | "medium" | "high" | "xhigh" */
  effort?: { level?: string };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The text a Claude Code tool call produced, for hooks that inspect Bash output.
 *
 * In order: `tool_response.stdout` + `stderr` (the documented Bash shape,
 * empties skipped, joined by a newline); the legacy `tool_response.output`;
 * the top-level `error` of a tool event (a `PostToolUseFailure` payload — only
 * when `tool_name` is set, so a StopFailure's `error: "rate_limit"` is never
 * mistaken for output); the legacy `tool_input.output`. `undefined` if none.
 */
export function bashOutputOf(input: HookInput): string | undefined {
  const response = input.tool_response;
  const streams = [response?.stdout, response?.stderr].filter(nonEmpty);
  if (streams.length > 0) return streams.join("\n");
  if (nonEmpty(response?.output)) return response.output;
  if (input.tool_name !== undefined && nonEmpty(input.error))
    return input.error;
  const legacyInput = input.tool_input?.output;
  return nonEmpty(legacyInput) ? legacyInput : undefined;
}

export interface DenyOutput {
  permissionDecision: "deny";
  reason: string;
}

export interface HintOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

export interface BlockOutput {
  decision: "block";
  reason: string;
}

export function deny(reason: string): DenyOutput {
  return { permissionDecision: "deny", reason };
}

export function hint(eventName: string, context: string): HintOutput {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

export function block(reason: string): BlockOutput {
  return { decision: "block", reason };
}

export async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export function output(data: DenyOutput | HintOutput | BlockOutput): void {
  process.stdout.write(JSON.stringify(data));
}

/**
 * Write deny/block reason to stderr, JSON to stdout, and exit with code 2.
 * Claude Code's hook protocol expects exit 2 denials to have the reason on stderr.
 */
export function denyExit(reason: string): never {
  process.stderr.write(reason);
  process.stdout.write(JSON.stringify({ permissionDecision: "deny", reason }));
  process.exit(2);
}

/**
 * Soft-block that feeds back to Claude as context (requires continueOnBlock: true in hooks.json).
 * Exit code 2 is required — CC only acts on { decision: "block" } when exit code is 2.
 * The continueOnBlock:true in hooks.json tells CC to feed the reason back as context
 * instead of terminating the turn. Exiting 0 would silently downgrade to a no-op.
 */
export function blockExit(reason: string): never {
  process.stderr.write(reason);
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(2);
}

/**
 * Soft Stop-hook feedback via `hookSpecificOutput.additionalContext` at EXIT 0.
 *
 * Per Claude Code hook docs: a Stop hook emitting `additionalContext` as
 * non-error feedback keeps the conversation going (labeled "Stop hook feedback")
 * under the standard 8-consecutive-continuation cap — and the hook MUST exit 0
 * for the JSON to be processed (exit 2 makes CC ignore the JSON). This is the
 * opposite of `blockExit`'s exit-2 hard-deny route and is the correct mechanism
 * for a non-blocking spec-status nudge (verified in the 2026-07-17 spike).
 *
 * Writes the JSON to stdout and exits 0.
 */
export function stopContext(reason: string): never {
  process.stdout.write(JSON.stringify(hint("Stop", reason)));
  process.exit(0);
}
