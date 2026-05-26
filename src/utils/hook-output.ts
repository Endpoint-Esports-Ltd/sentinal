export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse only: the tool's output/response */
  tool_response?: {
    output?: string;
    [key: string]: unknown;
  };
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

  // ── StopFailure fields ────────────────────────────────────────────────────
  /** Error type: "rate_limit" | "authentication_failed" | "billing_error" | etc. */
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
