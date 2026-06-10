/**
 * Serve Command
 *
 * `sentinal serve` — Start the console dashboard HTTP server.
 *
 * Options:
 *   --port <port>   Port to listen on (default: 41778)
 *   --host <host>   Host to bind to (default: 127.0.0.1)
 *   --background    Start as a background process (detached)
 */

import type { Command } from "commander";
import {
  writePidFile,
  removePidFile,
  decideServeStartup,
} from "../../dashboard/lifecycle.js";
import { startServer } from "../../dashboard/server.js";
import { logDashboard } from "../../utils/file-log.js";

const DEFAULT_PORT = 41778;
const DEFAULT_HOST = "127.0.0.1";

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start the console dashboard server")
    .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
    .option("--host <host>", "Host to bind to", DEFAULT_HOST)
    .option("-d, --background", "Start as a background process")
    .action(
      async (opts: { port: string; host: string; background?: boolean }) => {
        const port = parseInt(opts.port, 10);
        const host = opts.host;

        if (opts.background) {
          await startBackground(port, host);
          return;
        }

        // Foreground mode — probe first to make serve idempotent
        const version = getVersion();
        const decision = await decideServeStartup({ currentVersion: version });

        if (decision.action === "exit") {
          logDashboard(`dashboard: ${decision.reason} — skipping start`);
          console.log(`Dashboard already running. Visit http://${host}:${port}`);
          process.exit(0);
        }

        if (decision.action === "takeover") {
          logDashboard(
            `dashboard: version mismatch (running=${decision.runningVersion} current=${version}) — taking over from pid=${decision.pid}`,
          );
          try {
            process.kill(decision.pid, "SIGTERM");
            // Wait for port to be released — up to 3 × 200ms
            for (let i = 0; i < 3; i++) {
              await new Promise((r) => setTimeout(r, 200));
              const recheck = await decideServeStartup({ currentVersion: version });
              if (recheck.action !== "exit" && recheck.action !== "takeover") break;
            }
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ESRCH") {
              // Process already gone — fine, proceed to start
              logDashboard("dashboard: takeover target already gone (ESRCH) — proceeding");
            } else {
              logDashboard(`dashboard: takeover kill failed (${code}) — proceeding`);
            }
          }
        }

        if (decision.action === "takeover-no-pid") {
          const msg = `dashboard: version mismatch (running=${decision.runningVersion} current=${version}) but no pid available — cannot auto-takeover. Run: lsof -ti :${port} | xargs kill`;
          logDashboard(msg);
          console.error(msg);
          process.exit(1);
        }

        const server = startServer({ port, host, version });

        writePidFile(process.pid);
        logDashboard(
          `dashboard: started pid=${process.pid} port=${server.port} version=${version}`,
        );
        console.log(`Sentinal Dashboard v${version}`);
        console.log(`Listening on http://${host}:${server.port}`);
        console.log(`Press Ctrl+C to stop`);

        // Graceful shutdown
        const shutdown = () => {
          logDashboard("dashboard: shutting down: signal");
          console.log("\nShutting down...");
          server.stop(true);
          removePidFile();
          process.exit(0);
        };

        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
      },
    );
}

async function startBackground(port: number, host: string): Promise<void> {
  const args = ["serve", "--port", String(port), "--host", host];
  const argv1 = process.argv[1] ?? "";
  // Compiled Bun binaries have argv[1] in virtual FS (/$bunfs/)
  const cmd = argv1.startsWith("/$bunfs/")
    ? [process.execPath, ...args]
    : ["bun", argv1, ...args];

  const proc = Bun.spawn(cmd, {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  proc.unref();

  console.log(`Dashboard started in background (PID: ${proc.pid})`);
  console.log(`Visit http://${host}:${port}`);
}

declare const __SENTINAL_VERSION__: string | undefined;

function getVersion(): string {
  if (typeof __SENTINAL_VERSION__ !== "undefined") {
    return __SENTINAL_VERSION__;
  }
  try {
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
