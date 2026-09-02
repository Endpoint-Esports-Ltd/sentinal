/**
 * LSP Client for TypeScript Diagnostics
 *
 * Manages a persistent `typescript-language-server` process for fast
 * incremental type checking. Uses push-based `publishDiagnostics`
 * notifications rather than pull-based `textDocument/diagnostic`.
 *
 * Lifecycle: lazy init → warm-up → serve requests → idle timeout → shutdown.
 * Crash recovery: re-spawns on next request if process died.
 *
 * Task 6 (M1) invariants: re-roots (shutdown + initialize) when asked about
 * a DIFFERENT project; one diagnostics cycle at a time per instance (timed
 * mutex — a wedged run degrades callers to the subprocess-tsc fallback,
 * never queues them forever); a cycle in which ZERO publishDiagnostics
 * notifications arrived THROWS instead of reporting a false clean bill;
 * framing is byte-accurate (see lsp-transport.ts).
 */

import { Subprocess } from "bun";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  makeRequest,
  makeNotification,
  getTsServerCommand,
  findTsFiles,
  FrameDecoder,
  TimedMutex,
} from "./lsp-transport.js";

// Re-export the surface that moved to lsp-transport.ts so existing import
// sites (quality-routes.ts, tests) are unaffected by the split.
export { isLspAvailable } from "./lsp-transport.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

export interface LspClientOptions {
  /** Override the language-server command (tests inject a fake server). */
  command?: string[];
  /** Deadline for publishDiagnostics to arrive in one cycle. */
  diagnosticsTimeoutMs?: number;
  /** Max wait for the per-instance diagnostics mutex. */
  mutexTimeoutMs?: number;
}

// ─── LSP Client ───────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DIAGNOSTICS_TIMEOUT_MS = 15_000; // 15 seconds for diagnostics to arrive
// One full cycle worst case ≈ init handshake (10s) + diagnostics window (15s).
// The mutex must outlast a LEGITIMATE holder and only fail on a wedged one.
const MUTEX_TIMEOUT_MS = 30_000;

export class LspClient {
  private proc: Subprocess | null = null;
  private ready = false;
  private projectPath: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private frames = new FrameDecoder();
  private mutex = new TimedMutex();
  /** publishDiagnostics notifications seen in the CURRENT cycle (M1c). */
  private publishCount = 0;
  private pendingResponses = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private diagnosticsMap = new Map<string, LspDiagnostic[]>();

  constructor(private readonly options: LspClientOptions = {}) {}

  isReady(): boolean {
    return this.ready && this.proc !== null;
  }

  async initialize(projectPath: string): Promise<void> {
    this.projectPath = resolve(projectPath);

    if (this.proc) this.shutdown();

    const cmd = this.options.command ?? getTsServerCommand();
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
      workspaceFolders: [
        { uri: `file://${this.projectPath}`, name: "workspace" },
      ],
    };

    const { id, msg } = makeRequest("initialize", initParams);
    this.send(msg);
    await this.waitForResponse(id, 10_000);

    // Send initialized notification
    this.send(makeNotification("initialized", {}));

