/**
 * Sidecar Command
 *
 * `sentinal sidecar <subcommand>` — Manage the sidecar server.
 *
 * Subcommands:
 *   start       Start the sidecar (foreground by default, -d for background)
 *   stop        Stop the running sidecar
 *   status      Show sidecar status
 *   restart     Restart the sidecar (background by default, --foreground to block)
 *   logs        Show recent sidecar / plugin log lines
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { buildLogsReport, type LogFileFilter } from "./sidecar-logs.js";
import {
  assessSidecarStart,
  getSidecarStatus,
  isProcessAlive,
  isSidecarReachable,
  readSidecarPid,
  stopSidecarProcess,
} from "../../sidecar/lifecycle.js";
import {
  runRestart,
  spawnDetachedSidecar,
  waitForProcessExit,
} from "./sidecar-restart.js";
import {
  startSidecar,
  stopSidecar,
  getSidecarPidPath,
  enableSessionAwareShutdown,
} from "../../sidecar/server.js";
import { logSidecar } from "../../utils/file-log.js";
import { stopServer } from "../../dashboard/lifecycle.js";

export function registerSidecarCommand(program: Command): void {
  const sidecar = program
    .command("sidecar")
    .description("Manage the sidecar server");

  // ─── start ──────────────────────────────────────────────────────────────

  sidecar
    .command("start")
    .description("Start the sidecar server")
    .option("-d, --background", "Start as a background process")
    .option("--http-only", "Force HTTP-only mode (no Unix socket)")
    .option("--port <port>", "Specific port for HTTP mode (0 = dynamic)")
    .action(
      async (opts: {
        background?: boolean;
        httpOnly?: boolean;
        port?: string;
      }) => {
        await runStart(opts);
      },
    );

  // ─── stop ───────────────────────────────────────────────────────────────

  sidecar
    .command("stop")
    .description("Stop the running sidecar server")
    .action(() => {
      const stopped = stopSidecarProcess();
      if (stopped) {
        console.log("Sidecar stopped.");
      } else {
        console.log("Sidecar is not running.");
      }
    });

  // ─── status ─────────────────────────────────────────────────────────────

  sidecar
    .command("status")
    .description("Show sidecar server status")
    .action(() => {
      const status = getSidecarStatus();
      if (status.running) {
        console.log(`Sidecar: running`);
        console.log(`  PID:       ${status.pid}`);
        console.log(`  Transport: ${status.transport}`);
      } else {
        console.log("Sidecar: not running");
      }
    });

  // ─── restart ────────────────────────────────────────────────────────────

  sidecar
    .command("restart")
    .description(
      "Restart the sidecar server (in the background by default; returns once it answers)",
    )
    .option("--foreground", "Run the restarted sidecar in this process")
    .option("-d, --background", "Accepted for compatibility (now the default)")
    .option("--http-only", "Force HTTP-only mode")
    .action(async (opts: { foreground?: boolean; httpOnly?: boolean }) => {
      const code = await runRestart(
        { foreground: opts.foreground, httpOnly: opts.httpOnly },
        {
          readPid: readSidecarPid,
          stop: () => stopSidecarProcess(),
          waitForExit: (pid, timeoutMs) =>
            waitForProcessExit(pid, timeoutMs, { isAlive: isProcessAlive }),
          spawnBackground: ({ httpOnly }) =>
            spawnDetachedSidecar(
              httpOnly
                ? ["sidecar", "start", "--http-only"]
                : ["sidecar", "start"],
            ),
          waitForReady: () => waitForReachable(READY_TIMEOUT_MS),
          startForeground: ({ httpOnly }) => runStart({ httpOnly }),
          log: (line) => console.log(line),
        },
      );
      if (code !== 0) process.exit(code);
    });

  // ─── logs ───────────────────────────────────────────────────────────────

  sidecar
    .command("logs")
    .description("Show recent sidecar and/or plugin log lines")
    .option("-n, --lines <n>", "Number of tail lines to show per file", "50")
    .option(
      "--file <name>",
      "Which file to show: sidecar | plugin | dashboard | all",
      "all",
    )
    .action((opts: { lines: string; file: string }) => {
      const n = parseInt(opts.lines, 10);
      const file = (
        ["sidecar", "plugin", "dashboard", "all"].includes(opts.file)
          ? opts.file
          : "all"
      ) as LogFileFilter;
      process.stdout.write(buildLogsReport({ lines: isNaN(n) ? 50 : n, file }));
    });
}

const READY_TIMEOUT_MS = 15_000;

/** Poll until a sidecar answers /health, or the timeout elapses. */
async function waitForReachable(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSidecarReachable()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * The `start` path, shared by `sidecar start` and `sidecar restart --foreground`.
 * Background mode spawns a detached `sidecar start` child that runs this same
 * path in the foreground of its own process group.
 */
async function runStart(opts: {
  background?: boolean;
  httpOnly?: boolean;
  port?: string;
}): Promise<void> {
  // M2a: REACHABILITY decides, not kill(pid,0) — a recycled PID must
  // not block the start forever. Live-but-unreachable past the boot
  // grace → assessSidecarStart cleans the stale files and we proceed.
  const decision = await assessSidecarStart();
  if (decision.action === "already-running") {
    const status = getSidecarStatus();
    console.log(
      `Sidecar already running (PID: ${status.pid}, transport: ${status.transport})`,
    );
    process.exit(0);
  }
  if (decision.action === "booting") {
    console.log(
      "Another sidecar appears to be booting (fresh pidfile, not yet reachable) — not starting a second one.",
    );
    process.exit(0);
  }

  if (opts.background) {
    const args = ["sidecar", "start"];
    if (opts.httpOnly) args.push("--http-only");
    if (opts.port) args.push("--port", opts.port);
    const pid = spawnDetachedSidecar(args);
    console.log(`Sidecar started in background (PID: ${pid})`);
    return;
  }

  // Foreground mode
  const port = opts.port ? parseInt(opts.port, 10) : undefined;
  const result = await startSidecar({ httpOnly: opts.httpOnly, port });

  if (result.alreadyRunning) {
    console.log("Sidecar already running (detected via socket probe).");
    process.exit(0);
  }

  writeFileSync(getSidecarPidPath(), String(process.pid), "utf-8");
  const httpPort = result.httpServer
    ? result.httpServer.port
    : result.server.port;
  const addr =
    result.transport === "unix"
      ? `unix socket + http://127.0.0.1:${httpPort}`
      : `http://127.0.0.1:${httpPort}`;
  console.log(
    `Sidecar started (PID: ${process.pid}, transport: ${result.transport})`,
  );
  console.log(`Listening on ${addr}`);
  console.log("Press Ctrl+C to stop (auto-shutdown when no sessions active)");
  logSidecar(
    `sidecar: started pid=${process.pid} transport=${result.transport} port=${httpPort}`,
  );

  // Enable session-aware shutdown — sidecar stays alive while sessions exist
  enableSessionAwareShutdown(result);

  const shutdown = () => {
    logSidecar("sidecar: shutting down: signal");
    console.log("\nShutting down sidecar...");
    // Stop the dashboard alongside the sidecar on explicit signal.
    try {
      const activeSessions = result.ctx.store.getActiveSessions();
      if (activeSessions.length === 0) {
        stopServer();
        logSidecar("sidecar: dashboard stopped");
      }
    } catch {
      /* non-fatal */
    }
    stopSidecar(result.server, result.ctx, result.httpServer);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
