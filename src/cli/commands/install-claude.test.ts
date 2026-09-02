/**
 * configureStatusline tests — H7: a corrupt or JSONC settings file must NEVER
 * be replaced with `{statusLine}`.
 *
 * Before the fix, a settings.json that failed to parse was silently reset to
 * `{}` ("start fresh") and rewritten with ONLY the statusLine key — destroying
 * the user's permissions, env, hooks, and model config, with no backup.
 *
 * All tests use a tmp-dir settings path injected via the `settingsPath` param
 * (same seam as `isStatuslineActive`). ⛔ Never touch the real ~/.claude.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureStatusline } from "./install-claude.js";

let dir: string;
let settingsPath: string;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinal-install-claude-"));
  settingsPath = join(dir, "settings.json");
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const bakPath = () => `${settingsPath}.bak`;

describe("configureStatusline — unparseable settings (H7)", () => {
  it("truncated JSON: file byte-unchanged, warning emitted, no .bak, install continues", () => {
    const corrupt = '{\n  "permissions": {\n    "allow": ["Bash(git:*)"';
    writeFileSync(settingsPath, corrupt);

    const result = configureStatusline(settingsPath);

    expect(result.status).toBe("skipped-unparseable");
    // The file must be BYTE-identical — never rewritten on the failure path.
    expect(readFileSync(settingsPath, "utf-8")).toBe(corrupt);
    expect(existsSync(bakPath())).toBe(false);
    // Warning names the file so the user can act on it.
    const errOutput = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(errOutput).toContain(settingsPath);
  });

  it("JSONC-style content (comments): same skip — writing back would strip comments", () => {
    const jsonc = `{
  // my hand-tuned permissions
  "permissions": { "allow": ["Bash(git:*)"] },
  "env": { "FOO": "bar" }
}
`;
    writeFileSync(settingsPath, jsonc);

    const result = configureStatusline(settingsPath);

    expect(result.status).toBe("skipped-unparseable");
    expect(readFileSync(settingsPath, "utf-8")).toBe(jsonc);
    expect(existsSync(bakPath())).toBe(false);
  });
});

describe("configureStatusline — valid settings", () => {
  it("adds statusLine, preserves every other key, and writes a .bak of the pre-write content", () => {
    const original = JSON.stringify(
      {
        permissions: { allow: ["Bash(git:*)"], deny: ["WebSearch"] },
        env: { NODE_OPTIONS: "--max-old-space-size=8192" },
        hooks: { PreToolUse: [{ matcher: "Write", command: "check" }] },
        model: "opus",
      },
      null,
      2,
    );
    writeFileSync(settingsPath, original);

    const result = configureStatusline(settingsPath);

    expect(result.status).toBe("configured");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions).toEqual({
      allow: ["Bash(git:*)"],
      deny: ["WebSearch"],
    });
    expect(after.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=8192" });
    expect(after.hooks).toEqual({
      PreToolUse: [{ matcher: "Write", command: "check" }],
    });
    expect(after.model).toBe("opus");
    expect(after.statusLine.type).toBe("command");
    expect(after.statusLine.command).toContain("statusline");
    // Backup matches the exact pre-write bytes.
    expect(readFileSync(bakPath(), "utf-8")).toBe(original);
  });

  it(".bak is latest-wins: a second run overwrites it with the newer pre-write content", () => {
    const first = JSON.stringify({ env: { A: "1" } }, null, 2);
    writeFileSync(settingsPath, first);
    configureStatusline(settingsPath);

    const beforeSecond = readFileSync(settingsPath, "utf-8");
    const result = configureStatusline(settingsPath);

    expect(result.status).toBe("configured");
    expect(readFileSync(bakPath(), "utf-8")).toBe(beforeSecond);
  });

  it("skips (no write, no .bak) when another statusline plugin is active", () => {
    const original = JSON.stringify(
      { statusLine: { type: "command", command: "other-tool statusline" } },
      null,
      2,
    );
    writeFileSync(settingsPath, original);

    const result = configureStatusline(settingsPath);

    expect(result.status).toBe("skipped-active");
    expect(readFileSync(settingsPath, "utf-8")).toBe(original);
    expect(existsSync(bakPath())).toBe(false);
  });
});

describe("configureStatusline — missing settings file", () => {
  it("creates the file with statusLine only (pre-existing behaviour, pinned); no .bak", () => {
    expect(existsSync(settingsPath)).toBe(false);

    const result = configureStatusline(settingsPath);

    expect(result.status).toBe("configured");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(Object.keys(after)).toEqual(["statusLine"]);
    expect(after.statusLine.type).toBe("command");
    expect(after.statusLine.command).toContain("statusline");
    expect(existsSync(bakPath())).toBe(false);
  });
});
