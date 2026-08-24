/**
 * Install Command Tests — Deep Merge + Prereq Helpers
 */

import { describe, it, expect, spyOn, afterEach, mock } from "bun:test";
import {
  deepMergeAdditive,
  checkPlaywrightCli,
  buildPluginList,
} from "./install.js";
// Imported from its own module, not via a re-export from install.js: install.ts
// is already past the 600-line block threshold, and adding lines to it purely
// for test ergonomics made the split-out that justified this module pointless.
import {
  checkChromeDevToolsMcp,
  defaultMcpConfigPaths,
} from "./install-prereqs.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ─── buildPluginList tests ───────────────────────────────────────────────────
//
// ⛔ The config.plugin entry is the ONLY load path for the binary-mode plugin.
// OpenCode's plugin loader (packages/opencode/src/config/plugin.ts) scans
// `{plugin,plugins}/*.{ts,js}` — `.mjs` is EXCLUDED from the glob, so
// plugins/sentinal.mjs is never directory-auto-loaded. v1.31.2 removed the
// config entry believing directory auto-load covered it, silently disabling
// the entire plugin (no TDD guard, no memory, no session tracking) with zero
// errors logged. These tests pin the entry's presence in BOTH modes.
// (The "double-load" that motivated the removal was normal per-instance
// plugin init — OpenCode initializes plugins once per instance: main,
// subagent, compaction.)

describe("buildPluginList", () => {
  const FILE_REF = "./plugins/sentinal.mjs";
  const NPM_REF = "@endpoint/sentinal/opencode-plugin";

  it("binary mode: appends the file entry (the ONLY load path — .mjs is not directory-auto-loaded)", () => {
    expect(buildPluginList(undefined, true, FILE_REF)).toEqual([FILE_REF]);
    expect(buildPluginList([], true, FILE_REF)).toEqual([FILE_REF]);
  });

  it("binary mode: dedupes — existing sentinal entries replaced by exactly one", () => {
    const result = buildPluginList(
      [FILE_REF, "opencode-wakatime", NPM_REF],
      true,
      FILE_REF,
    );
    expect(result).toEqual(["opencode-wakatime", FILE_REF]);
  });

  it("npm mode: appends the package reference exactly once", () => {
    const result = buildPluginList(["other-plugin"], false, NPM_REF);
    expect(result).toEqual(["other-plugin", NPM_REF]);
  });

  it("npm mode: replaces legacy sentinal entries with the package reference", () => {
    const result = buildPluginList(
      [FILE_REF, "other-plugin", NPM_REF],
      false,
      NPM_REF,
    );
    expect(result).toEqual(["other-plugin", NPM_REF]);
  });

  it("preserves non-sentinal plugin order in both modes", () => {
    expect(buildPluginList(["a", "b"], true, FILE_REF)).toEqual([
      "a",
      "b",
      FILE_REF,
    ]);
    expect(buildPluginList(["a", "b"], false, NPM_REF)).toEqual([
      "a",
      "b",
      NPM_REF,
    ]);
  });

  it("never returns undefined — the sentinal entry must always be present", () => {
    expect(buildPluginList(undefined, true, FILE_REF)).toBeDefined();
    expect(buildPluginList(undefined, false, NPM_REF)).toBeDefined();
  });
});

// ─── deepMergeAdditive tests ─────────────────────────────────────────────────

