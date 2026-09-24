import { describe, it, expect } from "bun:test";
import {
  classifyToolFailure,
  parseExitCode,
  normalizeErrorLine,
  firstMeaningfulLine,
  MAX_ERROR_CONTENT_CHARS,
} from "./tool-failure.js";

const bash = (
  command: string,
  error: string,
  extra: Record<string, unknown> = {},
) => classifyToolFailure({ toolName: "Bash", command, error, ...extra });

describe("parseExitCode", () => {
  it("parses a leading `Exit code N` line", () => {
    expect(parseExitCode("Exit code 2\nboom")).toBe(2);
    expect(
      parseExitCode("  \nExit code 127\nbash: foo: command not found"),
    ).toBe(127);
  });

  it("returns undefined for a bare message", () => {
    expect(
      parseExitCode("String to replace not found in file."),
    ).toBeUndefined();
    expect(parseExitCode("something\nExit code 3")).toBeUndefined();
  });
});

describe("classifyToolFailure — exit code handling", () => {
  it("uses the parsed exit code (Claude Code)", () => {
    const r = bash(
      "bun run build",
      'Exit code 2\nerror: Could not resolve: "./x"',
    );
    expect(r.exitCode).toBe(2);
  });

  it("prefers the caller-supplied exit code (OpenCode metadata.exit)", () => {
    const r = classifyToolFailure({
      toolName: "bash",
      command: "bun run build",
      error: 'error: Could not resolve: "./x"',
      exitCode: 3,
    });
    expect(r.exitCode).toBe(3);
    expect(r.capture).toBe(true);
  });

  it("leaves exitCode undefined for a bare message", () => {
    const r = classifyToolFailure({
      toolName: "Edit",
      filePath: "/repo/src/a.ts",
      error: "String to replace not found in file.",
    });
    expect(r.exitCode).toBeUndefined();
    expect(r.capture).toBe(true);
  });
});

describe("classifyToolFailure — D2 exclusions", () => {
  it("skips interrupts", () => {
    const r = bash("bun run build", "Exit code 130\nerror: something", {
      interrupted: true,
    });
    expect(r.capture).toBe(false);
    expect(r.skipReason).toBe("interrupted");
  });

  it("skips Sentinal's own guard errors", () => {
    const r = classifyToolFailure({
      toolName: "edit",
      filePath: "/repo/src/a.ts",
      error: "[Sentinal TDD Guard] Write a failing test first",
    });
    expect(r.capture).toBe(false);
    expect(r.skipReason).toBe("sentinal-guard");
  });

  it("skips Sentinal guard errors that follow an exit-code line", () => {
    const r = bash("git commit", "Exit code 2\n[Sentinal] blocked");
    expect(r.skipReason).toBe("sentinal-guard");
  });

  const noMatch: Array<[string, string]> = [
    ["grep", "grep -rn foo src/"],
    ["rg", "rg 'needle' src"],
    ["diff", "diff a.txt b.txt"],
    ["cmp", "cmp a.bin b.bin"],
    ["test", "test -f /tmp/nope"],
    ["[", "[ -d /tmp/nope ]"],
    ["which", "which fd"],
    ["command -v", "command -v fd"],
    ["pgrep", "pgrep -f sentinal"],
    ["git diff --exit-code", "git diff --exit-code"],
    ["pipeline ending in grep", "cat file.txt | grep needle"],
    ["cd-prefixed rg", "cd /repo && rg needle"],
    ["absolute-path grep", "/usr/bin/grep x y"],
  ];
  for (const [label, command] of noMatch) {
    it(`skips exit 1 from ${label}`, () => {
      const r = bash(command, "Exit code 1\nsome output line");
      expect(r.capture).toBe(false);
      expect(r.skipReason).toBe("no-match-exit");
    });
  }

  it("does NOT skip grep when the exit code is 2 (a real error)", () => {
    const r = bash(
      "grep foo missing.txt",
      "Exit code 2\ngrep: missing.txt: No such file or directory",
    );
    expect(r.capture).toBe(true);
  });

  it("skips exit 1 with empty output", () => {
    const r = bash("some-script", "Exit code 1\n\n   \n");
    expect(r.capture).toBe(false);
    expect(r.skipReason).toBe("empty-output");
  });

  it("skips exit 1 with empty output passed explicitly (OpenCode)", () => {
    const r = classifyToolFailure({
      toolName: "bash",
      command: "false",
      error: "",
      exitCode: 1,
    });
    expect(r.skipReason).toBe("empty-output");
  });

  const runners = [
    "bun test src/a.test.ts",
    "npx jest",
    "vitest run",
    "npm test",
    "pnpm test",
    "yarn test",
    "npm run test",
    "pytest -q",
    "go test ./...",
    "cd /repo && bun test",
  ];
  for (const command of runners) {
    it(`skips assertion-only failures from \`${command}\``, () => {
      const r = bash(
        command,
        "Exit code 1\nsrc/a.test.ts:\n(fail) adds > works\nexpect(received).toBe(expected)\n 3 pass\n 1 fail",
      );
      expect(r.capture).toBe(false);
      expect(r.skipReason).toBe("assertion-only-test-failure");
    });
  }
});

