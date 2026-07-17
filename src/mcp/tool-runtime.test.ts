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
    await expect(
      emitProgress(extra, { progress: 1 }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when extra is undefined", async () => {
    await expect(emitProgress(undefined, { progress: 1 })).resolves.toBeUndefined();
  });
});
