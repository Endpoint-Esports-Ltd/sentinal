/**
 * Test Preload
 *
 * Loads Homebrew SQLite before any Database instances are created.
 * This enables sqlite-vec extension loading in tests.
 * Must be loaded via bunfig.toml preload or test --preload flag.
 */

import { loadCustomSqlite } from "./vector-store.js";

loadCustomSqlite();
