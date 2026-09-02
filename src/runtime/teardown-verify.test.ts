/**
 * Post-`down` re-verification (M4a) and post-SIGKILL liveness confirmation
 * (M4b) — the two checks that close teardown's TOCTOU windows.
 *
 * The ownership verdict used to be captured BEFORE the declared `down` ran;
 * `down` is bounded only by `graceMs`, which is long enough for the leader to
 * die and its PID to be recycled — after which the stale verdict authorised a
 * `kill -- -pgid` against a stranger's group.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reverifyAfterDown,
  confirmGroupDead,
  safeAlive,
} from "./teardown-verify.js";
import { writePidfile, type RuntimePidfile } from "./pidfile.js";

let wt: string;

beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-td-verify-")));
});

afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
});

function record(over: Partial<RuntimePidfile> = {}): RuntimePidfile {
  return {
    pid: 999_100,
    pgid: 999_100,
    startedAt: Date.now(),
    command: "npm run dev",
    state: "ready",
    ...over,
  };
}

// ─── reverifyAfterDown ──────────────────────────────────────────────────────

describe("reverifyAfterDown", () => {
  it("proceeds with a verified leader when the verdict is still `owned`", () => {
    const entry = record();
    writePidfile(wt, entry);
    const v = reverifyAfterDown(wt, entry, {
      isAlive: () => true,
      commandOf: () => `node server.js ${wt}`,
      startTimeOf: () => Date.now(),
    });
    expect(v.kind).toBe("proceed");
    if (v.kind === "proceed") expect(v.leaderVerified).toBe(true);
  });

  it("⛔ REFUSES when the verdict flips to `foreign` during `down`", () => {
    // The TOCTOU shape: the leader died while `down` ran and the PID was
    // recycled onto an unrelated process. The pre-`down` verdict said `owned`;
    // the world no longer agrees.
    const entry = record();
    writePidfile(wt, entry);
    const v = reverifyAfterDown(wt, entry, {
      isAlive: () => true,
      commandOf: () => "/usr/sbin/cupsd -l",
      cwdOf: () => "/",
    });
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.reason.toLowerCase()).toContain("down");
      expect(v.reason.toLowerCase()).toContain("refus");
    }
  });

  it("⛔ REFUSES when the record became unreadable during `down`", () => {
    const entry = record();
    writePidfile(wt, entry);
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(wt, ".sentinal", "runtime.pid"), "{ not json");
    const v = reverifyAfterDown(wt, entry, {});
    expect(v.kind).toBe("refuse");
  });

  it("⛔ REFUSES when the record disappeared during `down`", () => {
    // Nothing left to verify against — signalling on the stale in-memory
    // verdict would be exactly the TOCTOU this module closes.
    const entry = record();
    const v = reverifyAfterDown(wt, entry, { isAlive: () => true });
    expect(v.kind).toBe("refuse");
  });

  it("⛔ REFUSES when a DIFFERENT pid now owns the record", () => {
    const entry = record();
    writePidfile(wt, record({ pid: 123_456, pgid: 123_456 }));
    const v = reverifyAfterDown(wt, entry, {
      isAlive: () => true,
      commandOf: () => `node server.js ${wt}`,
      startTimeOf: () => Date.now(),
    });
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") expect(v.reason).toContain("123456");
  });

  it("proceeds UNVERIFIED when the leader died during `down` (group gate decides)", () => {
    // `down` doing its job looks exactly like this: the leader is gone. That
    // must NOT refuse — it must fall through to `maySignalGroup`, which either
    // finds the group gone (success) or requires a verified member.
    const entry = record();
    writePidfile(wt, entry);
    const v = reverifyAfterDown(wt, entry, { isAlive: () => false });
    expect(v.kind).toBe("proceed");
    if (v.kind === "proceed") expect(v.leaderVerified).toBe(false);
  });
});

// ─── confirmGroupDead ───────────────────────────────────────────────────────

describe("confirmGroupDead", () => {
  it("is true immediately when nothing is alive", async () => {
    let sleeps = 0;
    const dead = await confirmGroupDead({
      alive: () => false,
      leaderPid: 999_100,
      witness: null,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(dead).toBe(true);
    expect(sleeps).toBe(0);
  });

  it("is false when the leader survives every re-probe", async () => {
    const dead = await confirmGroupDead({
      alive: () => true,
      leaderPid: 999_100,
      witness: null,
      sleep: async () => {},
    });
    expect(dead).toBe(false);
  });

  it("is false when the WITNESS member survives even though the leader is gone", async () => {
    const dead = await confirmGroupDead({
      alive: (pid) => pid === 999_101,
      leaderPid: 999_100,
      witness: 999_101,
      sleep: async () => {},
    });
    expect(dead).toBe(false);
  });

  it("waits out a reaping lag: true once the group dies mid-poll", async () => {
    let polls = 0;
    const dead = await confirmGroupDead({
      alive: () => {
        polls++;
        return polls < 3;
      },
      leaderPid: 999_100,
      witness: null,
      sleep: async () => {},
    });
    expect(dead).toBe(true);
  });

  it("treats an UNKNOWABLE liveness as alive — never as dead", async () => {
    const dead = await confirmGroupDead({
      alive: () => {
        throw new Error("ps unavailable");
      },
      leaderPid: 999_100,
      witness: null,
      sleep: async () => {},
    });
    expect(dead).toBe(false);
  });
});

// ─── safeAlive ──────────────────────────────────────────────────────────────

describe("safeAlive", () => {
  it("falls back to the witness when the leader is dead", () => {
    expect(safeAlive((pid) => pid === 2, 1, 2)).toBe(true);
    expect(safeAlive(() => false, 1, 2)).toBe(false);
    expect(safeAlive(() => false, 1, null)).toBe(false);
  });

  it("reads a throwing probe as ALIVE — unknowable must not skip escalation", () => {
    expect(
      safeAlive(
        () => {
          throw new Error("no ps");
        },
        1,
        null,
      ),
    ).toBe(true);
  });
});
