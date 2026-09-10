/**
 * Test Preload
 *
 * 1. Redirects the whole `~/.sentinal` tree (DB, sidecar socket/port/pid) to
 *    a per-run temp dir via `SENTINAL_HOME` (Task 6b — H6), so no test run
 *    can ever write into the real user store or reach the user's LIVE
 *    sidecar socket. Must happen before any Database construction or
 *    sidecar connection attempt — this file runs first via bunfig.toml.
 * 2. Loads Homebrew SQLite before any Database instances are created.
 *    This enables sqlite-vec extension loading in tests.
 *
 * Must be loaded via bunfig.toml preload or test --preload flag.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCustomSqlite } from "./vector-store.js";

process.env.SENTINAL_HOME = mkdtempSync(join(tmpdir(), "sentinal-test-home-"));

loadCustomSqlite();