describe("classifyToolFailure — capture classes", () => {
  const infra: Array<[string, string]> = [
    [
      "Cannot find module",
      "error: Cannot find module './missing' from '/repo/src/a.test.ts'",
    ],
    ["SyntaxError", "SyntaxError: Unexpected token '}'"],
    [
      "error TS",
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable",
    ],
    [
      "dlopen",
      "error: dlopen(/x/vec0.dylib, 0x0001): Library not loaded: @rpath/libsqlite3.dylib",
    ],
  ];
  for (const [label, line] of infra) {
    it(`captures a test run with an infrastructure failure (${label})`, () => {
      const r = bash(
        "bun test",
        `Exit code 1\n${line}\n 0 pass\n 1 fail\n 1 error`,
      );
      expect(r.capture).toBe(true);
      expect(r.skipReason).toBeUndefined();
    });
  }

  it("captures a non-test command whose error says 'test failed' (review finding)", () => {
    const r = bash(
      "npm run lint",
      "Exit code 1\nnpm ERR! test failed: lint script exited",
    );
    expect(r.capture).toBe(true);
  });

  it("captures a test-runner failure that has no assertion indicators", () => {
    const r = bash("bun test", 'Exit code 1\nerror: Script not found "tset"');
    expect(r.capture).toBe(true);
  });

  it("captures a compiler failure", () => {
    const r = bash(
      "bunx tsc --noEmit",
      "Exit code 2\nsrc/a.ts(1,1): error TS2307: Cannot find module 'x'.",
    );
    expect(r.capture).toBe(true);
  });

  it("captures command not found (exit 127)", () => {
    const r = bash("fdd -e ts", "Exit code 127\nbash: fdd: command not found");
    expect(r.capture).toBe(true);
  });

  it("captures a timeout", () => {
    const r = bash(
      "bun run build",
      "Command timed out after 2m 0s\nbuilding...",
    );
    expect(r.capture).toBe(true);
    expect(r.title).toContain("timed out");
  });

  it("captures a non-Bash tool failure with a file path", () => {
    const r = classifyToolFailure({
      toolName: "Edit",
      filePath: "/repo/src/memory/a.ts",
      error: "String to replace not found in file.",
    });
    expect(r.capture).toBe(true);
    expect(r.title).toContain("a.ts");
    expect(r.content).toContain("/repo/src/memory/a.ts");
  });
});

describe("classifyToolFailure — title, content, tags", () => {
  it("builds a short, specific title", () => {
    const r = bash(
      "bun test src/a.test.ts",
      "Exit code 1\nbun test v1.2.3 (abc1234)\nerror: Cannot find module 'x' from '/repo/src/a.test.ts'",
    );
    expect(r.title.startsWith("bun test failed: Cannot find module 'x'")).toBe(
      true,
    );
    expect(r.title.length).toBeLessThanOrEqual(120);
  });

  it("falls back to the exit code when there is no meaningful line", () => {
    const r = bash("./run.sh", "Exit code 3\n----\n");
    expect(r.title).toBe("./run.sh failed (exit 3)");
  });

  it("includes the command, exit code and error in content", () => {
    const r = bash(
      "bun run build",
      'Exit code 2\nerror: Could not resolve "./x"',
    );
    expect(r.content).toContain("bun run build");
    expect(r.content).toContain("Exit code: 2");
    expect(r.content).toContain("Could not resolve");
  });

  it("caps the error portion of content, keeping the head", () => {
    const long = "error: head line\n" + "x".repeat(10_000) + "\nTAIL_MARKER";
    const r = bash("bun run build", `Exit code 2\n${long}`);
    expect(r.content).toContain("error: head line");
    expect(r.content).not.toContain("TAIL_MARKER");
    expect(r.content.length).toBeLessThan(MAX_ERROR_CONTENT_CHARS + 800);
  });

  it("tolerates the middle-truncation marker", () => {
    const r = bash(
      "bun run build",
      'Exit code 1\n... [48213 characters truncated] ...\nerror: Could not resolve "./y"',
    );
    expect(r.capture).toBe(true);
    expect(r.title).toContain("Could not resolve");
    expect(r.title).not.toContain("characters truncated");
  });

  it("never puts raw error or command text in tags", () => {
    const r = bash(
      "curl -H 'Authorization: secret123' x",
      "Exit code 6\ncurl: (6) Could not resolve host: secret-host",
    );
    expect(r.tags).toEqual(["tool-failure", "Bash", "auto-captured"]);
    for (const t of r.tags) {
      expect(t).not.toContain("secret");
    }
  });
});

