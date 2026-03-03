export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
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
