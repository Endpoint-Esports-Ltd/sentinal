/**
 * Uninstall Command Tests
 *
 * Tests the detection helper and preserveBinary flag behavior.
 * Uses tmpdir-based paths to avoid touching real installations.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { detectInstalledTargets } from "./uninstall.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-uninstall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