describe("deepMergeAdditive", () => {
  it("merges all keys into empty target", () => {
    const target = {};
    const source = { skill: { "*": "allow" }, edit: { "*": "ask" } };
    const result = deepMergeAdditive(target, source);
    expect(result).toEqual({ skill: { "*": "allow" }, edit: { "*": "ask" } });
  });

  it("adds missing keys without overwriting existing ones", () => {
    const target = { skill: { "*": "deny" } };
    const source = {
      skill: { "*": "allow", "spec-*": "allow" },
      edit: { "*": "ask" },
    };
    const result = deepMergeAdditive(target, source);
    // skill.* should NOT be overwritten (user set "deny"), but spec-* and edit should be added
    expect(result.skill).toEqual({ "*": "deny", "spec-*": "allow" });
    expect(result.edit).toEqual({ "*": "ask" });
  });

  it("recursively merges nested objects", () => {
    const target = {
      build: {
        permission: {
          task: { "*": "ask" },
        },
      },
    };
    const source = {
      build: {
        permission: {
          task: { "*": "ask", "plan-reviewer": "allow", explore: "allow" },
          edit: { "*": "allow" },
        },
      },
    };
    const result = deepMergeAdditive(target, source) as Record<string, unknown>;
    const buildPerm = (result.build as Record<string, unknown>)
      .permission as Record<string, unknown>;
    const task = buildPerm.task as Record<string, string>;
    expect(task["*"]).toBe("ask"); // preserved
    expect(task["plan-reviewer"]).toBe("allow"); // added
    expect(task["explore"]).toBe("allow"); // added
    expect(buildPerm.edit).toEqual({ "*": "allow" }); // added
  });

  it("does not overwrite scalar values (target wins)", () => {
    const target = { "*": "deny", explore: "deny" };
    const source = { "*": "ask", explore: "allow", general: "allow" };
    const result = deepMergeAdditive(target, source);
    expect(result["*"]).toBe("deny"); // target wins
    expect(result["explore"]).toBe("deny"); // target wins
    expect(result["general"]).toBe("allow"); // added
  });

  it("handles source with object and target with scalar gracefully", () => {
    const target = { edit: "deny" };
    const source = { edit: { "*": "ask", "docs/plans/*.md": "allow" } };
    const result = deepMergeAdditive(target, source);
    // target has scalar "deny" for edit — should NOT be overwritten with object
    expect(result.edit).toBe("deny");
  });

  it("handles target with object and source with scalar gracefully", () => {
    const target = { edit: { "*": "ask", custom: "allow" } };
    const source = { edit: "allow" };
    const result = deepMergeAdditive(target, source);
    // target has object, source has scalar — target wins
    expect(result.edit).toEqual({ "*": "ask", custom: "allow" });
  });
});

// ─── checkPlaywrightCli tests ────────────────────────────────────────────────
//
// `playwright-cli` is an OPTIONAL dependency needed for /spec UI verification.
// The helper must emit a soft info hint (not an error) and never exit the
// process. The correct npm package is `@playwright/cli` (scoped), NOT the
// deprecated bare `playwright-cli` package. The hint must reference the
// correct package.

