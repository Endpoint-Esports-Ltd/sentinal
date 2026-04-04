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
  process.stdout.write(
    JSON.stringify({ permissionDecision: "deny", reason }),
  );
  process.exit(2);
}