    this.ready = true;
    this.touchIdle();
  }

  /**
   * Run one diagnostics cycle. Serialized per instance (M1b); re-roots when
   * the requested project differs from the one the server was initialized
   * for (M1a); throws if no publishDiagnostics arrived at all (M1c) so the
   * caller (runTscLsp) falls back to subprocess tsc.
   */
  async getDiagnostics(projectPath: string): Promise<LspDiagnostic[]> {
    const release = await this.mutex.acquire(
      this.options.mutexTimeoutMs ?? MUTEX_TIMEOUT_MS,
    );
    try {
      return await this.runDiagnosticsCycle(projectPath);
    } finally {
      release();
    }
  }

  private async runDiagnosticsCycle(
    projectPath: string,
  ): Promise<LspDiagnostic[]> {
    const resolved = resolve(projectPath);
    // M1a: a ready server rooted at ANOTHER project must be re-initialized —
    // its analysis (and everything it pushes) is rooted at the old project.
    if (!this.isReady() || this.projectPath !== resolved) {
      await this.initialize(projectPath);
    }
    this.touchIdle();
    this.diagnosticsMap.clear();
    this.publishCount = 0;

    // Open a sentinel file to trigger diagnostics for the project
    // The LS will push publishDiagnostics for files it analyzes
    const tsconfigPath = join(resolved, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      const content = readFileSync(tsconfigPath, "utf-8");
      this.send(
        makeNotification("textDocument/didOpen", {
          textDocument: {
            uri: `file://${tsconfigPath}`,
            languageId: "json",
            version: 1,
            text: content,
          },
        }),
      );
    }

    // Open a few .ts files to trigger diagnostics
    const srcDir = join(resolved, "src");
    if (existsSync(srcDir)) {
      for (const file of findTsFiles(srcDir, 10)) {
        try {
          const content = readFileSync(file, "utf-8");
          this.send(
            makeNotification("textDocument/didOpen", {
              textDocument: {
                uri: `file://${file}`,
                languageId: "typescript",
                version: 1,
                text: content,
              },
            }),
          );
        } catch {
          /* skip unreadable files */
        }
      }
    }

    // Wait for diagnostics to arrive (push-based)
    await this.waitForDiagnostics(
      this.options.diagnosticsTimeoutMs ?? DIAGNOSTICS_TIMEOUT_MS,
    );

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
      } catch {
        /* process may already be dead */
      }
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.pendingResponses.clear();
    this.diagnosticsMap.clear();
    this.frames.reset();
  }

  forceKill(): void {
    this.ready = false;
    if (this.proc) {
      try {
        this.proc.kill(9);
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.pendingResponses.clear();
    this.frames.reset();
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private send(data: string): void {
    if (!this.proc?.stdin) throw new Error("LSP process not running");
    const stdin = this.proc.stdin as unknown as {
      write(s: string): void;
      flush(): void;
    };
    stdin.write(data);
    stdin.flush();
  }

  private startReading(): void {
    if (!this.proc?.stdout) return;
    const stdout = this.proc.stdout as unknown as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // M1d: raw bytes into the frame decoder — never decode a chunk
          // before its frame is complete.
          for (const message of this.frames.push(value)) {
            this.handleMessage(message as Record<string, unknown>);
          }
        }
      } catch {
        // Stream ended (process died)
        this.ready = false;
      }
    };
    read();
  }

  private handleMessage(message: Record<string, unknown>): void {
    // Response to a request
    if (
      typeof message.id === "number" &&
      this.pendingResponses.has(message.id)
    ) {
      const handler = this.pendingResponses.get(message.id)!;
      this.pendingResponses.delete(message.id);
      if (message.error) {
        handler.reject(
          new Error(
            String(
              (message.error as Record<string, unknown>)?.message ??
                "LSP error",
            ),
          ),
        );
      } else {
        handler.resolve(message.result);
      }
      return;
    }

    // Notification: textDocument/publishDiagnostics
    if (message.method === "textDocument/publishDiagnostics") {
      this.publishCount++; // M1c: the server DID speak, even if it said "clean"
      const params = message.params as {
        uri?: string;
        diagnostics?: Array<Record<string, unknown>>;
      };
      if (params?.uri && Array.isArray(params.diagnostics)) {
        const filePath = params.uri.replace("file://", "");
        const diagnostics: LspDiagnostic[] = params.diagnostics.map((d) => {
          const range = d.range as
            { start?: { line?: number; character?: number } } | undefined;
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
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /**
   * Wait for pushed diagnostics to stabilize. M1c: if the deadline passes
   * with ZERO publishDiagnostics notifications, REJECT — the old behaviour
   * (resolve with an empty map) let a mute/slow server masquerade as a
   * clean type check and defeated the subprocess-tsc fallback.
   */
  private waitForDiagnostics(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let lastCount = 0;
      let stableCount = 0;

      const check = () => {
        const currentCount = this.diagnosticsMap.size;
        if (currentCount === lastCount) stableCount++;
        else {
          stableCount = 0;
          lastCount = currentCount;
        }

        // Resolve when diagnostics stabilize (2 consecutive checks with same count after first result)
        if (currentCount > 0 && stableCount >= 2) {
          resolve();
          return;
        }

        if (Date.now() > deadline) {
          if (this.publishCount === 0) {
            reject(
              new Error(
                "LSP diagnostics failed: no publishDiagnostics notification arrived before the deadline",
              ),
            );
          } else {
            resolve(); // the server spoke — an empty result is a genuine clean bill
          }
          return;
        }

        setTimeout(check, 200);
      };

      setTimeout(check, 300);
    });
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_TIMEOUT_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }
}