describe("signatures", () => {
  it("differ only in paths/line numbers → same signature", () => {
    const a = bash(
      "bun run build",
      'Exit code 1\nerror: Could not resolve "./x" at /Users/a/repo/src/foo.ts:12:5',
    );
    const b = bash(
      "bun run build --minify",
      'Exit code 1\nerror: Could not resolve "./x" at /tmp/other/lib/bar.ts:98:17',
    );
    expect(a.signature).toBe(b.signature);
  });

  it("file tools: same basename in different dirs share a signature", () => {
    const a = classifyToolFailure({
      toolName: "Edit",
      filePath: "/a/src/x.ts",
      error: "String not found in file",
    });
    const b = classifyToolFailure({
      toolName: "Edit",
      filePath: "/b/lib/x.ts",
      error: "String not found in file",
    });
    expect(a.signature).toBe(b.signature);
  });

  it("different root errors → different signatures", () => {
    const a = bash(
      "bun run build",
      "Exit code 1\nerror: Cannot find module 'x'",
    );
    const b = bash(
      "bun run build",
      "Exit code 1\nerror: Cannot find module 'y'",
    );
    const c = bash(
      "bunx tsc --noEmit",
      "Exit code 2\nsrc/a.ts(1,1): error TS2307: Cannot find module 'x'.",
    );
    const d = bash(
      "bunx tsc --noEmit",
      "Exit code 2\nsrc/a.ts(1,1): error TS2322: Type mismatch.",
    );
    expect(a.signature).not.toBe(b.signature);
    expect(c.signature).not.toBe(d.signature);
  });

  it("different tools → different signatures", () => {
    const a = classifyToolFailure({
      toolName: "Edit",
      filePath: "/a/x.ts",
      error: "boom",
    });
    const b = classifyToolFailure({
      toolName: "Write",
      filePath: "/a/x.ts",
      error: "boom",
    });
    expect(a.signature).not.toBe(b.signature);
  });

  it("is a 40-char sha1 hex", () => {
    expect(bash("x", "Exit code 2\nboom").signature).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("normalizeErrorLine", () => {
  it("normalizes paths, line:col, numbers, hex and timestamps", () => {
    const n = normalizeErrorLine(
      "2026-09-24T10:11:12.123Z at /Users/x/a.ts:12:5 addr 0x7ffee3 sha 3f9a2b1c took 42ms code 17",
    );
    expect(n).not.toMatch(/\d{2}:\d{2}/);
    expect(n).not.toContain("/Users");
    expect(n).not.toContain("0x7ffee3");
    expect(n).not.toContain("3f9a2b1c");
    expect(n).not.toMatch(/\b17\b/);
  });

  it("preserves TS error codes", () => {
    expect(normalizeErrorLine("error TS2307: x")).toContain("ts2307");
  });
});

describe("firstMeaningfulLine", () => {
  it("prefers an error-looking line over banners", () => {
    expect(
      firstMeaningfulLine(
        "bun test v1.2.3\nsrc/a.test.ts:\nerror: Cannot find module 'x'",
      ),
    ).toBe("error: Cannot find module 'x'");
  });

  it("falls back to the first non-noise line", () => {
    expect(firstMeaningfulLine("====\nsomething odd happened")).toBe(
      "something odd happened",
    );
  });

  it("returns empty string for noise only", () => {
    expect(
      firstMeaningfulLine(
        "Exit code 1\n... [10 characters truncated] ...\n---",
      ),
    ).toBe("");
  });
});
