/**
 * Readiness polling — the difference between "we started something" and "it is
 * up".
 *
 * The two asymmetric leader-exit rules carry this module:
 *
 *   - **NON-ZERO exit → fail fast.** Waiting out a 60s budget for a process
 *     that already crashed wastes the user's session and buries the real error.
 *   - **ZERO exit → keep polling.** `docker compose up -d`, `pm2 start` and
 *     every backgrounding script exit 0 by design. Treating that as failure
 *     breaks the flagship case the master plan names as the right answer.
 *
 * Getting these the wrong way round is the single most likely way for this
 * module to be quietly wrong, so both are asserted directly.
 */

import { describe, it, expect } from "bun:test";
import { awaitReadiness, type ReadinessProbeSpec } from "./readiness.js";

const spec = (over: Partial<ReadinessProbeSpec> = {}): ReadinessProbeSpec => ({
  type: "http",
  target: "http://127.0.0.1:1/health",
  // ⛔ Shrunk from the 60000/250 production defaults. `bun test`'s default
  // timeout is 5s, and a test that blows it can leave state behind that
  // cascades through the rest of the file.
  startupTimeoutMs: 500,
  pollIntervalMs: 50,
  ...over,
});

/** A probe that fails `failures` times, then succeeds. */
function httpAfter(failures: number, status = 200) {
  let n = 0;
  return async () => (n++ < failures ? null : status);
}

describe("awaitReadiness — the happy path", () => {
  it("reports ready on the first passing probe", async () => {
    const r = await awaitReadiness({
      probe: spec(),
      httpProbe: async () => 200,
    });
    expect(r.ready).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.reason).toBeUndefined();
  });

  it("keeps polling until the target comes up", async () => {
    const r = await awaitReadiness({
      probe: spec(),
      httpProbe: httpAfter(3),
    });
    expect(r.ready).toBe(true);
    expect(r.attempts).toBe(4);
  });

  it("accepts any 2xx-3xx by default", async () => {
    for (const status of [200, 204, 301, 302, 399]) {
      const r = await awaitReadiness({
        probe: spec(),
        httpProbe: async () => status,
      });
      expect(r.ready).toBe(true);
    }
  });

  it("rejects 4xx/5xx by default — a booting app often answers 503", async () => {
    const r = await awaitReadiness({
      probe: spec(),
      httpProbe: async () => 503,
    });
    expect(r.ready).toBe(false);
  });

  it("honours an explicit expectStatus list", async () => {
    const r = await awaitReadiness({
      probe: spec({ expectStatus: [503] }),
      httpProbe: async () => 503,
    });
    expect(r.ready).toBe(true);
  });

  it("treats an exec probe's exit 0 as ready and anything else as not", async () => {
    const okRun = await awaitReadiness({
      probe: spec({ type: "exec", target: "nc -z localhost 3000" }),
      execProbe: async () => 0,
    });
    expect(okRun.ready).toBe(true);

    const badRun = await awaitReadiness({
      probe: spec({ type: "exec", target: "nc -z localhost 3000" }),
      execProbe: async () => 1,
    });
    expect(badRun.ready).toBe(false);
  });
});

describe("awaitReadiness — leader exit asymmetry", () => {
  it("FAILS FAST on a non-zero leader exit, well under the budget", async () => {
    const started = Date.now();
    const r = await awaitReadiness({
      probe: spec({ startupTimeoutMs: 5000 }),
      httpProbe: async () => null,
      leaderExitCode: () => 3,
    });

    expect(r.ready).toBe(false);
    expect(r.leaderExitCode).toBe(3);
    expect(r.reason).toContain("3");
    // The point of "fast": nowhere near the 5s budget.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("KEEPS POLLING after a ZERO leader exit — the detaching-starter case", async () => {
    // `docker compose up -d` exits 0 by design; the stack comes up afterwards.
    const r = await awaitReadiness({
      probe: spec(),
      httpProbe: httpAfter(3),
      leaderExitCode: () => 0,
    });

    expect(r.ready).toBe(true);
    expect(r.detachingStarter).toBe(true);
    expect(r.attempts).toBe(4);
  });

  it("still times out (rather than hanging) when a zero-exit leader never comes up", async () => {
    const r = await awaitReadiness({
      probe: spec(),
      httpProbe: async () => null,
      leaderExitCode: () => 0,
    });
    expect(r.ready).toBe(false);
    expect(r.detachingStarter).toBe(true);
    expect(r.reason).toContain("timed out");
  });

  it("runs a FINAL probe after the leader dies — it may have been an exec-and-exit starter", async () => {
    // Mirrors waitForDashboardHealthy (src/dashboard/lifecycle.ts:283-296):
    // the child can exit non-zero *because* the service was already up.
    let calls = 0;
    const r = await awaitReadiness({
      probe: spec({ startupTimeoutMs: 5000 }),
      httpProbe: async () => (++calls === 1 ? null : 200),
      leaderExitCode: () => 1,
    });

    expect(r.ready).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("awaitReadiness — timeout", () => {
  it("gives up at the budget and says so", async () => {
    const started = Date.now();
    const r = await awaitReadiness({
      probe: spec({ startupTimeoutMs: 300, pollIntervalMs: 50 }),
      httpProbe: async () => null,
    });

    expect(r.ready).toBe(false);
    expect(r.reason).toContain("timed out");
    expect(r.reason).toContain("300");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("probes at least once even with an absurdly small budget", async () => {
    const r = await awaitReadiness({
      probe: spec({ startupTimeoutMs: 1, pollIntervalMs: 1 }),
      httpProbe: async () => 200,
    });
    expect(r.ready).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it("survives a probe that throws instead of returning", async () => {
    const r = await awaitReadiness({
      probe: spec({ startupTimeoutMs: 200 }),
      httpProbe: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("timed out");
  });
});
