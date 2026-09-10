/**
 * Auto-decay runner tests
 *
 * The throttled startup decay: runs `decayQualityScores` only when the
 * `last-decay.json` state file is missing or older than the threshold,
 * skips when fresh, and records the run. Deterministic via injected
 * `now`, `thresholdMs`, and `stateFile`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { MemoryStore } from "./store.js";
import { runAutoDecayIfStale, getLastDecayPath } from "./auto-decay.js";

const DAY = 24 * 60 * 60 * 1000;

describe("runAutoDecayIfStale", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `auto-decay-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new MemoryStore(join(tmpDir, "test.db"));
    stateFile = join(tmpDir, "nested", "last-decay.json");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs decay when the state file is missing and records the run", () => {
    const now = Date.now();
    const result = runAutoDecayIfStale(store, {
      now,
      thresholdMs: DAY,
      stateFile,
    });
    expect(result.ran).toBe(true);
    // State file created (dir auto-made) with the run timestamp.
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(state.lastDecay).toBe(now);
  });

  it("skips decay when the state file is fresh (within threshold)", () => {
    const now = Date.now();
    mkdirSync(join(tmpDir, "nested"), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ lastDecay: now - DAY / 2 }),
      "utf-8",
    );
    const result = runAutoDecayIfStale(store, {
      now,
      thresholdMs: DAY,
      stateFile,
    });
    expect(result.ran).toBe(false);
  });

  it("runs decay when the state file is older than the threshold", () => {
    const now = Date.now();
    mkdirSync(join(tmpDir, "nested"), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ lastDecay: now - 2 * DAY }),
      "utf-8",
    );
    const result = runAutoDecayIfStale(store, {
      now,
      thresholdMs: DAY,
      stateFile,
    });
    expect(result.ran).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(state.lastDecay).toBe(now);
  });

  it("is best-effort: a corrupt state file is treated as stale (runs, does not throw)", () => {
    mkdirSync(join(tmpDir, "nested"), { recursive: true });
    writeFileSync(stateFile, "not json{{{", "utf-8");
    const result = runAutoDecayIfStale(store, {
      now: Date.now(),
      thresholdMs: DAY,
      stateFile,
    });
    expect(result.ran).toBe(true);
  });

  it("honors the SENTINAL_LAST_DECAY_PATH env override for the default path", () => {
    const override = join(tmpDir, "env-last-decay.json");
    const prev = process.env.SENTINAL_LAST_DECAY_PATH;
    process.env.SENTINAL_LAST_DECAY_PATH = override;
    try {
      expect(getLastDecayPath()).toBe(override);
    } finally {
      if (prev === undefined) delete process.env.SENTINAL_LAST_DECAY_PATH;
      else process.env.SENTINAL_LAST_DECAY_PATH = prev;
    }
  });

  it("never throws even if decay fails (returns ran:false)", () => {
    // Closing the store makes decay throw internally; runner must swallow it.
    store.close();
    const result = runAutoDecayIfStale(store, {
      now: Date.now(),
      thresholdMs: DAY,
      stateFile,
    });
    expect(result.ran).toBe(false);
    // Re-open a throwaway store so afterEach close() doesn't double-throw.
    store = new MemoryStore(join(tmpDir, "test2.db"));
  });
});
