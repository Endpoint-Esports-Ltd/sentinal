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
import { isServerRunning, writePidFile, removePidFile } from "../../dashboard/lifecycle.js";
import { startServer } from "../../dashboard/server.js";

const DEFAULT_PORT = 41778;
const DEFAULT_HOST = "127.0.0.1";

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start the console dashboard server")
    .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
    .option("--host <host>", "Host to bind to", DEFAULT_HOST)
    .option("-d, --background", "Start as a background process")
    .action(async (opts: { port: string; host: string; background?: boolean }) => {
      const port = parseInt(opts.port, 10);
      const host = opts.host;

      // Check for existing server
      if (isServerRunning()) {
        console.log(`Dashboard already running. Visit http://${host}:${port}`);
        process.exit(0);
      }

      if (opts.background) {
        await startBackground(port, host);
        return;
      }

      // Foreground mode
      const version = getVersion();
      const server = startServer({ port, host, version });

      writePidFile(process.pid);
      console.log(`Sentinal Dashboard v${version}`);
      console.log(`Listening on http://${host}:${server.port}`);
      console.log(`Press Ctrl+C to stop`);

      // Graceful shutdown
      const shutdown = () => {
        console.log("\nShutting down...");
        server.stop(true);
        removePidFile();
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });
}

async function startBackground(port: number, host: string): Promise<void> {
  const sentinalBin = process.argv[1];
  const args = ["serve", "--port", String(port), "--host", host];

  // Use Bun.spawn to detach the process
  const proc = Bun.spawn(["bun", sentinalBin, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });

  // Detach by unreffing
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
