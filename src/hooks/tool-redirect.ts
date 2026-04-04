import {
  deny,
  hint,
  readStdin,
  output,
  denyExit,
  type DenyOutput,
  type HintOutput,
} from "../utils/hook-output.js";

const BLOCKED_TOOLS: Record<string, string> = {
  WebSearch:
    "WebSearch is blocked. Use MCP web-search instead: ToolSearch(query='+web-search search')",
  WebFetch:
    "WebFetch is blocked. Use MCP web-fetch instead: ToolSearch(query='+web-fetch fetch')",
  EnterPlanMode:
    "EnterPlanMode is blocked. Use /spec for structured planning workflows.",
  ExitPlanMode:
    "ExitPlanMode is blocked. Use /spec for structured planning workflows.",
};

const VAGUE_GREP_INDICATORS = [
  /^how\s/i,
  /^what\s/i,
  /^where\s/i,
  /^why\s/i,
  /^find\s.*that/i,
  /\bworks?\b/i,
  /\bhandles?\b/i,
  /\bimplements?\b/i,
];

export function processToolRedirect(
  toolName: string,
  toolInput: Record<string, unknown>,
): DenyOutput | HintOutput | null {
  if (toolName in BLOCKED_TOOLS) {
    return deny(BLOCKED_TOOLS[toolName]);
  }
  if (toolName === "Grep" && typeof toolInput.pattern === "string") {
    if (
      VAGUE_GREP_INDICATORS.some((r) => r.test(toolInput.pattern as string))
    ) {
      return hint(
        "PreToolUse",
        `This Grep pattern looks like a semantic query. Consider using Vexor instead: vexor "${toolInput.pattern}"`,
      );
    }
  }
  return null;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const result = processToolRedirect(
    input.tool_name ?? "",
    (input.tool_input as Record<string, unknown>) ?? {},
  );
  if (result) {
    if ("permissionDecision" in result && result.permissionDecision === "deny") {
      denyExit(result.reason);
    }
    output(result);
  }
}
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(String(err));
    process.exit(1);
  });
}
