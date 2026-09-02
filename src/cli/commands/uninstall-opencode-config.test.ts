/**
 * Tests for uninstall-opencode-config.ts — M7b value-matching cleanup,
 * M7d lsp-aware emptiness, M7c backup + never-start-fresh on the uninstall
 * write path, and the Truth 11 end-to-end config cycle.
 *
 * All filesystem tests use tmp-dir fixtures — never a real config.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupOpenCodeConfig,
  cleanupOpenCodeConfigFile,
  isConfigEffectivelyEmpty,
} from "./uninstall-opencode-config.js";
import { writeOpenCodeConfig } from "./install-opencode-config.js";
import {
  MCP_SERVERS_OPENCODE,
  OPENCODE_LSP_DEFAULT,
} from "./install-constants.js";

// Deep-clone helper so fixtures can't share references with shipped constants.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ─── M7b: value-matching MCP cleanup ────────────────────────────────────────

describe("cleanupOpenCodeConfig — value-matching mcp cleanup (M7b)", () => {
  it("removes managed mcp keys whose value deep-equals the shipped default", () => {
    const config: Record<string, unknown> = {
      mcp: {
        context7: clone(MCP_SERVERS_OPENCODE.context7),
        "web-search": clone(MCP_SERVERS_OPENCODE["web-search"]),
        "custom-mcp": { type: "local", command: ["my-tool"] },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.mcp).toEqual({
      "custom-mcp": { type: "local", command: ["my-tool"] },
    });
  });

  it("preserves a user-pinned context7 value (not deep-equal to default)", () => {
    const pinned = {
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp@1.2.3"],
    };
    const config: Record<string, unknown> = {
      mcp: { context7: clone(pinned) },
    };
    const notes: string[] = [];
    const result = cleanupOpenCodeConfig(config, notes);
    expect((result.mcp as Record<string, unknown>).context7).toEqual(pinned);
    expect(notes.some((n) => n.includes("context7"))).toBe(true);
  });

  it("preserves an enabled:false user edit on a managed server", () => {
    const disabled = {
      ...clone(MCP_SERVERS_OPENCODE["web-fetch"]),
      enabled: false,
    };
    const config: Record<string, unknown> = {
      mcp: { "web-fetch": clone(disabled) },
    };
    const result = cleanupOpenCodeConfig(config);
    expect((result.mcp as Record<string, unknown>)["web-fetch"]).toEqual(
      disabled,
    );
  });

  it("deep-equality is key-order-insensitive", () => {
    // Same value as the shipped web-search default, keys reordered.
    const reordered = {
      command: ["npx", "-y", "open-websearch"],
      environment: {
        ALLOWED_SEARCH_ENGINES: "duckduckgo,bing,exa",
        MODE: "stdio",
        DEFAULT_SEARCH_ENGINE: "duckduckgo",
      },
      type: "local",
    };
    const config: Record<string, unknown> = {
      mcp: { "web-search": reordered },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.mcp).toBeUndefined();
  });

  it("always removes the sentinal entry regardless of value (force-managed)", () => {
    const config: Record<string, unknown> = {
      mcp: {
        sentinal: {
          type: "local",
          command: ["/Users/someone/.sentinal/bin/sentinal", "mcp-server"],
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.mcp).toBeUndefined();
  });

  it("does not crash on a non-object mcp value", () => {
    const config: Record<string, unknown> = { mcp: "broken" };
    const result = cleanupOpenCodeConfig(config);
    expect(result.mcp).toBe("broken");
  });

  it("does not crash on a string plugin value", () => {
    const config: Record<string, unknown> = { plugin: "not-an-array" };
    const result = cleanupOpenCodeConfig(config);
    expect(result.plugin).toBe("not-an-array");
  });
});

// ─── Plugin cleanup scoping (spec-review should_fix) ────────────────────────
//
// cleanupPlugins must never delete user-authored entries: removal is limited
// to (a) exact PLUGIN_PATH_PATTERNS, (b) a basename match on the shipped
// plugin file (sentinal.mjs/ts/js), and (c) the @endpoint/sentinal package.
// Anything sentinal-ISH but unrecognised is preserved with a note.

describe("cleanupOpenCodeConfig — scoped plugin removal", () => {
  it("a user plugin path containing 'sentinal' as a substring survives uninstall", () => {
    const config: Record<string, unknown> = {
      plugin: ["./plugins/my-sentinal-extras.ts"],
    };
    const notes: string[] = [];
    const result = cleanupOpenCodeConfig(config, notes);
    expect(result.plugin).toEqual(["./plugins/my-sentinal-extras.ts"]);
    expect(notes.some((n) => n.includes("my-sentinal-extras"))).toBe(true);
  });

  it("a third-party sentinal-companion package survives uninstall, with a note", () => {
    const config: Record<string, unknown> = {
      plugin: ["sentinal-companion"],
    };
    const notes: string[] = [];
    const result = cleanupOpenCodeConfig(config, notes);
    expect(result.plugin).toEqual(["sentinal-companion"]);
    expect(notes.some((n) => n.includes("sentinal-companion"))).toBe(true);
  });

  it("a scoped package that merely extends the name survives uninstall", () => {
    const config: Record<string, unknown> = {
      plugin: ["@endpoint/sentinal-extras"],
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.plugin).toEqual(["@endpoint/sentinal-extras"]);
  });

  it("removes exact patterns, absolute shipped-plugin paths, and the package", () => {
    const config: Record<string, unknown> = {
      plugin: [
        "./plugins/sentinal.mjs",
        "./plugins/sentinal.ts",
        "/Users/u/.config/opencode/plugins/sentinal.mjs",
        "@endpoint/sentinal/opencode-plugin",
        "@endpoint/sentinal",
        "./plugins/user-plugin.ts",
      ],
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.plugin).toEqual(["./plugins/user-plugin.ts"]);
  });

  it("removes the plugin key entirely when only sentinal entries remain", () => {
    const config: Record<string, unknown> = {
      plugin: ["./plugins/sentinal.mjs", "@endpoint/sentinal/opencode-plugin"],
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.plugin).toBeUndefined();
  });
});

// ─── M7b: value-matching permission cleanup ─────────────────────────────────

describe("cleanupOpenCodeConfig — value-matching permission cleanup (M7b)", () => {
  it("removes permission.skill only when it deep-equals the shipped default", () => {
    const config: Record<string, unknown> = {
      permission: { skill: { "*": "allow", "spec-*": "allow" } },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.permission).toBeUndefined();
  });

  it("preserves a customised permission.skill opt-out, with a note", () => {
    const config: Record<string, unknown> = {
      permission: { skill: { "*": "deny" } },
    };
    const notes: string[] = [];
    const result = cleanupOpenCodeConfig(config, notes);
    const perm = result.permission as Record<string, unknown>;
    expect(perm.skill).toEqual({ "*": "deny" });
    expect(notes.some((n) => n.includes("skill"))).toBe(true);
  });

  it("removes docs/plans edit keys only at the shipped 'allow' value", () => {
    const config: Record<string, unknown> = {
      permission: {
        edit: {
          "*": "ask",
          "docs/plans/*.md": "deny", // user hardened this
          "docs/plans/**/*.md": "allow",
          "docs/plans/*.json": "allow",
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    const edit = (result.permission as Record<string, unknown>).edit as Record<
      string,
      string
    >;
    expect(edit["docs/plans/*.md"]).toBe("deny");
    expect(edit["docs/plans/**/*.md"]).toBeUndefined();
    expect(edit["docs/plans/*.json"]).toBeUndefined();
  });

  it("preserves user globs that merely mention docs/plans", () => {
    const config: Record<string, unknown> = {
      permission: {
        edit: { "*": "ask", "docs/plans/notes/*.txt": "allow" },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    const edit = (result.permission as Record<string, unknown>).edit as Record<
      string,
      string
    >;
    expect(edit["docs/plans/notes/*.txt"]).toBe("allow");
  });
});

