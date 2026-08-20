/**
 * OpenCode installer for `sentinal install opencode`.
 *
 * Installs the plugin (embedded `.mjs` in binary mode, the global npm package
 * otherwise), the flat asset directories (commands / rules / agents), the
 * nested `skills/<name>/SKILL.md` tree, `AGENTS.md`, and finally the
 * `opencode.json` merge (see `install-opencode-config.ts`).
 *
 * ⛔ Extracted from `install.ts` verbatim — behaviour must stay byte-identical
 * to what shipped before the split. This is the user-facing install path.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  colors,
  info,
  ok,
  err,
  note,
  run,
  commandExists,
  resolveXdgConfig,
  resolveAssetsDir,
  mkdirp,
} from "../../utils/shell.js";
import {
  checkChromeDevToolsMcp,
  checkPlaywrightCli,
} from "./install-prereqs.js";
import { greet } from "./greet.js";
import {
  MCP_SERVERS_OPENCODE,
  AGENTS_MD_GLOBAL,
  AGENTS_MD_LOCAL_TEMPLATE,
  AGENTS_MD_APPEND,
} from "./install-constants.js";
import {
  isBinaryMode,
  getSentinalBinPath,
  readdirSyncSafe,
} from "./install-shared.js";
import { writeOpenCodeConfig } from "./install-opencode-config.js";
import {
  EMBEDDED_OPENCODE_PLUGIN,
  EMBEDDED_COMMANDS,
  EMBEDDED_RULES,
  EMBEDDED_OC_AGENTS,
  EMBEDDED_OC_SKILLS,
} from "../embedded-assets.js";

// ─── OpenCode installer ─────────────────────────────────────────────────────

export async function installOpenCode(
  local: boolean,
  bundled: boolean = false,
): Promise<void> {
  greet();
  note("  for OpenCode");
  console.log("");

  const binary = isBinaryMode() || bundled;

  // ── Prerequisites ──

  info("Checking prerequisites...");

  if (!commandExists("opencode")) {
    err("x OpenCode not found");
    console.log("  Install: curl -fsSL https://opencode.ai/install | bash");
    process.exit(1);
  }
  ok("  OpenCode found");

  if (!binary) {
    if (!commandExists("bun")) {
      err("x Bun not found");
      console.log("  Install from https://bun.sh");
      process.exit(1);
    }
    ok("  Bun found");
  }

  if (!commandExists("node")) {
    err("x Node.js not found");
    console.log("  Install Node.js 18+ from https://nodejs.org");
    process.exit(1);
  }
  ok("  Node.js found");

  // Optional: browser automation for /spec UI verification. Either tool
  // satisfies the E2E requirement (D11) — both are detect-only.
  checkPlaywrightCli();
  checkChromeDevToolsMcp();
  console.log("");

  // ── Determine target directories ──
  const xdgConfig = resolveXdgConfig();
  const globalConfig = join(xdgConfig, "opencode");
  const targetDir = local ? join(process.cwd(), ".opencode") : globalConfig;
  const commandsDir = join(targetDir, "commands");
  const rulesDir = join(targetDir, "rules");
  const pluginsDir = join(targetDir, "plugins");

  note(`Installing ${local ? "to current project" : "globally"}: ${targetDir}`);
  console.log("");

  // ── Install plugin ──

  installOpenCodePlugin(binary, pluginsDir);

  // ── Install flat asset dirs (commands, rules, agents) ──

  const agentsDir = join(targetDir, "agents");
  const skillsDir = join(targetDir, "skills");
  installFlatAssetDirs(binary, { commandsDir, rulesDir, agentsDir });

  // ── Install skills (nested dirs: skills/<name>/SKILL.md) ──

  installSkills(binary, skillsDir);

  // ── AGENTS.md ──

  writeAgentsMd(local, targetDir);

  // ── opencode config ──

  info("Configuring OpenCode...");

  const pluginPath = binary
    ? "./plugins/sentinal.mjs"
    : "@endpoint/sentinal/opencode-plugin";

  // In binary mode, use absolute binary path for MCP server command
  const mcpServers = binary
    ? {
        ...MCP_SERVERS_OPENCODE,
        sentinal: {
          type: "local" as const,
          command: [getSentinalBinPath(), "mcp-server"],
        },
      }
    : MCP_SERVERS_OPENCODE;

  const configFile = writeOpenCodeConfig({
    configDir: local ? process.cwd() : targetDir,
    binary,
    pluginPath,
    mcpServers,
  });

  // ── Success ──

  console.log(`\n${colors.green}${"=".repeat(60)}${colors.nc}`);
  ok("Sentinal for OpenCode installed successfully!");
  console.log(`${colors.green}${"=".repeat(60)}${colors.nc}`);
  note("Installed:");
  console.log(
    `  Plugin:   ${pluginPath}${binary ? " (embedded)" : " (npm package)"}`,
  );
  console.log(`  Commands: ${commandsDir}/*.md`);
  console.log(`  Rules:    ${rulesDir}/*.md`);
  console.log(`  Agents:   ${agentsDir}/*.md`);
  console.log(`  Skills:   ${skillsDir}/*/SKILL.md`);
  console.log(`  Config:   ${configFile}`);
  console.log("");
  note("Get started: opencode → /sync → /spec 'your task'");
  console.log("");
}

// ─── Plugin payload ─────────────────────────────────────────────────────────

/**
 * Binary mode extracts the embedded `.mjs`; npm mode installs the global
 * package and lets the plugin load by package reference.
 */
function installOpenCodePlugin(binary: boolean, pluginsDir: string): void {
  if (binary) {
    // Binary mode: extract embedded plugin from compiled binary
    info("Extracting embedded plugin...");
    mkdirp(pluginsDir);
    writeFileSync(join(pluginsDir, "sentinal.mjs"), EMBEDDED_OPENCODE_PLUGIN);
    ok("  Plugin extracted to plugins/sentinal.mjs");
    return;
  }

  // NPM mode: install package globally, plugin loads via package reference
  info("Installing @endpoint/sentinal globally...");
  const npmrcPath = join(homedir(), ".npmrc");
  let hasRegistry = false;
  if (existsSync(npmrcPath))
    hasRegistry = readFileSync(npmrcPath, "utf-8").includes(
      "@endpoint:registry",
    );
  if (!hasRegistry) {
    err("x Scoped registry not configured for @endpoint packages");
    console.log(
      "  Add to ~/.npmrc: @endpoint:registry=https://npm.cloud.endpoint.gg/",
    );
    process.exit(1);
  }
  if (commandExists("sentinal")) {
    ok("  @endpoint/sentinal already installed globally");
  } else {
    const installResult = run(["bun", "add", "-g", "@endpoint/sentinal"]);
    if (!installResult.ok) {
      err(`Failed to install: ${installResult.stderr}`);
      process.exit(1);
    }
    ok("  @endpoint/sentinal installed globally");
  }
  if (!commandExists("sentinal"))
    info('  ! sentinal not in PATH — add: export PATH="$HOME/.bun/bin:$PATH"');
}

// ─── Assets ─────────────────────────────────────────────────────────────────

interface FlatAssetDirs {
  commandsDir: string;
  rulesDir: string;
  agentsDir: string;
}

/** Install the flat `*.md` asset directories: commands, rules, agents. */
function installFlatAssetDirs(binary: boolean, dirs: FlatAssetDirs): void {
  const flatDirs = [
    {
      label: "commands",
      dest: dirs.commandsDir,
      embedded: EMBEDDED_COMMANDS,
      src: "commands",
    },
    {
      label: "rules",
      dest: dirs.rulesDir,
      embedded: EMBEDDED_RULES,
      src: "rules",
    },
    {
      label: "agents",
      dest: dirs.agentsDir,
      embedded: EMBEDDED_OC_AGENTS,
      src: "agents",
    },
  ];
  for (const { label, dest, embedded, src } of flatDirs) {
    info(`Installing ${label}...`);
    mkdirp(dest);
    if (binary) {
      for (const [name, content] of Object.entries(embedded) as [
        string,
        string,
      ][]) {
        writeFileSync(join(dest, name), content);
        ok(`    ${name}`);
      }
    } else {
      const srcDir = join(resolveAssetsDir(), "opencode", src);
      for (const file of readdirSyncSafe(srcDir).filter((f) =>
        f.endsWith(".md"),
      )) {
        copyFileSync(join(srcDir, file), join(dest, file));
        ok(`    ${file}`);
      }
    }
  }
}

/** Install the nested skills tree: `skills/<name>/SKILL.md`. */
function installSkills(binary: boolean, skillsDir: string): void {
  info("Installing skills...");
  mkdirp(skillsDir);
  if (binary) {
    for (const [path, content] of Object.entries(EMBEDDED_OC_SKILLS) as [
      string,
      string,
    ][]) {
      const dir = join(skillsDir, path.replace("/SKILL.md", ""));
      mkdirp(dir);
      writeFileSync(join(dir, "SKILL.md"), content);
      ok(`    ${path}`);
    }
  } else {
    const srcSkills = join(resolveAssetsDir(), "opencode", "skills");
    for (const dir of readdirSyncSafe(srcSkills)) {
      const skillMd = join(srcSkills, dir, "SKILL.md");
      if (existsSync(skillMd)) {
        mkdirp(join(skillsDir, dir));
        copyFileSync(skillMd, join(skillsDir, dir, "SKILL.md"));
        ok(`    ${dir}/SKILL.md`);
      }
    }
  }
}

/** Write (or append to) AGENTS.md — global template, or project-local. */
function writeAgentsMd(local: boolean, targetDir: string): void {
  info("Creating AGENTS.md...");
  if (!local) {
    writeFileSync(join(targetDir, "AGENTS.md"), AGENTS_MD_GLOBAL);
    ok("  Global AGENTS.md created");
    return;
  }
  const agentsPath = join(process.cwd(), "AGENTS.md");
  if (existsSync(agentsPath)) {
    writeFileSync(
      agentsPath,
      readFileSync(agentsPath, "utf-8") + AGENTS_MD_APPEND,
    );
    ok("  Updated existing AGENTS.md");
  } else {
    writeFileSync(agentsPath, AGENTS_MD_LOCAL_TEMPLATE);
    ok("  Created AGENTS.md");
  }
}
