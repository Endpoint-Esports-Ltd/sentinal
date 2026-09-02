/**
 * MCP tool runtime helpers — abort + progress.
 *
 * RED phase: fails until src/mcp/tool-runtime.ts exists.
 */

import { describe, it, expect } from "bun:test";
import { withAbort, emitProgress, type ProgressExtra } from "./tool-runtime.js";

describe("withAbort", () => {
  it("resolves with the promise result when not aborted", async () => {
    const ctl = new AbortController();
    const result = await withAbort(ctl.signal, Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const slow = new Promise<string>((r) => setTimeout(() => r("late"), 1000));
    await expect(withAbort(ctl.signal, slow)).rejects.toThrow(/abort/i);
  });

  it("rejects promptly when aborted mid-flight (does not wait for the promise)", async () => {
    const ctl = new AbortController();
    const slow = new Promise<string>((r) => setTimeout(() => r("late"), 5000));
    const started = Date.now();
    const p = withAbort(ctl.signal, slow);
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow(/abort/i);
    // Must reject well before the 5s promise settles
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("passes through when signal is undefined", async () => {
    const result = await withAbort(undefined, Promise.resolve(42));
    expect(result).toBe(42);
  });

  /**
   * M9c: the pre-aborted early return must not orphan the (eagerly created)
   * underlying promise. Tool handlers build `promise` before calling
   * `withAbort`; when the signal is already aborted, the early rejection
   * returns without attaching any handler to `promise` — if that promise later
   * rejects, it becomes an unhandled rejection, which is process-fatal.
   */
  it("does not produce an unhandled rejection when pre-aborted around a later-rejecting promise", async () => {
    const captured: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      captured.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const ctl = new AbortController();
      ctl.abort();

      let rejectLater!: (err: Error) => void;
      const doomed = new Promise<never>((_, rej) => {
        rejectLater = rej;
      });

      await expect(withAbort(ctl.signal, doomed)).rejects.toThrow(/abort/i);

      // The underlying promise now fails after withAbort already returned.
      rejectLater(new Error("late failure after abort"));

      // Give the runtime a macrotask turn to surface any unhandled rejection.
      await new Promise((r) => setTimeout(r, 20));

      expect(
        captured,
        "pre-aborted withAbort orphaned the underlying promise — its late rejection went unhandled",
      ).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("emitProgress", () => {
  function makeExtra(progressToken?: string | number): {
    extra: ProgressExtra;
    sent: unknown[];
  } {
    const sent: unknown[] = [];
    const extra: ProgressExtra = {
      _meta: progressToken !== undefined ? { progressToken } : undefined,
      sendNotification: async (n: unknown) => {
        sent.push(n);
      },
    };
    return { extra, sent };
  }

  it("sends a notifications/progress message when a progressToken is present", async () => {
    const { extra, sent } = makeExtra("tok-1");
    await emitProgress(extra, { progress: 1, total: 3, message: "step 1" });
    expect(sent).toHaveLength(1);
    const n = sent[0] as {
      method: string;
      params: { progressToken: unknown; progress: number; total?: number };
    };
    expect(n.method).toBe("notifications/progress");
    expect(n.params.progressToken).toBe("tok-1");
    expect(n.params.progress).toBe(1);
    expect(n.params.total).toBe(3);
  });

  it("is a no-op when no progressToken is present", async () => {
    const { extra, sent } = makeExtra(undefined);
    await emitProgress(extra, { progress: 1 });
    expect(sent).toHaveLength(0);
  });

  it("never throws even if sendNotification rejects", async () => {
    const extra: ProgressExtra = {
      _meta: { progressToken: "t" },
      sendNotification: async () => {
        throw new Error("transport closed");
      },
    };
    // Must swallow — progress is best-effort
    await expect(emitProgress(extra, { progress: 1 })).resolves.toBeUndefined();
  });

  it("is a no-op when extra is undefined", async () => {
    await expect(
      emitProgress(undefined, { progress: 1 }),
    ).resolves.toBeUndefined();
  });
});
