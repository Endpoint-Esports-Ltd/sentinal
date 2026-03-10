/**
 * Sidecar Path Constants
 *
 * Shared path helpers used by client, lifecycle, and server modules.
 * Kept in a separate file to avoid pulling in bun:sqlite transitively
 * (server.ts imports MemoryStore which imports bun:sqlite).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { DB_CONSTANTS } from "../memory/types.js";

export const SIDECAR_SOCKET = "sidecar.sock";
export const SIDECAR_PORT_FILE = "sidecar.port";
export const SIDECAR_PID_FILE = "sidecar.pid";

export function getSidecarSocketPath(): string {
  return join(homedir(), DB_CONSTANTS.DB_DIR, SIDECAR_SOCKET);
}

export function getSidecarPortPath(): string {
  return join(homedir(), DB_CONSTANTS.DB_DIR, SIDECAR_PORT_FILE);
}

export function getSidecarPidPath(): string {
  return join(homedir(), DB_CONSTANTS.DB_DIR, SIDECAR_PID_FILE);
}
