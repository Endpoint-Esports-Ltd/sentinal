/**
 * Process start-time verification — the H5 tiebreaker behind every `owned`
 * verdict.
 *
 * The scenario under test: a recycled leader PID lands on a process whose cwd
 * IS the worktree (in wave execution the agent session, editor and shell all
 * qualify), so command-line/cwd ownership proof passes for a process Sentinal
 * never started. The recorded `startedAt` is the only fact that can tell the
 * impostor apart — and an unverifiable start time must FAIL CLOSED.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  realStartTimeOf,
  verifyStartTime,
  START_TIME_TOLERANCE_MS,
} from "./proc-start.js";

const spawned: { kill(): void }[] = [];

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill();
    } catch {
      /* gone */
    }
  }
});

function spawnSleeper(): number {
  const proc = Bun.spawn(["sleep", "30"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  spawned.push(proc);
  return proc.pid;
}

describe("realStartTimeOf", () => {
  it("derives an epoch start close to now for a freshly spawned process", () => {
    const before = Date.now();
    const pid = spawnSleeper();
    const observed = realStartTimeOf(pid);
    expect(observed).not.toBeNull();
    // `etimes` is whole seconds (truncated), so the derived start can only
    // overstate the true start — never claim the process is older than it is
    // by more than the tolerance.
    expect(Math.abs(observed! - before)).toBeLessThanOrEqual(
      START_TIME_TOLERANCE_MS,
    );
  }, 15_000);

  it("parses every POSIX `etime` shape: mm:ss, hh:mm:ss and dd-hh:mm:ss", () => {
    // ⚠️ macOS `ps` has NO `etimes` keyword (procps-only), so the portable
    // form is `etime`'s `[[dd-]hh:]mm:ss` duration — numeric and
    // locale-independent, unlike `lstart`.
    const cases: Array<[string, number]> = [
      [" 00:03\n", 3],
      ["01:23", 83],
      ["1:02:03", 3723],
      ["2-03:04:05", 2 * 86_400 + 3 * 3600 + 4 * 60 + 5],
    ];
    for (const [stdout, seconds] of cases) {
      const before = Date.now();
      const observed = realStartTimeOf(1234, () => ({ exitCode: 0, stdout }));
      expect(observed).not.toBeNull();
      expect(Math.abs(observed! - (before - seconds * 1000))).toBeLessThan(
        1000,
      );
    }
  });

  it("returns null when `ps` exits non-zero", () => {
    const observed = realStartTimeOf(1234, () => ({
      exitCode: 1,
      stdout: "",
    }));
    expect(observed).toBeNull();
  });

  it("returns null for unparsable `ps` output rather than guessing", () => {
    for (const garbage of [
      "",
      "  ",
      "not-a-number",
      "12 34",
      "123",
      "1:2:3:4",
    ]) {
      const observed = realStartTimeOf(1234, () => ({
        exitCode: 0,
        stdout: garbage,
      }));
      expect(observed).toBeNull();
    }
  });

  it("returns null when the runner itself fails", () => {
    expect(realStartTimeOf(1234, () => null)).toBeNull();
  });
});

describe("verifyStartTime", () => {
  it("matches a live process against its true start time (real `ps`)", () => {
    const pid = spawnSleeper();
    const v = verifyStartTime(pid, Date.now());
    expect(v.kind).toBe("match");
  }, 15_000);

  it("⛔ flags a live process whose start time is far from the record (real `ps`)", () => {
    // The forged-record shape of PID reuse: the pid is alive, but it started
    // NOW while the record claims a minute ago. 60s is 12x the tolerance.
    const pid = spawnSleeper();
    const v = verifyStartTime(pid, Date.now() - 60_000);
    expect(v.kind).toBe("mismatch");
    if (v.kind === "mismatch") {
      expect(v.reason).toContain(String(pid));
      expect(v.reason.toUpperCase()).toContain("RECYCLED");
    }
  }, 15_000);

  it("tolerates drift within ±tolerance and flags drift beyond it", () => {
    const now = Date.now();
    const within = verifyStartTime(4242, now - START_TIME_TOLERANCE_MS + 500, {
      startTimeOf: () => now,
    });
    expect(within.kind).toBe("match");

    const beyond = verifyStartTime(4242, now - START_TIME_TOLERANCE_MS - 1500, {
      startTimeOf: () => now,
    });
    expect(beyond.kind).toBe("mismatch");
  });

  it("⛔ reports unknown — never match — when the probe answers null", () => {
    const v = verifyStartTime(4242, Date.now(), { startTimeOf: () => null });
    expect(v.kind).toBe("unknown");
    if (v.kind === "unknown") expect(v.reason).toContain("4242");
  });

  it("⛔ reports unknown — never match — when the probe throws", () => {
    const v = verifyStartTime(4242, Date.now(), {
      startTimeOf: () => {
        throw new Error("ps: command not found");
      },
    });
    expect(v.kind).toBe("unknown");
  });

  it("treats a zero/invalid recorded startedAt as legacy — no comparison", () => {
    // Pidfiles written before this check existed must keep today's behaviour:
    // a running stack must not be orphaned (or refused) by an upgrade.
    const explode = () => {
      throw new Error("the probe must not run for a legacy record");
    };
    expect(verifyStartTime(4242, 0, { startTimeOf: explode }).kind).toBe(
      "legacy",
    );
    expect(verifyStartTime(4242, NaN, { startTimeOf: explode }).kind).toBe(
      "legacy",
    );
  });
});
