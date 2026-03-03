import { readStdin, hint, output } from "../utils/hook-output.js";

export function getContextWarning(rawPercent: number): string | null {
  if (rawPercent >= 85) return `Context ~${Math.round(rawPercent * 1.2)}%+ effective. Complete current task — auto-compaction imminent. Run /learn if this session has extractable knowledge.`;
  if (rawPercent >= 75) return `Context ~90% effective. Complete current work, don't start complex new tasks. Consider running /learn.`;
  if (rawPercent >= 65) return `Context ~80% effective. Work normally — auto-compaction handles the rest. Consider running /learn if valuable.`;
  return null;
}

async function main(): Promise<void> {
  try {
    const proc = Bun.spawnSync(["sh", "-c", "~/.pilot/bin/pilot check-context --json 2>/dev/null"], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (proc.exitCode !== 0) return;
    const data = JSON.parse(proc.stdout.toString());
    const warning = getContextWarning(data.percent ?? 0);
    if (warning) output(hint("PostToolUse", warning));
  } catch { return; }
}
if (import.meta.main) {
  main().catch(() => {});
}
