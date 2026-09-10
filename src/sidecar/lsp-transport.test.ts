/**
 * LSP Transport Tests (Task 6, M1d + M1b plumbing)
 *
 * FrameDecoder: byte-accurate Content-Length framing. The LSP spec counts
 * BYTES; the old string-buffer implementation sliced a decoded JS string
 * (UTF-16 code units), so any multibyte content desynced the stream.
 *
 * TimedMutex: the per-instance diagnostics lock — must time out rather than
 * queue forever behind a wedged run.
 */

import { describe, it, expect } from "bun:test";
import { FrameDecoder, TimedMutex, encodeMessage } from "./lsp-transport.js";

const enc = new TextEncoder();

describe("encodeMessage", () => {
  it("declares Content-Length in BYTES, not string length", () => {
    const framed = encodeMessage({ m: "✓" }); // ✓ is 3 bytes, 1 UTF-16 unit
    const match = framed.match(/Content-Length: (\d+)/);
    expect(match).not.toBeNull();
    const json = JSON.stringify({ m: "✓" });
    expect(parseInt(match![1], 10)).toBe(Buffer.byteLength(json));
    expect(Buffer.byteLength(json)).toBeGreaterThan(json.length);
  });
});

describe("FrameDecoder", () => {
  it("parses a frame whose content contains multibyte characters", () => {
    const payload = {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { message: "héllo — ├── ✓" },
    };
    const d = new FrameDecoder();
    const msgs = d.push(enc.encode(encodeMessage(payload)));
    expect(msgs).toEqual([payload]);
  });

  it("does not desync: a frame AFTER a multibyte frame still parses", () => {
    const a = { jsonrpc: "2.0", method: "a", params: { msg: "✓✓✓ — héllo" } };
    const b = { jsonrpc: "2.0", method: "b", params: {} };
    const d = new FrameDecoder();
    // Both frames in one chunk — a byte/char-count mismatch on frame A
    // corrupts the offsets used to find frame B.
    const chunk = enc.encode(encodeMessage(a) + encodeMessage(b));
    expect(d.push(chunk)).toEqual([a, b]);
  });

  it("handles chunk boundaries anywhere, including mid-multibyte-character", () => {
    const payload = { jsonrpc: "2.0", method: "x", params: { msg: "✓é—" } };
    const bytes = enc.encode(encodeMessage(payload));
    const d = new FrameDecoder();
    const out: unknown[] = [];
    // Feed one byte at a time — every multibyte char gets split.
    for (const byte of bytes) out.push(...d.push(new Uint8Array([byte])));
    expect(out).toEqual([payload]);
  });

  it("waits for the full frame before emitting (partial content)", () => {
    const payload = { jsonrpc: "2.0", method: "x", params: { n: 1 } };
    const bytes = enc.encode(encodeMessage(payload));
    const d = new FrameDecoder();
    expect(d.push(bytes.subarray(0, bytes.length - 3))).toEqual([]);
    expect(d.push(bytes.subarray(bytes.length - 3))).toEqual([payload]);
  });

  it("skips headers without Content-Length and invalid JSON without desyncing", () => {
    const good = { jsonrpc: "2.0", method: "ok", params: {} };
    const d = new FrameDecoder();
    const garbageHeader = "X-Nothing: 1\r\n\r\n";
    const badJson = "Content-Length: 5\r\n\r\n{oops";
    const msgs = d.push(
      enc.encode(garbageHeader + badJson + encodeMessage(good)),
    );
    expect(msgs).toEqual([good]);
  });

  it("reset() drops buffered bytes", () => {
    const payload = { jsonrpc: "2.0", method: "x", params: {} };
    const bytes = enc.encode(encodeMessage(payload));
    const d = new FrameDecoder();
    d.push(bytes.subarray(0, 10));
    d.reset();
    // The remainder alone is not a valid frame start — nothing should emit,
    // and a fresh full frame afterwards parses cleanly.
    expect(d.push(enc.encode(encodeMessage(payload)))).toEqual([payload]);
  });
});

describe("TimedMutex", () => {
  it("grants an uncontended acquire immediately", async () => {
    const m = new TimedMutex();
    const release = await m.acquire(1000);
    release();
  });

  it("serializes two holders in FIFO order", async () => {
    const m = new TimedMutex();
    const order: string[] = [];
    const r1 = await m.acquire(1000);
    const second = m.acquire(1000).then((r) => {
      order.push("second");
      r();
    });
    order.push("first");
    r1();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("times out instead of queueing forever behind a wedged holder", async () => {
    const m = new TimedMutex();
    await m.acquire(1000); // never released — the wedge
    const start = Date.now();
    await expect(m.acquire(200)).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("a timed-out waiter forfeits its slot (does not wedge successors)", async () => {
    const m = new TimedMutex();
    const r1 = await m.acquire(1000);
    const loser = m.acquire(100).catch((e) => e);
    const winner = m.acquire(2000);
    await Bun.sleep(150); // let the loser time out while r1 still holds
    r1();
    const release = await winner; // must be reachable despite the dead waiter
    release();
    expect(await loser).toBeInstanceOf(Error);
  });
});
