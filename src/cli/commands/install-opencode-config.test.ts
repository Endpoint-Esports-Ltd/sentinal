/**
 * Tests for install-opencode-config.ts — M7a additive mcp merge (with the
 * sentinal force-update exception) and M7c backup + never-start-fresh +
 * shape-validated casts.
 *
 * All tests use tmp-dir fixtures — never a real config.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeOpenCodeConfig } from "./install-opencode-config.js";
import { MCP_SERVERS_OPENCODE } from "./install-constants.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const PLUGIN_PATH = "@endpoint/sentinal/opencode-plugin";

function write(dir: string, mcpServers?: Record<string, unknown>): string {
  return writeOpenCodeConfig({
    configDir: dir,
    binary: false,
    pluginPath: PLUGIN_PATH,
    mcpServers: mcpServers ?? clone(MCP_SERVERS_OPENCODE),
  });
}

describe("writeOpenCodeConfig — additive mcp merge (M7a)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinal-install-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = () => join(dir, "opencode.json");

  it("preserves a user-pinned context7 value byte-for-byte", () => {
    const pinned = {
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp@1.2.3"],
    };
    writeFileSync(
      configPath(),
      JSON.stringify({ mcp: { context7: clone(pinned) } }, null, 2) + "\n",
    );

    write(dir);

    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(after.mcp.context7).toEqual(pinned);
    // Absent managed servers were added
    expect(after.mcp["web-search"]).toEqual(MCP_SERVERS_OPENCODE["web-search"]);
    expect(after.mcp["grep-mcp"]).toEqual(MCP_SERVERS_OPENCODE["grep-mcp"]);
  });

  it("preserves enabled:false user edits on managed servers", () => {
    const disabled = {
      ...clone(MCP_SERVERS_OPENCODE["web-fetch"]),
      enabled: false,
    };
    writeFileSync(
      configPath(),
      JSON.stringify({ mcp: { "web-fetch": clone(disabled) } }, null, 2) + "\n",
    );

    write(dir);

    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(after.mcp["web-fetch"]).toEqual(disabled);
  });

  it("force-updates the sentinal entry (binary path must track the install)", () => {
    writeFileSync(
      configPath(),
      JSON.stringify(
        {
          mcp: {
            sentinal: {
              type: "local",
              command: ["/old/path/to/sentinal", "mcp-server"],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const newSentinal = {
      type: "local",
      command: ["/new/path/to/sentinal", "mcp-server"],
    };
    write(dir, { ...clone(MCP_SERVERS_OPENCODE), sentinal: newSentinal });

    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(after.mcp.sentinal).toEqual(newSentinal);
  });
});

describe("writeOpenCodeConfig — backup + safe casts (M7c)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinal-install-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = () => join(dir, "opencode.json");

  it("writes a .bak of the pre-write content before modifying (latest-wins)", () => {
    const original = JSON.stringify({ theme: "dark" }, null, 2) + "\n";
    writeFileSync(configPath(), original);

    write(dir);
    expect(readFileSync(`${configPath()}.bak`, "utf-8")).toBe(original);

    // Second run: .bak now holds the newer pre-write content
    const secondPre = readFileSync(configPath(), "utf-8");
    write(dir);
    expect(readFileSync(`${configPath()}.bak`, "utf-8")).toBe(secondPre);
  });

  it("does not write a .bak when creating a fresh config", () => {
    write(dir);
    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(`${configPath()}.bak`)).toBe(false);
  });

  it("a string-valued plugin field does not TypeError — treated as empty with a warning", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ plugin: "not-an-array" }, null, 2) + "\n",
    );

    expect(() => write(dir)).not.toThrow();
    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(after.plugin).toEqual([PLUGIN_PATH]);
  });

  it("a string-valued instructions field does not TypeError", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ instructions: "oops" }, null, 2) + "\n",
    );

    expect(() => write(dir)).not.toThrow();
    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(after.instructions).toEqual([".sentinal/rules/*.md"]);
  });

  it("a non-object mcp field does not corrupt the merge", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ mcp: "broken" }, null, 2) + "\n",
    );

    expect(() => write(dir)).not.toThrow();
    const after = JSON.parse(readFileSync(configPath(), "utf-8"));
    // Managed servers written fresh; no spread-a-string char-index garbage
    expect(after.mcp.context7).toEqual(MCP_SERVERS_OPENCODE.context7);
    expect(after.mcp["0"]).toBeUndefined();
  });

  it("unparseable config: skipped with a warning, byte-unchanged, no .bak, NO process.exit", () => {
    const truncated = '{ "mcp": { "context7": ';
    writeFileSync(configPath(), truncated);

    // Run in a subprocess: the pre-fix implementation calls process.exit(1),
    // which would kill the test runner if invoked in-process.
    const implPath = join(import.meta.dir, "install-opencode-config.ts");
    const script = `
      const { writeOpenCodeConfig } = await import(${JSON.stringify(implPath)});
      writeOpenCodeConfig({
        configDir: ${JSON.stringify(dir)},
        binary: false,
        pluginPath: ${JSON.stringify(PLUGIN_PATH)},
        mcpServers: {},
      });
      console.log("SURVIVED");
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env },
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("SURVIVED");
    expect(readFileSync(configPath(), "utf-8")).toBe(truncated);
    expect(existsSync(`${configPath()}.bak`)).toBe(false);
  }, 30_000);
});
