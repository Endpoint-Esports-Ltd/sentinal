/**
 * Optional-prerequisite detection for `sentinal install`.
 *
 * Everything here is a SOFT check: it prints a status line and never calls
 * `process.exit()`. Most installs need none of these tools, and hard-failing
 * an install on a missing optional dependency would be bad UX.
 *
 * Lives in its own module rather than in `install.ts` because that file had
 * grown to ~1050 lines, far past Sentinal's own 600-line block threshold.
 * Tests live in `install.test.ts`: `checkChromeDevToolsMcp` is imported from
 * THIS module directly, while `checkPlaywrightCli` is imported via a one-line
 * re-export from `install.ts` (the import predates this module and the test
 * file must keep passing unchanged).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  commandExists as defaultCommandExists,
  ok,
  info,
  resolveXdgConfig,
} from "../../utils/shell.js";

// ─── playwright-cli ─────────────────────────────────────────────────────────

/**
 * Soft check for `playwright-cli` — an OPTIONAL dependency needed for
 * /spec UI verification. Prints a status line and, if missing, an install
 * hint pointing at the correct scoped package (`@playwright/cli`).
 *
 * This helper intentionally NEVER calls `process.exit()` — it is a soft
 * warning. Most installs do not require browser automation, and hard-failing
 * the install flow on a missing optional dep would be bad UX.
 *
 * The bare `playwright-cli` package on npm is a deprecated legacy stub
 * (`playwright-cli@0.262.0`, marked "Deprecated, use @playwright/cli
 * instead"). The correct package is the scoped `@playwright/cli@latest`,
 * which ships a binary named `playwright-cli`.
 *
 * The `check` parameter is injected for testability — callers pass `() =>
 * true`/`() => false` stubs in unit tests. Production callers rely on the
 * default `commandExists` lookup against `$PATH`.
 */
export function checkPlaywrightCli(
  check: (cmd: string) => boolean = defaultCommandExists,
): void {
  if (check("playwright-cli")) {
    ok("[OK] playwright-cli found (optional)");
    return;
  }
  info(
    "[i] playwright-cli not found (optional, needed for /spec UI verification)",
  );
  console.log("  Install: npm install -g @playwright/cli@latest");
  console.log(
    "  Note: the scoped `@playwright/cli` package is the correct one —",
  );
  console.log(
    "        bare `playwright-cli` on npm is a deprecated legacy stub.",
  );
}

// ─── Chrome DevTools MCP ────────────────────────────────────────────────────

/** Chrome/Chromium launchers commonly found on `$PATH`. */
const CHROME_BINARIES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

/** macOS application bundles. Only consulted when `platform === "darwin"`. */
const CHROME_APP_BUNDLES = [
  "/Applications/Google Chrome.app",
  "/Applications/Chromium.app",
];

/** The npm package / server name — used as both a `$PATH` probe and a config marker. */
const CDP_MCP_NAME = "chrome-devtools-mcp";

/**
 * Size ceiling for a file this probe is willing to read.
 *
 * `~/.claude.json` is the reason this exists: it stores per-project session
 * state and routinely reaches tens of megabytes for active Claude Code users.
 * Loading all of that synchronously, during an install, to look for one
 * 19-character marker whose only effect is `[OK]` versus a hint is not a
 * trade worth making. 2 MB is far above any hand-written MCP config.
 */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Config files that may already declare the server. Read-only, never written.
 *
 * This is the canonical enumeration of every location an MCP server can be
 * configured for either target, at either scope. `/sync`'s Phase 7 prose
 * mirrors it, so the two must not drift.
 *
 *   - OpenCode, user scope:  `$XDG_CONFIG_HOME/opencode/opencode.json{,c}`
 *                            (defaulting to `~/.config` — resolved via
 *                            `resolveXdgConfig()`, exactly as the OpenCode
 *                            installer and uninstaller do)
 *   - Claude Code, user:     `~/.claude.json`, `~/.claude/settings.json`
 *   - OpenCode, project:     `<cwd>/opencode.json{,c}` — where a `--local`
 *                            install actually writes, since `writeOpenCodeConfig`
 *                            uses `process.cwd()` as its config dir — plus the
 *                            `<cwd>/.opencode/opencode.json` variant
 *   - Claude Code, project:  `<cwd>/.mcp.json`
 *
 * Exported for testing — the list is the whole behaviour, so asserting it
 * directly is more honest than inferring it from a probe's output.
 */
