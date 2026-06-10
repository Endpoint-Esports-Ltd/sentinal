import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "index.ts");

/**
 * CLI wiring tests — these spawn the real dispatcher because hook handlers
 * that block call process.exit() and cannot be unit-tested in-process.
 */
describe("sentinal hook claude file-checker (CLI wiring)", () => {
  let dir: string;
  let bigFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinal-hook-cli-"));
    bigFile = join(dir, "big.ts");
    const lines = Array.from(
      { length: 650 },
      (_, i) => `export const v${i} = ${i};`,
    );
    writeFileSync(bigFile, lines.join("\n"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runFileChecker(filePath: string) {
    const input = JSON.stringify({
      session_id: "test",
      transcript_path: "/tmp/t",
      cwd: dir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath },
    });
    return Bun.spawnSync(["bun", CLI, "hook", "claude", "file-checker"], {
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  it("exits 2 with decision:block when the file violates limits", () => {
    const result = runFileChecker(bigFile);
    expect(result.exitCode).toBe(2);

    // continueOnBlock requires the block decision on stdout…
    const stdout = result.stdout.toString();
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("650 lines");

    // …and Claude Code only surfaces exit-2 reasons from stderr.
    expect(result.stderr.toString()).toContain("650 lines");
  }, 30_000);

  it("exits 0 silently when the file is clean", () => {
    const cleanFile = join(dir, "clean.test.ts");
    writeFileSync(cleanFile, "export const ok = 1;\n");
    const result = runFileChecker(cleanFile);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
