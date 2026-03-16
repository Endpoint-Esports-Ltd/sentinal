/**
 * Uninstall Command Tests
 *
 * Tests the detection helper and preserveBinary flag behavior.
 * Uses tmpdir-based paths to avoid touching real installations.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { makeTmpDir } from "../../test-helpers.js";
import { detectInstalledTargets, cleanupOpenCodeConfig } from "./uninstall.js";

describe("detectInstalledTargets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect no installations when dirs are empty", () => {
    const result = detectInstalledTargets({
      marketplaceDir: join(tmpDir, "no-such-dir"),
      xdgConfig: tmpDir,
    });
    expect(result.claude).toBe(false);
    expect(result.opencode).toBe(false);
  });

  it("should detect Claude Code when marketplace dir exists", () => {
    const marketplaceDir = join(tmpDir, "marketplace");
    mkdirSync(marketplaceDir, { recursive: true });

    const result = detectInstalledTargets({
      marketplaceDir,
      xdgConfig: tmpDir,
    });
    expect(result.claude).toBe(true);
    expect(result.opencode).toBe(false);
  });

  it("should detect OpenCode when plugin file exists", () => {
    const pluginsDir = join(tmpDir, "opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "sentinal.mjs"), "// plugin", "utf-8");

    const result = detectInstalledTargets({
      marketplaceDir: join(tmpDir, "no-such-dir"),
      xdgConfig: tmpDir,
    });
    expect(result.claude).toBe(false);
    expect(result.opencode).toBe(true);
  });

  it("should detect OpenCode when agent files exist", () => {
    const agentsDir = join(tmpDir, "opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "plan-reviewer.md"), "# Agent", "utf-8");

    const result = detectInstalledTargets({
      marketplaceDir: join(tmpDir, "no-such-dir"),
      xdgConfig: tmpDir,
    });
    expect(result.opencode).toBe(true);
  });

  it("should detect OpenCode when skill dirs exist", () => {
    const skillDir = join(tmpDir, "opencode", "skills", "spec-plan");
    mkdirSync(skillDir, { recursive: true });

    const result = detectInstalledTargets({
      marketplaceDir: join(tmpDir, "no-such-dir"),
      xdgConfig: tmpDir,
    });
    expect(result.opencode).toBe(true);
  });

  it("should detect both when both artifact types exist", () => {
    const marketplaceDir = join(tmpDir, "marketplace");
    mkdirSync(marketplaceDir, { recursive: true });

    const pluginsDir = join(tmpDir, "opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "sentinal.mjs"), "// plugin", "utf-8");

    const result = detectInstalledTargets({
      marketplaceDir,
      xdgConfig: tmpDir,
    });
    expect(result.claude).toBe(true);
    expect(result.opencode).toBe(true);
  });

  it("should detect OpenCode via .ts plugin variant", () => {
    const pluginsDir = join(tmpDir, "opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "sentinal.ts"), "// plugin", "utf-8");

    const result = detectInstalledTargets({
      marketplaceDir: join(tmpDir, "no-such-dir"),
      xdgConfig: tmpDir,
    });
    expect(result.opencode).toBe(true);
  });
});

// ─── cleanupOpenCodeConfig tests ────────────────────────────────────────────

describe("cleanupOpenCodeConfig", () => {
  it("removes sentinal permission keys (skill, plan edit globs)", () => {
    const config: Record<string, unknown> = {
      permission: {
        skill: { "*": "allow", "spec-*": "allow" },
        edit: {
          "*": "ask",
          "docs/plans/*.md": "allow",
          "docs/plans/**/*.md": "allow",
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.permission).toBeUndefined();
  });

  it("preserves user-added permission keys", () => {
    const config: Record<string, unknown> = {
      permission: {
        skill: { "*": "allow" },
        edit: {
          "*": "ask",
          "docs/plans/*.md": "allow",
          "src/custom/**": "allow",
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.permission).toBeDefined();
    const perm = result.permission as Record<string, unknown>;
    expect(perm.skill).toBeUndefined();
    expect(perm.edit).toEqual({ "*": "ask", "src/custom/**": "allow" });
  });

  it("removes sentinal agent task keys including explore and general", () => {
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
            edit: { "*": "allow" },
          },
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.agent).toBeUndefined();
  });

  it("preserves user-added agent task keys", () => {
    const config: Record<string, unknown> = {
      agent: {
        build: {
          permission: {
            task: {
              "*": "ask",
              "plan-reviewer": "allow",
              "custom-agent": "allow",
            },
          },
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    const build = (result.agent as Record<string, Record<string, unknown>>)
      ?.build;
    const task = (build?.permission as Record<string, unknown>)?.task as Record<
      string,
      string
    >;
    expect(task["plan-reviewer"]).toBeUndefined();
    expect(task["custom-agent"]).toBe("allow");
    expect(task["*"]).toBe("ask");
  });

  it("cleans up docs/plans/*.json edit entries", () => {
    const config: Record<string, unknown> = {
      agent: {
        plan: {
          permission: {
            task: { "*": "ask", "plan-reviewer": "allow" },
            edit: {
              "*": "ask",
              "docs/plans/*.md": "allow",
              "docs/plans/**/*.md": "allow",
              "docs/plans/*.json": "allow",
            },
          },
        },
      },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.agent).toBeUndefined();
  });

  it("removes sentinal MCP keys", () => {
    const config: Record<string, unknown> = {
      mcp: { context7: {}, "web-search": {}, sentinal: {}, "custom-mcp": {} },
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.mcp).toEqual({ "custom-mcp": {} });
  });

  it("removes sentinal plugin entries from plugin array", () => {
    const config: Record<string, unknown> = {
      plugin: ["./plugins/sentinal.mjs", "custom-plugin"],
    };
    const result = cleanupOpenCodeConfig(config);
    expect(result.plugin).toEqual(["custom-plugin"]);
  });
});

describe("cleanupOpenCodeConfig — roundtrip with deepMergeAdditive", () => {
  it("install then uninstall leaves only user keys", async () => {
    const { deepMergeAdditive } = await import("./install.js");

    const userConfig: Record<string, unknown> = {
      plugin: ["custom-plugin"],
      mcp: { "custom-mcp": { type: "local" } },
      permission: { edit: { "*": "ask", "src/**": "allow" } },
      agent: {
        build: {
          permission: { task: { "*": "ask", "custom-agent": "allow" } },
        },
      },
    };

    const sentinalPermission = {
      skill: { "*": "allow", "spec-*": "allow" },
      edit: {
        "*": "ask",
        "docs/plans/*.md": "allow",
        "docs/plans/**/*.md": "allow",
      },
    };
    const sentinalAgent = {
      build: {
        permission: {
          task: {
            "*": "ask",
            "plan-reviewer": "allow",
            "spec-reviewer": "allow",
            explore: "allow",
            general: "allow",
          },
          edit: { "*": "allow" },
        },
      },
      plan: {
        permission: {
          task: {
            "*": "ask",
            "plan-reviewer": "allow",
            "spec-reviewer": "allow",
            explore: "allow",
            general: "allow",
          },
          edit: {
            "*": "ask",
            "docs/plans/*.md": "allow",
            "docs/plans/**/*.md": "allow",
          },
        },
      },
    };

    const afterInstall: Record<string, unknown> = {
      ...userConfig,
      plugin: [...(userConfig.plugin as string[]), "./plugins/sentinal.mjs"],
      permission: deepMergeAdditive(
        userConfig.permission as Record<string, unknown>,
        sentinalPermission,
      ),
      agent: deepMergeAdditive(
        userConfig.agent as Record<string, unknown>,
        sentinalAgent,
      ),
    };

    const afterUninstall = cleanupOpenCodeConfig(afterInstall);

    expect(afterUninstall.plugin).toEqual(["custom-plugin"]);
    expect(
      (afterUninstall.permission as Record<string, unknown>)?.edit,
    ).toEqual({ "*": "ask", "src/**": "allow" });
    const buildTask = (
      (afterUninstall.agent as Record<string, Record<string, unknown>>)?.build
        ?.permission as Record<string, unknown>
    )?.task as Record<string, string>;
    expect(buildTask?.["custom-agent"]).toBe("allow");
    expect(buildTask?.["plan-reviewer"]).toBeUndefined();
    expect(
      (afterUninstall.agent as Record<string, unknown>)?.plan,
    ).toBeUndefined();
  });
});
