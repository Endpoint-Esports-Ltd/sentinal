/**
 * Sidecar Command
 *
 * `sentinal sidecar <subcommand>` — Manage the sidecar server.
 *
 * Subcommands:
 *   start       Start the sidecar (foreground by default, -d for background)
 *   stop        Stop the running sidecar
 *   status      Show sidecar status
 *   restart     Restart the sidecar
 *   logs        Show recent sidecar / plugin log lines
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { buildLogsReport, type LogFileFilter } from "./sidecar-logs.js";
import {
  isSidecarRunning,
  getSidecarStatus,
  stopSidecarProcess,
  readSidecarPid,
} from "../../sidecar/lifecycle.js";
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
        if (isSidecarRunning()) {
          const status = getSidecarStatus();
          console.log(
            `Sidecar already running (PID: ${status.pid}, transport: ${status.transport})`,
          );
          process.exit(0);
        }

        if (opts.background) {
          await startBackground(opts.httpOnly, opts.port);
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
          ? (result.httpServer as any).port
          : (result.server as any).port;
        const addr =
          result.transport === "unix"
            ? `unix socket + http://127.0.0.1:${httpPort}`
            : `http://127.0.0.1:${httpPort}`;
        console.log(
          `Sidecar started (PID: ${process.pid}, transport: ${result.transport})`,
        );
        console.log(`Listening on ${addr}`);
        console.log(
          "Press Ctrl+C to stop (auto-shutdown when no sessions active)",
        );
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
    .description("Restart the sidecar server")
    .option("-d, --background", "Restart as a background process")
    .option("--http-only", "Force HTTP-only mode")
    .action(async (opts: { background?: boolean; httpOnly?: boolean }) => {
      const wasStopped = stopSidecarProcess();
      if (wasStopped) {
        console.log("Stopped existing sidecar.");
        // Brief pause for cleanup
        await new Promise((r) => setTimeout(r, 200));
      }

      if (opts.background) {
        await startBackground(opts.httpOnly);
        return;
      }

      // Delegate to foreground start logic via re-parse
      // Simpler: just inline foreground start
      const result = await startSidecar({ httpOnly: opts.httpOnly });
      writeFileSync(getSidecarPidPath(), String(process.pid), "utf-8");

      const httpPort = result.httpServer
        ? (result.httpServer as any).port
        : (result.server as any).port;
      const addr =
        result.transport === "unix"
          ? `unix socket + http://127.0.0.1:${httpPort}`
          : `http://127.0.0.1:${httpPort}`;
      console.log(
        `Sidecar restarted (PID: ${process.pid}, transport: ${result.transport})`,
      );
      console.log(`Listening on ${addr}`);
      console.log(
        "Press Ctrl+C to stop (auto-shutdown when no sessions active)",
      );
      logSidecar(
        `sidecar: started pid=${process.pid} transport=${result.transport} port=${httpPort}`,
      );

      // Enable session-aware shutdown
      enableSessionAwareShutdown(result);

      const shutdown = () => {
        logSidecar("sidecar: shutting down: signal");
        console.log("\nShutting down sidecar...");
        stopSidecar(result.server, result.ctx, result.httpServer);
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
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
        ["sidecar", "plugin", "dashboard", "all"].includes(opts.file) ? opts.file : "all"
      ) as LogFileFilter;
      process.stdout.write(buildLogsReport({ lines: isNaN(n) ? 50 : n, file }));
    });
}

/**
 * Build a spawn command that works for both compiled binaries and source mode.
 * Compiled Bun binaries have argv[1] starting with `/$bunfs/` (virtual FS).
 */
function buildSpawnCmd(subArgs: string[]): string[] {
  const argv1 = process.argv[1] ?? "";
  if (argv1.startsWith("/$bunfs/")) {
    // Compiled binary — use process.execPath which is the real binary
    return [process.execPath, ...subArgs];
  }
  // Source mode — need bun prefix
  return ["bun", argv1, ...subArgs];
}

async function startBackground(
  httpOnly?: boolean,
  port?: string,
): Promise<void> {
  const args = ["sidecar", "start"];
  if (httpOnly) args.push("--http-only");
  if (port) args.push("--port", port);

  const proc = Bun.spawn(buildSpawnCmd(args), {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  proc.unref();

  console.log(`Sidecar started in background (PID: ${proc.pid})`);
}
