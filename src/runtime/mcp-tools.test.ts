/**
 * Runtime MCP tool tests (Phase 3, Task 3).
 *
 *   - runtime_config: resolve, validate, interpolate `.sentinal/runtime.json`
 *   - runtime_init:   DRAFT one for human review (never writes)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerRuntimeTools } from "./mcp-tools.js";
import { RESOURCE_CLASSES } from "./schema.js";
import { captureTools, type ToolHandler } from "../test-helpers.js";

let root: string;
let tools: Map<string, ToolHandler>;

beforeEach(() => {
  root = join(
    tmpdir(),
    `sentinal-rt-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, ".sentinal"), { recursive: true });
  tools = captureTools(registerRuntimeTools, {});
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (o: unknown) =>
  writeFileSync(join(root, ".sentinal", "runtime.json"), JSON.stringify(o));

const text = async (name: string, args: Record<string, unknown>) =>
  (await tools.get(name)!(args)).content[0].text as string;

describe("registration", () => {
  it("registers both runtime tools", () => {
    expect(tools.has("runtime_config")).toBe(true);
    expect(tools.has("runtime_init")).toBe(true);
  });
});

describe("runtime_config", () => {
  it("reports an unconfigured project inertly — no error wording", async () => {
    const out = await text("runtime_config", { project: root });
    expect(out.toLowerCase()).toContain("no ");
    expect(out.toLowerCase()).not.toContain("error");
  });

  it("resolves from the `project` argument, never process.cwd()", async () => {
    // The repo Sentinal itself runs in has no runtime.json, so a cwd-based
    // implementation would report "not configured" for a configured project.
    writeConfig({ up: "npm start", readiness: "http://localhost:3000" });
    const out = await text("runtime_config", { project: root });
    expect(out).toContain("npm start");
  });

  it("shows the interpolated commands and the slot", async () => {
    writeFileSync(
      join(root, ".sentinal", "worktree.env"),
      "SENTINAL_WORKTREE_SLOT=6\n",
    );
    writeConfig({
      up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
      readiness: "http://localhost:3000",
    });
    const out = await text("runtime_config", { project: root });
    expect(out).toContain("./stack up 6");
    expect(out).toContain("6");
  });

  it("surfaces a validation error naming the token", async () => {
    writeConfig({
      up: "./stack ${SENTINAL_TYPO}",
      readiness: "http://localhost:3000",
    });
    const out = await text("runtime_config", { project: root });
    expect(out).toContain("${SENTINAL_TYPO}");
  });

  it("marks explicitly-shared resources as requiring confirmation", async () => {
    writeConfig({ isolation: { database: "shared" } });
    const out = await text("runtime_config", { project: root });
    expect(out).toContain("database");
    expect(out.toLowerCase()).toContain("confirm");
  });

  it("reports unknown classes WITHOUT asking for confirmation", async () => {
    writeConfig({ isolation: { database: "isolated" } });
    const out = await text("runtime_config", { project: root });
    expect(out.toLowerCase()).toContain("undeclared");
    expect(out.toLowerCase()).not.toContain("confirm");
  });

  // Signal density: a nine-item "undeclared" list on every scaffolded file is
  // the noise D10 rule 3 was written to avoid. Condense when the map says
  // nothing at all; enumerate only when it says something.
  it("condenses to ONE line when no isolation is declared at all", async () => {
    writeConfig({ up: "npm start", readiness: "http://localhost:3000" });
    const out = await text("runtime_config", { project: root });

    expect(out.toLowerCase()).toContain("all classes unknown");
    // Not a nine-item enumeration.
    for (const cls of RESOURCE_CLASSES) expect(out).not.toContain(cls);
    // ⛔ D10 rule 1 is unchanged: unknown still never prompts.
    expect(out.toLowerCase()).not.toContain("confirm");
  });

  it("still ENUMERATES when the isolation map is only partially filled", async () => {
    writeConfig({ isolation: { database: "isolated" } });
    const out = await text("runtime_config", { project: root });

    expect(out.toLowerCase()).not.toContain("all classes unknown");
    // The eight classes the author did not mention are named individually.
    expect(out).toContain("objectStorage");
    expect(out).toContain("outboundEmail");
    expect(out).toContain("ports");
    expect(out.toLowerCase()).not.toContain("confirm");
  });

  it("condenses without suppressing a declared-shared block", async () => {
    // All nine unknown is impossible alongside a `shared` entry, but the
    // blocking branch must stay reachable and independent of this change.
    writeConfig({ isolation: { database: "shared" } });
    const out = await text("runtime_config", { project: root });
    expect(out.toLowerCase()).toContain("confirm");
    expect(out.toLowerCase()).not.toContain("all classes unknown");
  });

  it("asks for NOTHING when there is no config at all", async () => {
    const out = await text("runtime_config", { project: root });
    expect(out.toLowerCase()).not.toContain("confirm");
    expect(out.toLowerCase()).not.toContain("undeclared");
  });

  it("never throws on a broken file", async () => {
    writeFileSync(join(root, ".sentinal", "runtime.json"), "{{{");
    const out = await text("runtime_config", { project: root });
    expect(out).toContain("runtime.json");
  });
});

describe("runtime_init", () => {
  it("returns a draft and does NOT write it", async () => {
    writeFileSync(
      join(root, "docker-compose.yml"),
      'services:\n  app:\n    ports:\n      - "3000:3000"\n  db:\n    image: postgres:16\n',
    );
    const out = await text("runtime_init", { project: root });

    expect(out).toContain("docker compose up -d");
    expect(existsSync(join(root, ".sentinal", "runtime.json"))).toBe(false);
  });

  it("reports detected resources in the CONVERSATION, not in the draft", async () => {
    writeFileSync(
      join(root, "docker-compose.yml"),
      "services:\n  db:\n    image: postgres:16\n",
    );
    const out = await text("runtime_init", { project: root });

    expect(out).toContain("database");
    // The draft body itself carries no isolation declaration.
    expect(out).not.toMatch(/^\s*"isolation"\s*:/m);
  });

  it("says plainly that isolation is left unset and will not interrupt runs", async () => {
    const out = await text("runtime_init", { project: root });
    expect(out.toLowerCase()).toContain("isolation");
    expect(out.toLowerCase()).toContain("unknown");
  });

  it("refuses to overwrite an existing contract", async () => {
    writeConfig({ detached: false });
    const out = await text("runtime_init", { project: root });
    expect(out.toLowerCase()).toContain("already");
  });
});
