// Install + Activation E2E (Layer A, deterministic, CI-safe).
//
// Proves `sentinal install opencode` and `install claude` land the correct
// activation assets in an isolated sandbox and that they parse/point correctly,
// while the REAL ~/.claude / ~/.config/opencode / ~/.sentinal stay byte-unchanged.
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default glob `**/*.test.ts`) never discovers it. Run explicitly:
//   bun test ./tests/e2e/install.e2e.ts
// A bare `bun test` will NOT run it (intended — proves default-suite exclusion).
//
// TDD note: this file IS the test — there is no separate implementation. The
// Sentinal TDD guard was pre-set to RED_CONFIRMED for this path so the write
// was allowed.
//
// ── claude spawn-safety SPIKE observation (recorded 2026-07-17) ──
// Running `install claude --bundled` in the sandbox (env CLAUDE_CONFIG_DIR=
// <home>/.claude) was observed to:
//   - exit 0 (success),
//   - NOT require auth (marketplace add + plugin install ran without a login),
//   - NOT touch the real ~/.claude/plugins (byte-identical before/after).
// So CLAUDE_CONFIG_DIR DOES redirect the spawned real `claude` binary's plugin
// registry into the sandbox. The pre-spawn on-disk assets (hooks.json / .mcp.json
// / settings.json) are written under
// <home>/.claude/plugins/sentinal-marketplace/plugins/sentinal/ before the CLI
// spawn, so we assert both those assets AND real-dir immutability below.

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

// Snapshot the real user dirs ONCE before any sandbox work; assert unchanged
// after each test body (defense-in-depth around the structural env guarantee).
let realBefore: Record<string, string>;

beforeAll(() => {
  realBefore = snapshotRealDirs();
});

// ── OpenCode bundled install + activation ───────────────────────────────────

describe("install opencode (bundled) — activation assets", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  it(
    "writes opencode.json with the plugin + mcp.sentinal load path and populated asset dirs",
    () => {
      sb = createSandbox();
      const r = sb.install("opencode");
      expect(r.exitCode).toBe(0);

      const ocDir = join(sb.home, ".config", "opencode");
      const cfgPath = join(ocDir, "opencode.json");
      expect(sb.exists(cfgPath)).toBe(true);

      // Parses as JSON.
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        plugin?: unknown;
        mcp?: Record<string, { command?: unknown }>;
      };

      // plugin array is the ONLY load path for the bundled .mjs (dir scan
      // excludes .mjs — see install.ts buildPluginList doc).
      expect(Array.isArray(cfg.plugin)).toBe(true);
      expect(cfg.plugin as string[]).toContain("./plugins/sentinal.mjs");

      // mcp.sentinal.command present (spawns `sentinal mcp-server`).
      expect(cfg.mcp).toBeDefined();
      expect(cfg.mcp?.sentinal).toBeDefined();
      expect(cfg.mcp?.sentinal?.command).toBeDefined();

      // Bundled plugin file exists and is non-empty.
      const pluginFile = join(ocDir, "plugins", "sentinal.mjs");
      expect(sb.exists(pluginFile)).toBe(true);
      expect(readFileSync(pluginFile, "utf-8").length).toBeGreaterThan(0);

      // rules/ and commands/ dirs populated.
      const rulesDir = join(ocDir, "rules");
      const commandsDir = join(ocDir, "commands");
      expect(sb.exists(rulesDir)).toBe(true);
      expect(sb.exists(commandsDir)).toBe(true);
      expect(readdirSync(rulesDir).length).toBeGreaterThan(0);
      expect(readdirSync(commandsDir).length).toBeGreaterThan(0);
    },
    INSTALL_TIMEOUT,
  );
});

// ── Claude spawn-safety spike (asserted in-test) ────────────────────────────

describe("install claude (bundled) — spawn safety spike", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  it(
    "writes sandbox assets and leaves the REAL ~/.claude byte-unchanged",
    () => {
      // Targeted snapshot of the REAL ~/.claude BEFORE spawning the installer,
      // in addition to the whole-tree snapshot taken in beforeAll. If the real
      // registry IS touched (CLAUDE_CONFIG_DIR failed to redirect the spawned
      // `claude`), this test FAILS loudly.
      const realClaude = join(homedir(), ".claude");
      const realClaudeBefore = hashTree(realClaude);

      sb = createSandbox();
      const r = sb.install("claude");

      // Observed: install claude --bundled exits 0 and does NOT need auth.
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

// ── Network-freeness guard ──────────────────────────────────────────────────

describe("install opencode (bundled) — network-freeness", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  // NOTE ON SCOPE (spec-review should_fix): no-egress for the bundled install
  // is enforced by DESIGN (--bundled writes embedded assets from disk +
  // SENTINAL_NO_AUTO_SETUP=1 skips the model download), NOT by the proxy env —
  // proxy vars do not reliably intercept Bun's native fetch/socket, so a
  // "still exits 0 with proxy set" result alone would be green-by-accident.
  // This test therefore proves the DISK-ONLY signal directly: with an
  // unreachable proxy set (best-effort egress block), the install both exits 0
  // AND writes the embedded plugin bundle to disk (non-empty) — i.e. the
  // activation asset came from the local bundle, not a network fetch.
  it(
    "bundled install writes assets from disk (no network dependency) with proxy blocked",
    () => {
      sb = createSandbox();
      sb.env.HTTPS_PROXY = "http://127.0.0.1:1";
      sb.env.HTTP_PROXY = "http://127.0.0.1:1";
      sb.env.ALL_PROXY = "http://127.0.0.1:1";

      const r = sb.install("opencode");
      expect(r.exitCode).toBe(0);

      // Config + the EMBEDDED plugin bundle landed from disk (non-empty proves
      // it was written from the bundled asset, not fetched).
      const cfgPath = join(sb.home, ".config", "opencode", "opencode.json");
      expect(sb.exists(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        plugin?: unknown;
      };
      expect(cfg.plugin as string[]).toContain("./plugins/sentinal.mjs");
      const pluginPath = join(
        sb.home,
        ".config",
        "opencode",
        "plugins",
        "sentinal.mjs",
      );
      expect(sb.exists(pluginPath)).toBe(true);
      expect(statSync(pluginPath).size).toBeGreaterThan(1000);
    },
    INSTALL_TIMEOUT,
  );
});