// ─── M7b: agent task permissions — explore/general never touched ────────────

describe("cleanupOpenCodeConfig — agent permissions (M7b)", () => {
  it("NEVER removes explore/general task permissions, even at default values", () => {
    const config: Record<string, unknown> = {
      agent: {
        build: {
          permission: {
            task: {
              "*": "ask",
              "plan-reviewer": "allow",
              "spec-reviewer": "allow",
              explore: "allow",
              general: "allow",
            },
          },
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    const task = (
      (result.agent as Record<string, Record<string, unknown>>).build
        .permission as Record<string, unknown>
    ).task as Record<string, string>;
    expect(task.explore).toBe("allow");
    expect(task.general).toBe("allow");
    expect(task["plan-reviewer"]).toBeUndefined();
    expect(task["spec-reviewer"]).toBeUndefined();
  });

  it("preserves a customised plan-reviewer value", () => {
    const config: Record<string, unknown> = {
      agent: {
        build: { permission: { task: { "plan-reviewer": "deny" } } },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    const task = (
      (result.agent as Record<string, Record<string, unknown>>).build
        .permission as Record<string, unknown>
    ).task as Record<string, string>;
    expect(task["plan-reviewer"]).toBe("deny");
  });

  it("leaves agents Sentinal never shipped entirely untouched", () => {
    const config: Record<string, unknown> = {
      agent: {
        "my-custom-agent": {
          permission: { task: { "plan-reviewer": "allow" } },
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    const task = (
      (result.agent as Record<string, Record<string, unknown>>)[
        "my-custom-agent"
      ].permission as Record<string, unknown>
    ).task as Record<string, string>;
    expect(task["plan-reviewer"]).toBe("allow");
  });
});

// ─── M7d: lsp-aware emptiness ───────────────────────────────────────────────

describe("isConfigEffectivelyEmpty — lsp-aware (M7d)", () => {
  it("treats the shipped default lsp block as empty", () => {
    expect(
      isConfigEffectivelyEmpty({
        $schema: "https://opencode.ai/config.json",
        lsp: clone(OPENCODE_LSP_DEFAULT),
      }),
    ).toBe(true);
  });

  it("treats a customised lsp block as content — config must NOT be deleted", () => {
    expect(
      isConfigEffectivelyEmpty({
        $schema: "https://opencode.ai/config.json",
        lsp: { gopls: { command: ["gopls"] } },
      }),
    ).toBe(false);
  });

  it("still reports non-lsp keys as content", () => {
    expect(isConfigEffectivelyEmpty({ theme: "dark" })).toBe(false);
    expect(isConfigEffectivelyEmpty({ $schema: "x" })).toBe(true);
  });
});

// ─── M7c: file orchestration — backup + never-start-fresh ───────────────────

describe("cleanupOpenCodeConfigFile — backup + skip-unparseable (M7c)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinal-uninstall-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = () => join(dir, "opencode.json");

  it("writes a .bak of the pre-write content before modifying", () => {
    const original =
      JSON.stringify(
        {
          mcp: { sentinal: clone(MCP_SERVERS_OPENCODE.sentinal) },
          theme: "dark",
        },
        null,
        2,
      ) + "\n";
    writeFileSync(configPath(), original);

    const result = cleanupOpenCodeConfigFile(dir);
    expect(result.status).toBe("cleaned");
    expect(readFileSync(`${configPath()}.bak`, "utf-8")).toBe(original);
    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(after.mcp).toBeUndefined();
    expect(after.theme).toBe("dark");
  });

  it("backs up before deleting a Sentinal-only config", () => {
    const original =
      JSON.stringify({ mcp: clone(MCP_SERVERS_OPENCODE) }, null, 2) + "\n";
    writeFileSync(configPath(), original);

    const result = cleanupOpenCodeConfigFile(dir);
    expect(result.status).toBe("removed");
    expect(existsSync(configPath())).toBe(false);
    expect(readFileSync(`${configPath()}.bak`, "utf-8")).toBe(original);
  });

  it("unparseable config: skipped, byte-unchanged, no .bak written", () => {
    const truncated = '{ "mcp": { "sentinal": ';
    writeFileSync(configPath(), truncated);

    const result = cleanupOpenCodeConfigFile(dir);
    expect(result.status).toBe("skipped-unparseable");
    expect(readFileSync(configPath(), "utf-8")).toBe(truncated);
    expect(existsSync(`${configPath()}.bak`)).toBe(false);
  });

  it("reports not-found when no config exists", () => {
    expect(cleanupOpenCodeConfigFile(dir).status).toBe("not-found");
  });
});

// ─── Truth 11: full update cycle preserves user customisations ──────────────

describe("Truth 11 — update cycle (cleanup + re-merge) preserves user config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinal-config-cycle-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a permission.skill opt-out AND a pinned mcp value survive the cycle", () => {
    const pinnedContext7 = {
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp@1.2.3"],
    };
    const userConfig = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["./plugins/sentinal.mjs"],
      permission: {
        skill: { "*": "deny" }, // user opt-out
      },
      mcp: {
        ...clone(MCP_SERVERS_OPENCODE),
        context7: clone(pinnedContext7), // user pin
      },
    };
    const configPath = join(dir, "opencode.json");
    writeFileSync(configPath, JSON.stringify(userConfig, null, 2) + "\n");

    // Cycle step 1: uninstall cleanup (as `sentinal update` runs it)
    const cleanup = cleanupOpenCodeConfigFile(dir);
    expect(cleanup.status).toBe("cleaned"); // customised entries → file survives

    // Cycle step 2: reinstall merge
    writeOpenCodeConfig({
      configDir: dir,
      binary: false,
      pluginPath: "./plugins/sentinal.mjs",
      mcpServers: clone(MCP_SERVERS_OPENCODE),
    });

    const final = JSON.parse(readFileSync(configPath, "utf-8"));
    // The opt-out survives: "*" stays deny (spec-* may be re-added additively)
    expect(final.permission.skill["*"]).toBe("deny");
    // The pin survives byte-for-byte
    expect(final.mcp.context7).toEqual(pinnedContext7);
    // The other managed servers are back
    expect(final.mcp["web-search"]).toEqual(MCP_SERVERS_OPENCODE["web-search"]);
    expect(final.mcp.sentinal).toEqual(MCP_SERVERS_OPENCODE.sentinal);
  });
});
