/**
 * The exclusive `runtime_up` claim (M4c).
 *
 * preflight → spawn → writePidfile was not exclusive: two concurrent
 * `runtime_up` calls could both pass preflight, both spawn, and the LAST
 * writer owned the pidfile — the loser's detached group was left with no
 * ownership record at all, the exact orphan D5 exists to prevent.
 *
 * The fix is `writeFileSync(path, data, { flag: "wx" })`: the pidfile itself
 * is the claim, taken BEFORE spawn, so at most one caller can proceed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimPidfile,
  claimEntry,
  resolveExistingClaim,
} from "./pidfile-claim.js";
import { readPidfile, writePidfile, runtimePidfilePath } from "./pidfile.js";

let wt: string;

beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-claim-")));
});

afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
});

// ─── claimPidfile ───────────────────────────────────────────────────────────

describe("claimPidfile", () => {
  it("claims an unclaimed worktree with a schema-valid `claiming` record", () => {
    const r = claimPidfile(wt, claimEntry("npm run dev"));
    expect(r.kind).toBe("claimed");
    const entry = readPidfile(wt);
    expect(entry).not.toBeNull();
    expect(entry!.state).toBe("claiming");
    expect(entry!.pid).toBe(process.pid);
    expect(entry!.pgid).toBeNull();
    expect(entry!.command).toBe("npm run dev");
  });

  it("⛔ exactly ONE of two claims wins — the second sees `held`", () => {
    const first = claimPidfile(wt, claimEntry("npm run dev"));
    const second = claimPidfile(wt, claimEntry("npm run dev"));
    expect(first.kind).toBe("claimed");
    expect(second.kind).toBe("held");
    // The loser did NOT overwrite the winner's record.
    expect(readPidfile(wt)!.pid).toBe(process.pid);
  });

  it("is `held` when ANY pidfile already exists — a running stack is a claim too", () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "x",
      state: "ready",
    });
    const r = claimPidfile(wt, claimEntry("npm run dev"));
    expect(r.kind).toBe("held");
    expect(readPidfile(wt)!.pid).toBe(999);
  });
});

// ─── resolveExistingClaim ───────────────────────────────────────────────────

describe("resolveExistingClaim", () => {
  it("is `none` when there is no pidfile at all", () => {
    expect(resolveExistingClaim(wt).kind).toBe("none");
  });

  it("is `none` for a real runtime record — those belong to the preflight matrix", () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "x",
      state: "starting",
    });
    expect(resolveExistingClaim(wt).kind).toBe("none");
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("⛔ is `held` while the claiming process is still ALIVE", () => {
    claimPidfile(wt, claimEntry("npm run dev"));
    const v = resolveExistingClaim(wt, { isAlive: () => true });
    expect(v.kind).toBe("held");
    if (v.kind === "held") expect(v.reason).toContain(String(process.pid));
    // The claim survives — releasing a live claim IS the race.
    expect(readPidfile(wt)!.state).toBe("claiming");
  });

  it("releases a STALE claim whose claimer died before spawning", () => {
    claimPidfile(wt, claimEntry("npm run dev"));
    const v = resolveExistingClaim(wt, { isAlive: () => false });
    expect(v.kind).toBe("released");
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);
  });

  it("⛔ fails closed: an unknowable claimer liveness reads as `held`", () => {
    claimPidfile(wt, claimEntry("npm run dev"));
    const v = resolveExistingClaim(wt, {
      isAlive: () => {
        throw new Error("kill(2) unavailable");
      },
    });
    expect(v.kind).toBe("held");
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });
});
