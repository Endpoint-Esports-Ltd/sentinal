/**
 * Sidecar Path Constants
 *
 * Shared path helpers used by client, lifecycle, and server modules.
 * Kept in a separate file to avoid pulling in bun:sqlite transitively
 * (server.ts imports MemoryStore which imports bun:sqlite).
 *
 * All paths honour the `SENTINAL_HOME` seam via `getSentinalHome()`
 * (Task 6b — H6): during tests the whole tree, including the sidecar
 * socket, is redirected so a suite can never reach the user's LIVE
 * sidecar. `db-path.ts` imports only `node:*` + types, so this file
 * stays hook-safe and sqlite-free.
 */

import { join } from "node:path";
import { getSentinalHome } from "../memory/db-path.js";

export const SIDECAR_SOCKET = "sidecar.sock";
export const SIDECAR_PORT_FILE = "sidecar.port";
export const SIDECAR_PID_FILE = "sidecar.pid";

export function getSidecarSocketPath(): string {
  return join(getSentinalHome(), SIDECAR_SOCKET);
}

export function getSidecarPortPath(): string {
  return join(getSentinalHome(), SIDECAR_PORT_FILE);
}

export function getSidecarPidPath(): string {
  return join(getSentinalHome(), SIDECAR_PID_FILE);
}