describe("checkPlaywrightCli", () => {
  afterEach(() => {
    mock.restore();
  });

  it("prints [OK] line when playwright-cli is present and does not print the install hint", () => {
    const logged: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logged.push(msg);
    });

    // Inject a stub that reports the binary as found
    checkPlaywrightCli(() => true);

    const combined = logged.join("\n");
    expect(combined).toContain("playwright-cli");
    expect(combined).toContain("[OK]");
    expect(combined).not.toContain("npm install");
    expect(combined).not.toContain("[i]");
  });

  it("prints [i] info line AND install hint pointing at @playwright/cli when playwright-cli is missing", () => {
    const logged: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logged.push(msg);
    });

    // Inject a stub that reports the binary as missing
    checkPlaywrightCli(() => false);

    const combined = logged.join("\n");
    expect(combined).toContain("[i]");
    expect(combined).toContain("playwright-cli not found");
    expect(combined).toContain("optional");
    // Must point at the SCOPED package — bare `playwright-cli` is deprecated
    expect(combined).toContain("npm install -g @playwright/cli@latest");
  });

  it("does not call process.exit under any circumstance (soft warning only)", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error(
        "process.exit was called — checkPlaywrightCli must never exit",
      );
    }) as unknown as (code?: number | undefined) => never);

    expect(() => checkPlaywrightCli(() => false)).not.toThrow();
    expect(() => checkPlaywrightCli(() => true)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ─── checkChromeDevToolsMcp tests ────────────────────────────────────────────
//
// D11: Chrome DevTools MCP is an equally viable E2E tool when installed.
// Sentinal DETECTS it; Sentinal never installs or configures it.
//
// The predicate is deliberately TWO-part. `commandExists("chrome-devtools-mcp")`
// alone would be always-false in practice — unlike @playwright/cli, Chrome
// DevTools MCP has no global binary; it is conventionally launched via npx.
// A naive PATH check would print a hint on every single install for a tool
// nobody installs globally: noise, not signal. So:
//   1. Chrome capability gates the path at all (no Chrome -> say nothing).
//   2. MCP availability decides [OK] vs hint.

describe("checkChromeDevToolsMcp", () => {
  const capture = () => {
    const logged: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logged.push(msg);
    });
    return () => logged.join("\n");
  };

  afterEach(() => {
    mock.restore();
  });

  it("says NOTHING when no Chrome/Chromium is present (no noise for non-Chrome users)", () => {
    const out = capture();
    checkChromeDevToolsMcp({
      commandExists: () => false,
      pathExists: () => false,
      mcpConfigPaths: [],
      platform: "darwin",
    });
    expect(out()).toBe("");
  });

  it("still says nothing about Chrome DevTools MCP when the MCP binary exists but Chrome does not", () => {
    const out = capture();
    checkChromeDevToolsMcp({
      commandExists: (cmd) => cmd === "chrome-devtools-mcp",
      pathExists: () => false,
      mcpConfigPaths: [],
      platform: "linux",
    });
    expect(out()).toBe("");
  });

  it("reports [OK] when Chrome is present AND the MCP binary is on PATH", () => {
    const out = capture();
    checkChromeDevToolsMcp({
      commandExists: (cmd) =>
        cmd === "chromium" || cmd === "chrome-devtools-mcp",
      pathExists: () => false,
      mcpConfigPaths: [],
      platform: "linux",
    });
    const combined = out();
    expect(combined).toContain("[OK]");
    expect(combined).toContain("Chrome DevTools MCP");
    expect(combined).not.toContain("[i]");
  });

  it("detects Chrome via the macOS application bundle, not just $PATH", () => {
    const out = capture();
    checkChromeDevToolsMcp({
      commandExists: () => false,
      pathExists: (p) => p === "/Applications/Google Chrome.app",
      mcpConfigPaths: [],
      platform: "darwin",
    });
    const combined = out();
    // Chrome present, MCP absent -> the hint fires
    expect(combined).toContain("[i]");
    expect(combined).toContain("Chrome DevTools MCP");
  });

  it("ignores the macOS application bundle on non-darwin platforms", () => {
    const out = capture();
    checkChromeDevToolsMcp({
      commandExists: () => false,
      pathExists: () => true,
      mcpConfigPaths: [],
      platform: "linux",
    });
    expect(out()).toBe("");
  });

  it("reports [OK] when the MCP server is already named in an existing MCP config", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinal-cdmcp-"));
    const cfg = join(dir, "opencode.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        mcp: { "chrome-devtools": { command: ["npx", "chrome-devtools-mcp"] } },
      }),
    );
    try {
      const out = capture();
      checkChromeDevToolsMcp({
        commandExists: (cmd) => cmd === "chromium",
        pathExists: () => false,
        mcpConfigPaths: [cfg],
        platform: "linux",
      });
      expect(out()).toContain("[OK]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a hint (never an error) when Chrome is present but the MCP is not available", () => {
    const out = capture();
    checkChromeDevToolsMcp({
      commandExists: (cmd) => cmd === "google-chrome",
      pathExists: () => false,
      mcpConfigPaths: [],
      platform: "linux",
    });
    const combined = out();
    expect(combined).toContain("[i]");
    expect(combined).toContain("optional");
    expect(combined).toContain("chrome-devtools-mcp");
  });

  // ⛔ D11 scope guard, made testable rather than aspirational.
  it("writes the detection result to NO config file — the config is byte-identical afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinal-cdmcp-"));
    const cfg = join(dir, "opencode.json");
    const original = JSON.stringify({ mcp: { sentinal: {} } }, null, 2) + "\n";
    writeFileSync(cfg, original);
    try {
      capture();
      // Run through every branch against the same config file.
      checkChromeDevToolsMcp({
        commandExists: () => true,
        pathExists: () => true,
        mcpConfigPaths: [cfg],
        platform: "darwin",
      });
      checkChromeDevToolsMcp({
        commandExists: () => false,
        pathExists: () => false,
        mcpConfigPaths: [cfg],
        platform: "linux",
      });
      expect(readFileSync(cfg, "utf-8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing or unparseable MCP config without throwing", () => {
    capture();
    expect(() =>
      checkChromeDevToolsMcp({
        commandExists: (cmd) => cmd === "chromium",
        pathExists: () => false,
        mcpConfigPaths: ["/nonexistent/path/opencode.json"],
        platform: "linux",
      }),
    ).not.toThrow();
  });

  /**
   * ⛔ `~/.claude.json` routinely reaches TENS OF MEGABYTES for active Claude
   * Code users — it stores per-project session state. Reading it whole,
   * synchronously, during an install just to look for one 19-character marker
   * is a real cost for zero benefit: the result only decides `[OK]` versus a
   * hint. Skip anything implausibly large for a config file.
   */
  it("skips an oversized config file instead of reading it whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinal-cdmcp-"));
    const cfg = join(dir, "huge.json");
    // Marker present, but past the size ceiling -> must NOT be found.
    writeFileSync(cfg, "chrome-devtools-mcp" + "x".repeat(3 * 1024 * 1024));
    try {
      const out = capture();
      checkChromeDevToolsMcp({
        commandExists: (cmd) => cmd === "chromium",
        pathExists: () => false,
        mcpConfigPaths: [cfg],
        platform: "linux",
      });
      // Hint, not [OK] — proving the oversized file was never scanned.
      expect(out()).toContain("[i]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still scans a normal-sized config containing the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinal-cdmcp-"));
    const cfg = join(dir, "small.json");
    writeFileSync(cfg, "chrome-devtools-mcp" + "x".repeat(1024));
    try {
      const out = capture();
      checkChromeDevToolsMcp({
        commandExists: (cmd) => cmd === "chromium",
        pathExists: () => false,
        mcpConfigPaths: [cfg],
        platform: "linux",
      });
      expect(out()).toContain("[OK]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not call process.exit under any circumstance (soft warning only)", () => {
    capture();
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error(
        "process.exit was called — checkChromeDevToolsMcp must never exit",
      );
    }) as unknown as (code?: number | undefined) => never);

    expect(() =>
      checkChromeDevToolsMcp({
        commandExists: () => false,
        pathExists: () => false,
        mcpConfigPaths: [],
        platform: "darwin",
      }),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ─── defaultMcpConfigPaths ───────────────────────────────────────────────────
//
// The list IS the behaviour of the probe's config scan, so it is pinned
// directly rather than inferred from `checkChromeDevToolsMcp` output.
//
// Two historical bugs are guarded here:
//   1. The OpenCode global paths were hardcoded to `~/.config`, ignoring
//      `XDG_CONFIG_HOME` — which every other install/uninstall code path
//      honours via `resolveXdgConfig()`.
//   2. `<cwd>/opencode.json` was missing. `writeOpenCodeConfig` in `--local`
//      mode writes to the PROJECT ROOT, not `.opencode/` — so the one file a
//      local install actually produces was never scanned.

describe("defaultMcpConfigPaths", () => {
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

  const restoreXdg = () => {
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  };

  afterEach(restoreXdg);

  it("returns the full canonical list when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(defaultMcpConfigPaths()).toEqual([
      join(homedir(), ".config", "opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
      join(homedir(), ".claude.json"),
      join(homedir(), ".claude", "settings.json"),
      join(process.cwd(), "opencode.json"),
      join(process.cwd(), "opencode.jsonc"),
      join(process.cwd(), ".opencode", "opencode.json"),
      join(process.cwd(), ".mcp.json"),
    ]);
  });

  /**
   * A user who configured Chrome DevTools MCP PROJECT-LOCALLY was still told it
   * was "not configured", because only the two global OpenCode paths and
   * `~/.claude.json` were consulted.
   */
  it("consults project-local and Claude Code settings paths", () => {
    delete process.env.XDG_CONFIG_HOME;
    const paths = defaultMcpConfigPaths();
    expect(paths).toContain(join(process.cwd(), ".opencode", "opencode.json"));
    expect(paths).toContain(join(process.cwd(), ".mcp.json"));
    expect(paths).toContain(join(homedir(), ".claude", "settings.json"));
    // The pre-existing global paths must survive.
    expect(paths).toContain(
      join(homedir(), ".config", "opencode", "opencode.json"),
    );
    expect(paths).toContain(join(homedir(), ".claude.json"));
  });

  /** `--local` OpenCode installs write `opencode.json` to the project ROOT. */
  it("includes project-root opencode.json and opencode.jsonc", () => {
    const paths = defaultMcpConfigPaths();
    expect(paths).toContain(join(process.cwd(), "opencode.json"));
    expect(paths).toContain(join(process.cwd(), "opencode.jsonc"));
  });

  it("moves the OpenCode global entries when XDG_CONFIG_HOME is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinal-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = dir;
      const paths = defaultMcpConfigPaths();
      expect(paths).toContain(join(dir, "opencode", "opencode.json"));
      expect(paths).toContain(join(dir, "opencode", "opencode.jsonc"));
      // ...and no longer point at the hardcoded ~/.config fallback.
      expect(paths).not.toContain(
        join(homedir(), ".config", "opencode", "opencode.json"),
      );
      expect(paths).not.toContain(
        join(homedir(), ".config", "opencode", "opencode.jsonc"),
      );
      // Non-XDG entries are unaffected.
      expect(paths).toContain(join(homedir(), ".claude.json"));
      expect(paths).toContain(join(process.cwd(), ".mcp.json"));
    } finally {
      restoreXdg();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
