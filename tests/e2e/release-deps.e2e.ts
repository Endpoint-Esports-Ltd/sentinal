// Opt-in native-dep provisioning gate (Task 6).
//
// Proves a RELEASE binary resolves its EXTERNALIZED native deps
// (@xenova/transformers + sqlite-vec) AFTER real network provisioning — the #1
// thing the bundled harness misses. A compiled release binary externalizes those
// deps and resolves them from ~/.sentinal/deps; only a real `bun add`/`npm install`
// provisioning step (network, ~150MB) fills that dir. This test forces the deps to
// actually LOAD by doing a real memory_save + memory_search round-trip (which runs
// the 384-dim embedding via transformers and the sqlite-vec vector search).
//
// GATED behind BOTH:
//   SENTINAL_E2E_DEPS=1  — opt-in (network + ~150MB download)
//   SENTINAL_E2E_BINARY  — the release artifact under test
// When either is unset the whole body is skipped (green-by-skip). ALL sandbox and
// network work happens INSIDE the skipped body — the file does ZERO side effects
// in a default `bun test` run.
//
// Isolation: provisioning writes to <sandbox HOME>/.sentinal/deps because
// DEPS_DIR = join(homedir(), ...) and the sandbox overrides HOME. We assert
// (a) the in-sandbox deps dir appears, and (b) the developer's REAL ~/.sentinal/deps
// is byte-unchanged before/after (a HOME-resolution regression would otherwise
// silently pollute it). Plus assertNoRealEscape as a defense-in-depth backstop.
//
// Run enabled (local, network, needs a release-built binary):
//   SENTINAL_E2E_DEPS=1 SENTINAL_E2E_BINARY=$(pwd)/dist/sentinal-<os>-<arch> \
//     bun test ./tests/e2e/release-deps.e2e.ts
// Run skipped (CI/default):
//   bun test ./tests/e2e/release-deps.e2e.ts

import { describe, it, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  hashTree,
  type Sandbox,
} from "./harness/sandbox.ts";

// Both flags required. Network-heavy + needs a real release artifact.
const GATED = !process.env.SENTINAL_E2E_DEPS || !process.env.SENTINAL_E2E_BINARY;

// Provisioning (bun add/npm install) + embedding-model download is slow.
const TIMEOUT = 600_000;

const REAL_DEPS_DIR = join(homedir(), ".sentinal", "deps");

interface McpToolText {
  content?: Array<{ type: string; text?: string }>;
}

// Drive the MCP server of the RELEASE binary under test.
//
// NOTE: we do NOT reuse tests/e2e/harness/mcp-client.ts here. Its serverCommand()
// hardcodes the dev dist/sentinal and ignores SENTINAL_E2E_BINARY — which would
// spawn the wrong binary and defeat this test. We spawn sb.binaryPath (the release
// artifact) directly via the SDK, with the sandbox env, so the RELEASE binary is
// the one loading the provisioned native deps.
async function callReleaseMcp(
  sb: Sandbox,
  calls: (client: Client) => Promise<void>,
): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(sb.env)) {
    if (typeof v === "string") env[k] = v;
  }
  const transport = new StdioClientTransport({
    command: sb.binaryPath, // the SENTINAL_E2E_BINARY release artifact
    args: ["mcp-server"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "sentinal-e2e-deps", version: "0.0.0" });
  await client.connect(transport);
  try {
    await calls(client);
  } finally {
    try {
      await client.close();
    } catch {
      // best effort
    }
    try {
      await transport.close();
    } catch {
      // best effort
    }
  }
}

describe("Task 6 — release native-dep provisioning (opt-in, SENTINAL_E2E_DEPS=1)", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  // Non-gated smoke test: proves the file has ZERO side effects when the flags
  // are unset. This MUST run (and pass) in CI as the default-safe check. It does
  // NOT build a sandbox, provision deps, or spawn the release binary.
  it("is green-by-skip with zero side effects when the flags are unset", () => {
    if (!GATED) {
      // When enabled, the gated case below carries the coverage; this is a no-op.
      expect(GATED).toBe(false);
      return;
    }
    expect(GATED).toBe(true);
  });

  it.skipIf(GATED)(
    "release binary provisions deps then a real memory round-trip succeeds (deps loaded)",
    async () => {
      const realBefore = snapshotRealDirs();
      // Snapshot the REAL ~/.sentinal/deps hash BEFORE any sandbox work.
      const realDepsBefore = hashTree(REAL_DEPS_DIR);

      // autoSetup: true DELETES SENTINAL_NO_AUTO_SETUP so the release binary
      // provisions native deps as a real user would.
      sb = createSandbox({ autoSetup: true });
      expect(sb.env.SENTINAL_NO_AUTO_SETUP).toBeUndefined();

      // Install the RELEASE binary WITHOUT --bundled (it self-selects embedded
      // mode via isBinaryMode()). Post-install runAutoSetup fires because
      // NO_AUTO_SETUP is unset — this triggers native-dep provisioning.
      const installRes = sb.install("opencode", { bundled: false });
      expect(installRes.exitCode).toBe(0);

      // Force provisioning explicitly too (robust against install-path drift).
      // `memory setup` runs runMemorySetup() → bun add/npm install into
      // <home>/.sentinal/deps. Needs cwd: sb.home (work dir exists post-install,
      // but sb.home is always valid and keeps this independent of that).
      const setupRes = sb.run(["memory", "setup"], { cwd: sb.home });
      // Provisioning must succeed (exit 0) for the deps to resolve.
      expect(setupRes.exitCode).toBe(0);

      // SECONDARY sanity: the provisioned deps dir exists IN-SANDBOX.
      const sandboxDeps = join(sb.home, ".sentinal", "deps");
      expect(sb.exists(sandboxDeps)).toBe(true);

      // PRIMARY proof: a real memory_save + memory_search round-trip against the
      // provisioned RELEASE binary. This forces @xenova/transformers (384-dim
      // embedding) + sqlite-vec (vector search) to actually load and run. A
      // missing/broken bundle fails here even if a dir exists.
      const title = "Release deps round-trip alpha bravo charlie delta";
      const content =
        "Native-dep provisioning proof — echo foxtrot golf hotel india.";

      await callReleaseMcp(sb, async (client) => {
        const save = (await client.callTool({
          name: "memory_save",
          arguments: {
            title,
            content,
            type: "discovery",
            project: sb!.home,
          },
        })) as McpToolText;
        const saveText = save.content?.[0]?.text ?? "";
        expect(saveText).toContain("Saved observation #");
        expect(saveText).toContain(title);

        const search = (await client.callTool({
          name: "memory_search",
          arguments: {
            query: "release deps round-trip alpha bravo",
            project: sb!.home,
          },
        })) as McpToolText;
        const searchText = search.content?.[0]?.text ?? "";
        // Finding the saved item proves the embedding + vector search ran.
        expect(searchText).toContain("Found");
        expect(searchText).toContain(title);
      });

      // ISOLATION: the developer's REAL ~/.sentinal/deps must be byte-unchanged.
      // A HOME-resolution regression would otherwise pollute it during real
      // provisioning — this is the highest-blast-radius assertion in the suite.
      expect(hashTree(REAL_DEPS_DIR)).toBe(realDepsBefore);

      // Defense-in-depth backstop across all real user dirs.
      assertNoRealEscape(realBefore);
    },
    TIMEOUT,
  );
});
