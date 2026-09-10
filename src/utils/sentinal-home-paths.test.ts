/**
 * SENTINAL_HOME routing guard — D2 (Task 10 of
 * docs/plans/2026-09-02-audit-medium-remediation.md).
 *
 * Extends the `db-path.test.ts` seam guard to the remaining `~/.sentinal`
 * write paths: with `SENTINAL_HOME` set, every one of these resolved paths
 * lands under it; with the var unset, behaviour is byte-identical to the
 * pre-seam `os.homedir()/.sentinal` paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { getLogDir } from "./file-log.js";
import { getQueuePath, getQueueDir } from "../sidecar/observation-queue.js";
import { getLastDecayPath } from "../memory/auto-decay.js";
import { getModelsCacheDir } from "../memory/embeddings.js";
import { getDepsDir } from "../memory/native-deps.js";
import { getConfigPath } from "../memory/config.js";
import { getPidFilePath, findSentinalCmd } from "../dashboard/lifecycle.js";
import { getSentinalBinPath } from "../opencode/dashboard-ensure.js";

const REAL_SENTINAL_DIR = join(homedir(), ".sentinal");

describe("SENTINAL_HOME routing (D2 — remaining write paths)", () => {
  let savedHome: string | undefined;
  let savedDecayOverride: string | undefined;
  let scratchHome: string;

  beforeEach(() => {
    savedHome = process.env.SENTINAL_HOME;
    savedDecayOverride = process.env.SENTINAL_LAST_DECAY_PATH;
    delete process.env.SENTINAL_LAST_DECAY_PATH;
    scratchHome = mkdtempSync(join(tmpdir(), "sentinal-home-routing-"));
    process.env.SENTINAL_HOME = scratchHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    if (savedDecayOverride === undefined)
      delete process.env.SENTINAL_LAST_DECAY_PATH;
    else process.env.SENTINAL_LAST_DECAY_PATH = savedDecayOverride;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  it("file-log getLogDir() resolves to SENTINAL_HOME", () => {
    expect(getLogDir()).toBe(scratchHome);
  });

  it("observation-queue legacy spool + queue dir resolve under SENTINAL_HOME", () => {
    expect(getQueuePath()).toBe(join(scratchHome, "observation-queue.json"));
    expect(getQueueDir()).toBe(join(scratchHome, "observation-queue"));
  });

  it("auto-decay state file resolves under SENTINAL_HOME", () => {
    expect(getLastDecayPath()).toBe(join(scratchHome, "last-decay.json"));
  });

  it("auto-decay explicit override still wins over SENTINAL_HOME", () => {
    process.env.SENTINAL_LAST_DECAY_PATH = "/explicit/override.json";
    expect(getLastDecayPath()).toBe("/explicit/override.json");
  });

  it("embeddings models cache resolves under SENTINAL_HOME", () => {
    expect(getModelsCacheDir()).toBe(join(scratchHome, "models"));
  });

  it("native-deps deps dir resolves under SENTINAL_HOME", () => {
    expect(getDepsDir()).toBe(join(scratchHome, "deps"));
  });

  it("memory config path resolves under SENTINAL_HOME", () => {
    expect(getConfigPath()).toBe(join(scratchHome, "config.json"));
  });

  it("dashboard pidfile resolves under SENTINAL_HOME", () => {
    expect(getPidFilePath()).toBe(join(scratchHome, "server.pid"));
  });

  it("dashboard findSentinalCmd() looks for the binary under SENTINAL_HOME", () => {
    const binDir = join(scratchHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "sentinal");
    writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
    expect(findSentinalCmd()).toEqual([binPath]);
  });

  it("plugin dashboard-ensure binary path resolves under SENTINAL_HOME", () => {
    expect(getSentinalBinPath()).toBe(join(scratchHome, "bin", "sentinal"));
  });

  it("re-reads the env var on every call (no module-load caching)", () => {
    const other = mkdtempSync(join(tmpdir(), "sentinal-home-routing-b-"));
    try {
      expect(getLogDir()).toBe(scratchHome);
      process.env.SENTINAL_HOME = other;
      expect(getLogDir()).toBe(other);
      expect(getQueueDir()).toBe(join(other, "observation-queue"));
      expect(getConfigPath()).toBe(join(other, "config.json"));
      expect(getDepsDir()).toBe(join(other, "deps"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("unset-var behaviour is byte-identical to the pre-seam paths", () => {
    delete process.env.SENTINAL_HOME;
    expect(getLogDir()).toBe(REAL_SENTINAL_DIR);
    expect(getQueuePath()).toBe(
      join(REAL_SENTINAL_DIR, "observation-queue.json"),
    );
    expect(getQueueDir()).toBe(join(REAL_SENTINAL_DIR, "observation-queue"));
    expect(getLastDecayPath()).toBe(join(REAL_SENTINAL_DIR, "last-decay.json"));
    expect(getModelsCacheDir()).toBe(join(REAL_SENTINAL_DIR, "models"));
    expect(getDepsDir()).toBe(join(REAL_SENTINAL_DIR, "deps"));
    expect(getConfigPath()).toBe(join(REAL_SENTINAL_DIR, "config.json"));
    expect(getPidFilePath()).toBe(join(REAL_SENTINAL_DIR, "server.pid"));
    expect(getSentinalBinPath()).toBe(
      join(REAL_SENTINAL_DIR, "bin", "sentinal"),
    );
  });
});
