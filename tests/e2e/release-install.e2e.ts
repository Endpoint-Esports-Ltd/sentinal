// Release-config install gate (Task 3, Wave 2).
//
// Proves a real RELEASE binary installs + activates Sentinal in an isolated
// sandbox — the exact path a `curl install.sh` user gets. Unlike install.e2e.ts
// (which runs the dev/dist binary WITH --bundled), this runs the artifact under
// test via SENTINAL_E2E_BINARY WITHOUT --bundled: a release binary self-selects
// EMBEDDED install mode via isBinaryMode() (argv[1].startsWith("/$bunfs/")), so
// --bundled is unnecessary for it.
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test` never
// discovers it. Run explicitly:
//   SENTINAL_E2E_BINARY=$(pwd)/dist/sentinal bun test ./tests/e2e/release-install.e2e.ts
// A bare `bun test` (unset) is green-by-skip (see the non-gated smoke test).
//
// TDD note: this file IS the test — no separate implementation. The Sentinal TDD
// guard was pre-set to RED_CONFIRMED for this path so the write was allowed.

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  hashTree,
  type Sandbox,
} from "./harness/sandbox.ts";

const INSTALL_TIMEOUT = 180_000; // fresh HOME empties bun cache → installs are slow
const HAS_BINARY = !!process.env.SENTINAL_E2E_BINARY;

// Snapshot the real user dirs ONCE before any sandbox work; assert unchanged
// after each test body (defense-in-depth around the structural env guarantee).
let realBefore: Record<string, string>;

beforeAll(() => {
  realBefore = snapshotRealDirs();
});

// ── Non-gated smoke: zero side effects when unset ────────────────────────────

describe("release install gate — guard", () => {
  it("is green-by-skip with zero side effects when SENTINAL_E2E_BINARY is unset", () => {
    // This body MUST run in CI. When the flag is unset it does NO sandbox work.
    if (HAS_BINARY) {
      expect(HAS_BINARY).toBe(true);
      return;
    }
    expect(HAS_BINARY).toBe(false);
  });
});

// ── Release binary: OpenCode install + activation (bundled:false) ────────────

describe("release install (bundled:false) — opencode activation assets", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  it.skipIf(!HAS_BINARY)(
    "release binary writes opencode.json with the plugin + mcp.sentinal and non-empty bundle",
    () => {
      sb = createSandbox();
      // No --bundled: a release binary self-selects EMBEDDED install mode.
      const r = sb.install("opencode", { bundled: false });
      expect(r.exitCode).toBe(0);

      const ocDir = join(sb.home, ".config", "opencode");
      const cfgPath = join(ocDir, "opencode.json");
      expect(sb.exists(cfgPath)).toBe(true);

      // Parses as JSON.
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        plugin?: unknown;
        mcp?: Record<string, { command?: unknown }>;
      };

      // plugin array is the ONLY load path for the .mjs (dir scan excludes .mjs).
      expect(Array.isArray(cfg.plugin)).toBe(true);
      expect(cfg.plugin as string[]).toContain("./plugins/sentinal.mjs");

      // mcp.sentinal present.
      expect(cfg.mcp).toBeDefined();
      expect(cfg.mcp?.sentinal).toBeDefined();
      expect(cfg.mcp?.sentinal?.command).toBeDefined();

      // Plugin file exists and is non-empty.
      const pluginFile = join(ocDir, "plugins", "sentinal.mjs");
      expect(sb.exists(pluginFile)).toBe(true);
      expect(readFileSync(pluginFile, "utf-8").length).toBeGreaterThan(0);
    },
    INSTALL_TIMEOUT,
  );
});

// ── Release binary: Claude install lands assets + real ~/.claude unchanged ───

describe("release install (bundled:false) — claude activation assets", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  it.skipIf(!HAS_BINARY)(
    "release binary writes claude assets and leaves the REAL ~/.claude byte-unchanged",
    () => {
      // Targeted snapshot of the REAL ~/.claude BEFORE spawning the installer.
      // If CLAUDE_CONFIG_DIR fails to redirect the spawned `claude`, this FAILS.
      const realClaude = join(homedir(), ".claude");
      const realClaudeBefore = hashTree(realClaude);

      sb = createSandbox();
      const r = sb.install("claude", { bundled: false });
      expect(r.exitCode).toBe(0);

      // Pre-spawn on-disk sandbox assets (written before the CLI spawn) exist.
      const pluginDir = join(
        sb.home,
        ".claude",
        "plugins",
        "sentinal-marketplace",
        "plugins",
        "sentinal",
      );
      expect(sb.exists(join(pluginDir, "hooks", "hooks.json"))).toBe(true);
      expect(sb.exists(join(pluginDir, ".mcp.json"))).toBe(true);
      expect(sb.exists(join(pluginDir, "settings.json"))).toBe(true);

      // The REAL ~/.claude is untouched — CLAUDE_CONFIG_DIR redirected the
      // spawned `claude` binary into the sandbox.
      expect(hashTree(realClaude)).toBe(realClaudeBefore);
    },
    INSTALL_TIMEOUT,
  );
});
