/**
 * R9a wiring — `ensureSentinalGitignore` must be reached by install AND update.
 *
 * The upgrade path that makes `.sentinal/runtime.json` committable used to hang
 * off a single call site inside `writeSharedMemory()`. A project that never
 * promoted an observation to shared memory therefore kept `runtime.json`
 * ignored forever, and the entire runtime-contract tier silently never
 * activated for it.
 *
 * These tests drive the REAL entry points (`runInstallAction`,
 * `reinstallPlugins`) against a real temp git repo — not a spy on the helper —
 * so they fail if the call site is removed or moved behind a branch that a
 * normal install does not take.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstallAction } from "./install.js";
import { reinstallPlugins } from "./update.js";
import * as uninstallModule from "./uninstall.js";

/** A .gitignore Sentinal generated before `!runtime.json` existed (v2). */
const V2_CONTENT =
  "# Ignore everything in .sentinal/ except shared project memory, rules, and skills\n" +
  "*\n" +
  "!.gitignore\n" +
  "!project-memory.json\n" +
  "!rules\n" +
  "!rules/\n" +
  "!rules/**\n" +
  "!skills\n" +
  "!skills/\n" +
  "!skills/**\n";

describe("R9a — install/update reach the .sentinal/.gitignore upgrade", () => {
  let projectDir: string;
  let originalCwd: string;

  const gitignorePath = () => join(projectDir, ".sentinal", ".gitignore");

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = join(
      tmpdir(),
      `sentinal-r9a-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    execFileSync("git", ["init", "-q"], {
      cwd: projectDir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("`sentinal install <target>` upgrades a stale v2 .gitignore", async () => {
    writeFileSync(gitignorePath(), V2_CONTENT);

    // The installers themselves are irrelevant here — the point is that the
    // gitignore upgrade is NOT nested inside one of them (it must reach
    // `install claude`, `install opencode` and `install both` alike).
    await runInstallAction(
      "claude",
      {},
      { dispatcher: async () => {}, autoSetup: async () => {} },
    );

    expect(readFileSync(gitignorePath(), "utf-8")).toContain("!runtime.json");
  });

  it("`sentinal update` upgrades a stale v2 .gitignore even with no assistant installed", async () => {
    writeFileSync(gitignorePath(), V2_CONTENT);

    // The early "no assistant detected" return must NOT skip the upgrade.
    spyOn(uninstallModule, "detectInstalledTargets").mockReturnValue({
      claude: false,
      opencode: false,
    });

    await reinstallPlugins();

    expect(readFileSync(gitignorePath(), "utf-8")).toContain("!runtime.json");
  });

  it("install does not clobber a user-customized .gitignore", async () => {
    const custom = "*\n!.gitignore\n!project-memory.json\n!continue-here.md\n";
    writeFileSync(gitignorePath(), custom);

    await runInstallAction(
      "claude",
      {},
      { dispatcher: async () => {}, autoSetup: async () => {} },
    );

    expect(readFileSync(gitignorePath(), "utf-8")).toBe(custom);
  });
});
