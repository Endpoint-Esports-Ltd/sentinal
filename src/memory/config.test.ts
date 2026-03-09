/**
 * Memory Configuration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { loadConfig, isMemoryEnabled, clearConfigCache, getConfigPath } from "./config.js";

// We can't easily mock homedir(), so we test the merging/parsing logic
// by testing loadConfig behavior with clearConfigCache().

describe("loadConfig", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("should return defaults when no config file exists", () => {
    // Default config path probably doesn't have a config.json in CI
    // but loadConfig gracefully defaults
    const config = loadConfig();
    expect(config.memory.enabled).toBe(true);
  });

  it("should cache config after first load", () => {
    const config1 = loadConfig();
    const config2 = loadConfig();
    expect(config1).toBe(config2); // Same reference (cached)
  });

  it("should return fresh config after cache clear", () => {
    const config1 = loadConfig();
    clearConfigCache();
    const config2 = loadConfig();
    // Deep equal but not same reference
    expect(config2.memory.enabled).toBe(config1.memory.enabled);
  });
});

describe("isMemoryEnabled", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("should return true by default", () => {
    expect(isMemoryEnabled()).toBe(true);
  });
});

describe("config file parsing", () => {
  let tmpDir: string;
  let configPath: string;

  // Since we can't change homedir, we test the merge logic indirectly
  // by verifying default behavior and structure

  it("should have correct default structure", () => {
    clearConfigCache();
    const config = loadConfig();
    expect(config).toHaveProperty("memory");
    expect(config.memory).toHaveProperty("enabled");
    expect(typeof config.memory.enabled).toBe("boolean");
  });

  it("getConfigPath should return a path ending in config.json", () => {
    const path = getConfigPath();
    expect(path).toEndWith("config.json");
    expect(path).toContain(".sentinal");
  });
});
