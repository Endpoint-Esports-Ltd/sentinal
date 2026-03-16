/**
 * LSP Client for TypeScript Diagnostics
 *
 * Manages a persistent `typescript-language-server` process for fast
 * incremental type checking. Uses push-based `publishDiagnostics`
 * notifications rather than pull-based `textDocument/diagnostic`.
 *
 * Lifecycle: lazy init → warm-up → serve requests → idle timeout → shutdown.
 * Crash recovery: re-spawns on next request if process died.
 */

import { Subprocess } from "bun";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

// ─── LSP Protocol Helpers ─────────────────────────────────────────────────────

let nextRequestId = 1;

function encodeMessage(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function makeRequest(method: string, params?: unknown): { id: number; msg: string } {
  const id = nextRequestId++;
  const msg = encodeMessage({ jsonrpc: "2.0", id, method, params });
  return { id, msg };
}

function makeNotification(method: string, params?: unknown): string {
  return encodeMessage({ jsonrpc: "2.0", method, params });
}

// ─── Availability Check ───────────────────────────────────────────────────────

/**
 * Resolve the typescript-language-server binary path.
 * Tries direct path first, then npx, then bunx.
 */
function resolveTsServerCommand(): string[] | null {
  // Try direct
  try {
    const r = Bun.spawnSync(["typescript-language-server", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) return ["typescript-language-server", "--stdio"];
  } catch { /* not in PATH */ }

  // Try via npx (Node.js projects)
  try {
    const r = Bun.spawnSync(["npx", "--yes", "typescript-language-server", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) return ["npx", "--yes", "typescript-language-server", "--stdio"];
  } catch { /* no npx */ }

  // Try via bunx
  try {
    const r = Bun.spawnSync(["bunx", "typescript-language-server", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) return ["bunx", "typescript-language-server", "--stdio"];
  } catch { /* no bunx */ }

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

function getTsServerCommand(): string[] {
  if (cachedCommand === undefined) cachedCommand = resolveTsServerCommand();
  if (!cachedCommand) throw new Error("typescript-language-server not available");
  return cachedCommand;
}

// ─── LSP Client ───────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DIAGNOSTICS_TIMEOUT_MS = 15_000;   // 15 seconds for diagnostics to arrive

export class LspClient {
  private proc: Subprocess | null = null;
  private ready = false;
  private projectPath: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private buffer = "";
  private pendingResponses = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private diagnosticsMap = new Map<string, LspDiagnostic[]>();
  private diagnosticsWaiters: Array<() => void> = [];

  isReady(): boolean {
    return this.ready && this.proc !== null;
  }

  async initialize(projectPath: string): Promise<void> {
    this.projectPath = resolve(projectPath);

    if (this.proc) this.shutdown();

    const cmd = getTsServerCommand();
    this.proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      cwd: this.projectPath,
    });

    // Start reading stdout
    this.startReading();

    // LSP initialize handshake
    const initParams = {
      processId: process.pid,
      capabilities: {},
      rootUri: `file://${this.projectPath}`,
      workspaceFolders: [{ uri: `file://${this.projectPath}`, name: "workspace" }],
    };

    const { id, msg } = makeRequest("initialize", initParams);
    this.send(msg);
    await this.waitForResponse(id, 10_000);

    // Send initialized notification
    this.send(makeNotification("initialized", {}));

    this.ready = true;
    this.touchIdle();
  }

  async getDiagnostics(projectPath: string): Promise<LspDiagnostic[]> {
    if (!this.isReady()) {
      await this.initialize(projectPath);
    }
    this.touchIdle();
    this.diagnosticsMap.clear();

    // Open a sentinel file to trigger diagnostics for the project
    // The LS will push publishDiagnostics for files it analyzes
    const tsconfigPath = join(resolve(projectPath), "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      const content = readFileSync(tsconfigPath, "utf-8");
      this.send(makeNotification("textDocument/didOpen", {
        textDocument: {
          uri: `file://${tsconfigPath}`,
          languageId: "json",
          version: 1,
          text: content,
        },
      }));
    }

    // Open a few .ts files to trigger diagnostics
    const srcDir = join(resolve(projectPath), "src");
    if (existsSync(srcDir)) {
      const tsFiles = this.findTsFiles(srcDir, 10);
      for (const file of tsFiles) {
        try {
          const content = readFileSync(file, "utf-8");
          this.send(makeNotification("textDocument/didOpen", {
            textDocument: {
              uri: `file://${file}`,
              languageId: "typescript",
              version: 1,
              text: content,
            },
          }));
        } catch { /* skip unreadable files */ }
      }
    }

    // Wait for diagnostics to arrive (push-based)
    await this.waitForDiagnostics(DIAGNOSTICS_TIMEOUT_MS);

    // Aggregate all diagnostics
    const all: LspDiagnostic[] = [];
    for (const diagnostics of this.diagnosticsMap.values()) {
      all.push(...diagnostics);
    }
    return all;
  }

  shutdown(): void {
    this.ready = false;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.proc) {
      try {
        this.send(makeRequest("shutdown").msg);
        this.send(makeNotification("exit"));
      } catch { /* process may already be dead */ }
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.pendingResponses.clear();
    this.diagnosticsMap.clear();
    this.buffer = "";
  }

  forceKill(): void {
    this.ready = false;
    if (this.proc) {
      try { this.proc.kill(9); } catch { /* ignore */ }
      this.proc = null;
    }
    this.pendingResponses.clear();
    this.buffer = "";
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private send(data: string): void {
    if (!this.proc?.stdin) throw new Error("LSP process not running");
    const stdin = this.proc.stdin as unknown as { write(s: string): void; flush(): void };
    stdin.write(data);
    stdin.flush();
  }

  private startReading(): void {
    if (!this.proc?.stdout) return;
    const stdout = this.proc.stdout as unknown as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          this.processBuffer();
        }
      } catch {
        // Stream ended (process died)
        this.ready = false;
      }
    };
    read();
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length: (\d+)/);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const contentStart = headerEnd + 4;
      if (this.buffer.length < contentStart + contentLength) break;

      const content = this.buffer.slice(contentStart, contentStart + contentLength);
      this.buffer = this.buffer.slice(contentStart + contentLength);

      try {
        const message = JSON.parse(content);
        this.handleMessage(message);
      } catch { /* invalid JSON, skip */ }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    // Response to a request
    if (typeof message.id === "number" && this.pendingResponses.has(message.id)) {
      const handler = this.pendingResponses.get(message.id)!;
      this.pendingResponses.delete(message.id);
      if (message.error) {
        handler.reject(new Error(String((message.error as Record<string, unknown>)?.message ?? "LSP error")));
      } else {
        handler.resolve(message.result);
      }
      return;
    }

    // Notification: textDocument/publishDiagnostics
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: Array<Record<string, unknown>> };
      if (params?.uri && Array.isArray(params.diagnostics)) {
        const filePath = params.uri.replace("file://", "");
        const diagnostics: LspDiagnostic[] = params.diagnostics.map((d) => {
          const range = d.range as { start?: { line?: number; character?: number } } | undefined;
          const severityNum = d.severity as number | undefined;
          return {
            file: filePath,
            line: (range?.start?.line ?? 0) + 1, // LSP is 0-indexed
            column: (range?.start?.character ?? 0) + 1,
            message: String(d.message ?? ""),
            severity: severityNum === 1 ? "error" : "warning",
          };
        });
        this.diagnosticsMap.set(filePath, diagnostics);
        // Notify waiters
        for (const waiter of this.diagnosticsWaiters) waiter();
      }
    }
  }

  private waitForResponse(id: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`LSP request ${id} timed out`));
      }, timeoutMs);

      this.pendingResponses.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private waitForDiagnostics(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      // Wait a bit for diagnostics to stream in, then resolve
      // The LS pushes diagnostics asynchronously; we collect for a short window
      const deadline = Date.now() + Math.min(timeoutMs, 10000);
      let settled = false;
      let lastCount = 0;
      let stableCount = 0;

      const check = () => {
        if (settled) return;
        const currentCount = this.diagnosticsMap.size;
        if (currentCount === lastCount) stableCount++;
        else { stableCount = 0; lastCount = currentCount; }

        // Resolve when diagnostics stabilize (2 consecutive checks with same count after first result)
        if (currentCount > 0 && stableCount >= 2) {
          settled = true;
          resolve();
          return;
        }

        if (Date.now() > deadline) {
          settled = true;
          resolve();
          return;
        }

        setTimeout(check, 200);
      };

      // Register as a waiter so we get notified on each diagnostic push
      const waiterFn = () => { /* Just used for notification, check runs on interval */ };
      this.diagnosticsWaiters.push(waiterFn);

      // Cleanup waiter on completion
      const origResolve = resolve;
      resolve = () => {
        const idx = this.diagnosticsWaiters.indexOf(waiterFn);
        if (idx !== -1) this.diagnosticsWaiters.splice(idx, 1);
        origResolve();
      };

      setTimeout(check, 300);
    });
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_TIMEOUT_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  private findTsFiles(dir: string, limit: number): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (files.length >= limit) break;
        if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts")) {
          files.push(join(dir, entry.name));
        } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          // Scan one level deeper
          try {
            for (const sub of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
              if (files.length >= limit) break;
              if (sub.isFile() && sub.name.endsWith(".ts") && !sub.name.endsWith(".test.ts") && !sub.name.endsWith(".spec.ts")) {
                files.push(join(dir, entry.name, sub.name));
              }
            }
          } catch { /* subdirectory not readable */ }
        }
      }
    } catch { /* directory not readable */ }
    return files;
  }
}
