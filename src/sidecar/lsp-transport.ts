/**
 * LSP Transport Plumbing
 *
 * Split from lsp-client.ts (Task 6 of
 * docs/plans/2026-09-02-audit-medium-remediation.md): message encoding,
 * byte-accurate Content-Length frame decoding (M1d), server-binary
 * resolution, the timed diagnostics mutex (M1b), and project file scanning.
 *
 * The client (lsp-client.ts) owns the protocol/session logic; this module
 * owns everything below it.
 */

import { join } from "node:path";
import { readdirSync } from "node:fs";

// ─── Message encoding ────────────────────────────────────────────────────

let nextRequestId = 1;

export function encodeMessage(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

export function makeRequest(
  method: string,
  params?: unknown,
): { id: number; msg: string } {
  const id = nextRequestId++;
  const msg = encodeMessage({ jsonrpc: "2.0", id, method, params });
  return { id, msg };
}

export function makeNotification(method: string, params?: unknown): string {
  return encodeMessage({ jsonrpc: "2.0", method, params });
}

// ─── Frame decoding (M1d: BYTES, not UTF-16 code units) ──────────────────

/**
 * Byte-accurate LSP frame decoder.
 *
 * The LSP spec's `Content-Length` counts BYTES. The previous implementation
 * decoded chunks into a JS string and sliced by `.length` (UTF-16 code
 * units), so any multibyte content desynced the stream permanently. This
 * decoder buffers raw bytes and only decodes a message once the buffered
 * byte count satisfies the declared length.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  /** Append a chunk; return every complete message it unlocked. */
  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: unknown[] = [];
    for (;;) {
      const headerEnd = findHeaderEnd(this.buf);
      if (headerEnd === -1) break;

      // Headers are ASCII per spec — safe to decode in isolation.
      const header = new TextDecoder().decode(this.buf.subarray(0, headerEnd));
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const contentStart = headerEnd + 4;
      if (this.buf.length < contentStart + contentLength) break;

      const content = new TextDecoder().decode(
        this.buf.subarray(contentStart, contentStart + contentLength),
      );
      this.buf = this.buf.slice(contentStart + contentLength);

      try {
        out.push(JSON.parse(content));
      } catch {
        /* invalid JSON, skip the frame — framing stays intact */
      }
    }
    return out;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

/** Index of `\r\n\r\n` in raw bytes, or -1. */
function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

// ─── Timed mutex (M1b) ───────────────────────────────────────────────────

/**
 * FIFO mutex whose acquire REJECTS after a timeout instead of queueing
 * forever — a wedged diagnostics run must degrade the caller to the
 * subprocess-tsc fallback, never wedge the whole quality pipeline (the H8
 * lesson, applied to the LSP path).
 */
export class TimedMutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Resolve with a release function once the lock is held; reject if it
   * cannot be obtained within `timeoutMs`. A timed-out waiter forfeits its
   * queue slot immediately so later waiters are not blocked behind it.
   */
  acquire(timeoutMs: number): Promise<() => void> {
    const prev = this.tail;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    this.tail = prev.then(() => held);

    return new Promise((resolveAcquire, rejectAcquire) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        release(); // forfeit our slot — successors must not wait on a dead waiter
        rejectAcquire(
          new Error(`LSP diagnostics mutex acquire timed out (${timeoutMs}ms)`),
        );
      }, timeoutMs);
      if (timer.unref) timer.unref();

      prev.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveAcquire(release);
      });
    });
  }
}

// ─── Server binary resolution ────────────────────────────────────────────

/**
 * Resolve the typescript-language-server binary path.
 * Tries direct path first, then npx, then bunx.
 */
function resolveTsServerCommand(): string[] | null {
  // Try direct
  try {
    const r = Bun.spawnSync(["typescript-language-server", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode === 0) return ["typescript-language-server", "--stdio"];
  } catch {
    /* not in PATH */
  }

  // Try via npx (Node.js projects)
  try {
    const r = Bun.spawnSync(
      ["npx", "--yes", "typescript-language-server", "--version"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode === 0)
      return ["npx", "--yes", "typescript-language-server", "--stdio"];
  } catch {
    /* no npx */
  }

  // Try via bunx
  try {
    const r = Bun.spawnSync(
      ["bunx", "typescript-language-server", "--version"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode === 0)
      return ["bunx", "typescript-language-server", "--stdio"];
  } catch {
    /* no bunx */
  }

  return null;
}

let cachedCommand: string[] | null | undefined;

/**
 * Check if typescript-language-server is available.
 */
export function isLspAvailable(): boolean {
  if (cachedCommand === undefined) cachedCommand = resolveTsServerCommand();
  return cachedCommand !== null;
}

export function getTsServerCommand(): string[] {
  if (cachedCommand === undefined) cachedCommand = resolveTsServerCommand();
  if (!cachedCommand)
    throw new Error("typescript-language-server not available");
  return cachedCommand;
}

// ─── Project file scanning ───────────────────────────────────────────────

/** Find up to `limit` non-test .ts files, scanning at most one level deep. */
export function findTsFiles(dir: string, limit: number): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) break;
      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".spec.ts")
      ) {
        files.push(join(dir, entry.name));
      } else if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      ) {
        // Scan one level deeper
        try {
          for (const sub of readdirSync(join(dir, entry.name), {
            withFileTypes: true,
          })) {
            if (files.length >= limit) break;
            if (
              sub.isFile() &&
              sub.name.endsWith(".ts") &&
              !sub.name.endsWith(".test.ts") &&
              !sub.name.endsWith(".spec.ts")
            ) {
              files.push(join(dir, entry.name, sub.name));
            }
          }
        } catch {
          /* subdirectory not readable */
        }
      }
    }
  } catch {
    /* directory not readable */
  }
  return files;
}
