// Sandbox harness tests.
//
// NOTE: filename is `*.spec-e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default test glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/
// or explicitly: bun test ./tests/e2e/harness/sandbox.spec-e2e.ts
//
// RED phase: fails until tests/e2e/harness/sandbox.ts exists.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// ── Task 1: binary override + config knobs (release-gate) ────────────────────

describe("createSandbox — SENTINAL_E2E_BINARY override", () => {
  let sb: Sandbox | null = null;
  const savedEnv = process.env.SENTINAL_E2E_BINARY;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    if (savedEnv === undefined) delete process.env.SENTINAL_E2E_BINARY;
    else process.env.SENTINAL_E2E_BINARY = savedEnv;
  });

  it("uses the caller-supplied binary path and exposes it as binaryPath", () => {
    // A fake executable file stands in for a release binary.
    const fake = join(mkdtempSync(join(tmpdir(), "e2e-bin-")), "sentinal-fake");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    process.env.SENTINAL_E2E_BINARY = fake;
    sb = createSandbox();
    expect(sb.binaryPath).toBe(resolve(fake));
  });

  it("THROWS when SENTINAL_E2E_BINARY is set but the file does not exist (no silent dev fallback)", () => {
    process.env.SENTINAL_E2E_BINARY = join(tmpdir(), "does-not-exist-" + Date.now());
    expect(() => createSandbox()).toThrow(/SENTINAL_E2E_BINARY/);
  });

  it("falls back to the default entry when SENTINAL_E2E_BINARY is unset", () => {
    delete process.env.SENTINAL_E2E_BINARY;
    sb = createSandbox();
    // binaryPath is the dev dist/sentinal or the bun-src fallback — NOT thrown.
    expect(sb.binaryPath.length).toBeGreaterThan(0);
  });
});

describe("createSandbox — autoSetup + install bundled knobs", () => {
  let sb: Sandbox | null = null;
  const savedNoAuto = process.env.SENTINAL_NO_AUTO_SETUP;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    if (savedNoAuto === undefined) delete process.env.SENTINAL_NO_AUTO_SETUP;
    else process.env.SENTINAL_NO_AUTO_SETUP = savedNoAuto;
  });

  it("default sandbox sets SENTINAL_NO_AUTO_SETUP=1 (backward-compatible)", () => {
    sb = createSandbox();
    expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBe("1");
  });

  it("autoSetup:true DELETES SENTINAL_NO_AUTO_SETUP even when inherited from process.env", () => {
    // Set it in the parent env — the spread must NOT let it bleed through.
    process.env.SENTINAL_NO_AUTO_SETUP = "1";
    sb = createSandbox({ autoSetup: true });
    expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBeUndefined();
  });
});
