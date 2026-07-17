// Sandbox harness tests.
//
// NOTE: filename is `*.spec-e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default test glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/
// or explicitly: bun test ./tests/e2e/harness/sandbox.spec-e2e.ts
//
// RED phase: fails until tests/e2e/harness/sandbox.ts exists.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandbox,
  assertEnvContained,
  hashTree,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./sandbox.ts";

describe("createSandbox — env isolation", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  it("uses a real temp HOME (never / or empty) inside the OS tmpdir", () => {
    sb = createSandbox();
    expect(sb.home).toContain(tmpdir());
    expect(sb.home.length).toBeGreaterThan(tmpdir().length + 1);
    expect(sb.home).not.toBe("/");
    expect(sb.home).not.toBe("");
  });

  it("sets the full isolation env map", () => {
    sb = createSandbox();
    expect(sb.env.HOME).toBe(sb.home);
    expect(sb.env.XDG_CONFIG_HOME).toBe(join(sb.home, ".config"));
    // CLAUDE_CONFIG_DIR is REQUIRED — the installer spawns real `claude` which
    // resolves its plugin registry via CLAUDE_CONFIG_DIR, not HOME.
    expect(sb.env.CLAUDE_CONFIG_DIR).toBe(join(sb.home, ".claude"));
    expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBe("1");
    // CLAUDE_PLUGIN_DATA is the ONE env that can relocate the memory DB — cleared.
    expect(sb.env.CLAUDE_PLUGIN_DATA ?? "").toBe("");
  });
});

describe("assertEnvContained — primary structural escape guarantee", () => {
  let sb: Sandbox | null = null;
  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  it("passes when HOME/XDG/CLAUDE_CONFIG_DIR all resolve inside the sandbox", () => {
    sb = createSandbox();
    expect(() => assertEnvContained(sb!.env, sb!.home)).not.toThrow();
  });

  it("throws when an env var points OUTSIDE the sandbox", () => {
    sb = createSandbox();
    const leaked = { ...sb.env, CLAUDE_CONFIG_DIR: "/Users/real/.claude" };
    expect(() => assertEnvContained(leaked, sb!.home)).toThrow();
  });

  it("throws when a required isolation var is missing", () => {
    sb = createSandbox();
    const missing = { ...sb.env };
    delete (missing as Record<string, string | undefined>).CLAUDE_CONFIG_DIR;
    expect(() => assertEnvContained(missing, sb!.home)).toThrow();
  });
});

describe("hashTree — content-hash escape backstop", () => {
  it("detects a NESTED file content change (mtime/entry-list would miss it)", () => {
    const a = mkdtempSync(join(tmpdir(), "sentinal-hashtree-"));
    try {
      mkdirSync(join(a, "nested"), { recursive: true });
      writeFileSync(join(a, "nested", "f.txt"), "original");
      const h1 = hashTree(a);
      expect(hashTree(a)).toBe(h1); // deterministic
      writeFileSync(join(a, "nested", "f.txt"), "TAMPERED");
      expect(hashTree(a)).not.toBe(h1);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });

  it("returns <absent> for a nonexistent path", () => {
    expect(hashTree(join(tmpdir(), "does-not-exist-" + Date.now()))).toBe(
      "<absent>",
    );
  });
});

describe("createSandbox — install + cleanup", () => {
  let sb: Sandbox | null = null;
  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  it(
    "install('opencode') lands opencode.json under the sandbox .config without touching real dirs",
    () => {
      const realBefore = snapshotRealDirs();
      sb = createSandbox();
      const r = sb.install("opencode");
      expect(r.exitCode).toBe(0);
      const cfg = join(sb.home, ".config", "opencode", "opencode.json");
      expect(sb.exists(cfg)).toBe(true);
      // Also proves the backstop: a real install left the real dirs untouched.
      assertNoRealEscape(realBefore);
    },
    180_000,
  );

  it("cleanup() removes the sandbox HOME", () => {
    const local = createSandbox();
    const home = local.home;
    local.cleanup();
    expect(hashTree(home)).toBe("<absent>");
  });
});