export function defaultMcpConfigPaths(): string[] {
  const xdgConfig = resolveXdgConfig();
  return [
    join(xdgConfig, "opencode", "opencode.json"),
    join(xdgConfig, "opencode", "opencode.jsonc"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "settings.json"),
    join(process.cwd(), "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(process.cwd(), ".opencode", "opencode.json"),
    join(process.cwd(), ".mcp.json"),
  ];
}

export interface ChromeDevToolsProbe {
  /** `$PATH` lookup. Injected in tests. */
  commandExists?: (cmd: string) => boolean;
  /** Filesystem existence check, used for macOS app bundles. Injected in tests. */
  pathExists?: (path: string) => boolean;
  /** MCP config files to scan for an existing declaration. Injected in tests. */
  mcpConfigPaths?: string[];
  /** Platform override. Injected in tests. */
  platform?: NodeJS.Platform;
}

/**
 * Soft check for **Chrome DevTools MCP** — an OPTIONAL browser-automation tool
 * that satisfies /spec's E2E requirement equally well as `playwright-cli`
 * (see the shipped `rules/playwright-cli.md`).
 *
 * ⛔ **Detect only.** This function never adds an entry to `mcpServers` or
 * `opencode.json`, and never writes any file at all. Installing or configuring
 * Chrome DevTools MCP is explicitly out of scope — Sentinal recognises the tool
 * when the user has chosen to have it, and says nothing otherwise.
 *
 * ## Why the predicate is two-part
 *
 * `commandExists("chrome-devtools-mcp")` on its own would be **always false**
 * in practice. Unlike `@playwright/cli`, Chrome DevTools MCP ships no global
 * binary — it is conventionally launched via `npx`. A bare `$PATH` check would
 * therefore print an install hint on every single install, for a tool nobody
 * installs globally. That is noise, not signal.
 *
 *   1. **Browser capability** — is Chrome/Chromium present at all? Chrome
 *      DevTools MCP requires Chrome, so this gates the whole path. Users
 *      without Chrome get **no output whatsoever**.
 *   2. **MCP availability** — is `chrome-devtools-mcp` resolvable on `$PATH`,
 *      or already named in the user's MCP config? This only decides `[OK]`
 *      versus a hint; it never gates step 1.
 */
export function checkChromeDevToolsMcp(probe: ChromeDevToolsProbe = {}): void {
  const cmdExists = probe.commandExists ?? defaultCommandExists;
  const pathExists = probe.pathExists ?? existsSync;
  const platform = probe.platform ?? process.platform;
  const configPaths = probe.mcpConfigPaths ?? defaultMcpConfigPaths();

  // ── 1. Browser capability. No Chrome -> stay silent. ──
  const hasChrome =
    CHROME_BINARIES.some((bin) => cmdExists(bin)) ||
    (platform === "darwin" &&
      CHROME_APP_BUNDLES.some((app) => pathExists(app)));

  if (!hasChrome) return;

  // ── 2. MCP availability. ──
  const hasMcp = cmdExists(CDP_MCP_NAME) || declaredInMcpConfig(configPaths);

  if (hasMcp) {
    ok("[OK] Chrome DevTools MCP available (optional)");
    return;
  }

  info(
    "[i] Chrome DevTools MCP not configured (optional, alternative to playwright-cli for /spec UI verification)",
  );
  console.log(`  Run via: npx ${CDP_MCP_NAME}@latest`);
  console.log(
    "  Sentinal does not install or configure it — add it to your own MCP config if you want it.",
  );
}

/**
 * True when any readable config file mentions the server name. Deliberately a
 * substring scan rather than a schema-aware parse: the same marker has to be
 * recognised in OpenCode's `mcp` block, Claude Code's `mcpServers` block, and
 * any jsonc variant, and a false positive here costs nothing — it only
 * suppresses a hint. Missing, unreadable or malformed files are skipped
 * silently — the `statSync`/`readFileSync` throw is the existence check.
 *
 * Files above `MAX_CONFIG_BYTES` are skipped WITHOUT being read. The cost of a
 * false negative is one extra hint line; the cost of a false positive on
 * install latency is reading a multi-megabyte `~/.claude.json` off disk.
 */
function declaredInMcpConfig(paths: string[]): boolean {
  for (const path of paths) {
    try {
      if (statSync(path).size > MAX_CONFIG_BYTES) continue;
      if (readFileSync(path, "utf-8").includes(CDP_MCP_NAME)) return true;
    } catch {
      // Unreadable config is not an error for an optional-dependency probe.
    }
  }
  return false;
}
