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
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
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
} from "../../sidecar/server.js";

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
    .action(async (opts: { background?: boolean; httpOnly?: boolean; port?: string }) => {
      if (isSidecarRunning()) {
        const status = getSidecarStatus();
        console.log(`Sidecar already running (PID: ${status.pid}, transport: ${status.transport})`);
        process.exit(0);
      }

      if (opts.background) {
        await startBackground(opts.httpOnly, opts.port);
        return;
      }

      // Foreground mode
      const port = opts.port ? parseInt(opts.port, 10) : undefined;
      const result = startSidecar({ httpOnly: opts.httpOnly, port });

      writeFileSync(getSidecarPidPath(), String(process.pid), "utf-8");
      const addr =
        result.transport === "unix"
          ? "unix socket"
          : `http://127.0.0.1:${(result.server as any).port}`;
      console.log(`Sidecar started (PID: ${process.pid}, transport: ${result.transport})`);
      console.log(`Listening on ${addr}`);
      console.log("Press Ctrl+C to stop");

      const shutdown = () => {
        console.log("\nShutting down sidecar...");
        stopSidecar(result.server, result.ctx);
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });

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
      const result = startSidecar({ httpOnly: opts.httpOnly });
      writeFileSync(getSidecarPidPath(), String(process.pid), "utf-8");

      const addr =
        result.transport === "unix"
          ? "unix socket"
          : `http://127.0.0.1:${(result.server as any).port}`;
      console.log(`Sidecar restarted (PID: ${process.pid}, transport: ${result.transport})`);
      console.log(`Listening on ${addr}`);
      console.log("Press Ctrl+C to stop");

      const shutdown = () => {
        console.log("\nShutting down sidecar...");
        stopSidecar(result.server, result.ctx);
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });
}

async function startBackground(httpOnly?: boolean, port?: string): Promise<void> {
  const sentinalBin = process.argv[1];
  const args = ["sidecar", "start"];
  if (httpOnly) args.push("--http-only");
  if (port) args.push("--port", port);

  const proc = Bun.spawn(["bun", sentinalBin, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  proc.unref();

  console.log(`Sidecar started in background (PID: ${proc.pid})`);
}
