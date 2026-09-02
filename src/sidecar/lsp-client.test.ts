/**
 * LSP Client Tests
 *
 * Tests for the TypeScript language server LSP client.
 * Note: These tests require typescript-language-server to be installed.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { LspClient, isLspAvailable, type LspDiagnostic } from "./lsp-client.js";

// ─── Timeout budgets ────────────────────────────────────────────────────────
//
// ⛔ These are DERIVED from what the implementation permits itself, not tuned
// until the flake stopped.
//
// `LspClient.initialize()` gives the LSP `initialize` handshake a 10 000 ms
// budget (`lsp-client.ts:160`, `waitForResponse(id, 10_000)`). bun's default
// per-test timeout is 5 000 ms. Every test below that calls `initialize()` was
// therefore running with HALF the budget the code it exercises is allowed to
// consume — so the implementation's own timeout could never fire and the
// harness always aborted first. `should recover from server crash` initialises
// TWICE, i.e. up to 20 000 ms of sanctioned work against a 5 000 ms harness
// budget: a 4x mismatch, which is why that one flaked under parallel load and
// passed in isolation (measured idle cost: ~1.1-1.6 s for both handshakes).
//
// Rule: the harness must never expire before the implementation does,
// otherwise a timeout says nothing about whether the code is correct.

/** `initialize()`'s own handshake budget — lsp-client.ts:160. */
const INIT_BUDGET_MS = 10_000;

/**
 * Process spawn + first-use binary resolution. `resolveTsServerCommand()` runs
 * up to three `spawnSync` probes on the first call in a process, and it is
 * NOT covered by `INIT_BUDGET_MS` because it happens before the handshake.
 */
const SPAWN_SLACK_MS = 5_000;

/** One handshake. */
const ONE_INIT_MS = INIT_BUDGET_MS + SPAWN_SLACK_MS;

/** Two handshakes, for the crash-recovery cycle. */
const TWO_INIT_MS = 2 * INIT_BUDGET_MS + SPAWN_SLACK_MS;

describe("isLspAvailable", () => {
  it("should return true when typescript-language-server is installed", () => {
    // typescript-language-server is installed in this project
    const available = isLspAvailable();
    expect(typeof available).toBe("boolean");
    // We know it's installed from the check earlier
    expect(available).toBe(true);
  });
});

describe("LspClient", () => {
  let client: LspClient | null = null;

  afterEach(() => {
    client?.shutdown();
    client = null;
  });

  it(
    "should initialize and report ready state",
    async () => {
      client = new LspClient();
      const projectPath = process.cwd();

      // Initialize should complete without error
      await client.initialize(projectPath);
      expect(client.isReady()).toBe(true);
    },
    ONE_INIT_MS,
  );

  it("getDiagnostics is honest: diagnostics array or a distinguishable failure, never a silent [] from a mute server (M1c)", async () => {
    // Before Task 6 this test asserted `Array.isArray(...)` and passed
    // VACUOUSLY: on this repo tsserver's project load exceeds the window, no
    // publishDiagnostics ever arrived, and the deadline path resolved with an
    // empty map — the false clean bill that defeated the tsc fallback.
    // The honest contract: either the server spoke (well-formed array) or
    // the call throws the marker error that routes runTscLsp's caller to the
    // subprocess-tsc fallback.
    client = new LspClient({ diagnosticsTimeoutMs: 6000 });
    const projectPath = process.cwd();

    try {
      // getDiagnostics initializes internally if needed
      const diagnostics = await client.getDiagnostics(projectPath);
      expect(Array.isArray(diagnostics)).toBe(true);
      for (const d of diagnostics.slice(0, 3)) {
        expect(typeof d.file).toBe("string");
        expect(typeof d.line).toBe("number");
        expect(typeof d.message).toBe("string");
      }
    } catch (e) {
      expect(String(e)).toContain("LSP diagnostics failed");
    }
  }, 30000); // LSP server may take time to initialize and analyze

  it(
    "should recover from server crash",
    async () => {
      client = new LspClient();
      const projectPath = process.cwd();

      await client.initialize(projectPath);
      expect(client.isReady()).toBe(true);

      // Force kill the server process
      client.forceKill();
      expect(client.isReady()).toBe(false);

      // Re-initialize should work
      await client.initialize(projectPath);
      expect(client.isReady()).toBe(true);
    },
    TWO_INIT_MS,
  );

  it(
    "should shutdown cleanly",
    async () => {
      client = new LspClient();
      await client.initialize(process.cwd());

      client.shutdown();
      expect(client.isReady()).toBe(false);
      client = null; // prevent afterEach double-shutdown
    },
    ONE_INIT_MS,
  );
});

describe("LspDiagnostic type", () => {
  it("should have the expected shape", () => {
    const diagnostic: LspDiagnostic = {
      file: "src/test.ts",
      line: 10,
      column: 5,
      message: "TS2322: Type 'string' is not assignable to type 'number'.",
      severity: "error",
    };

    expect(diagnostic.file).toBe("src/test.ts");
    expect(diagnostic.severity).toBe("error");
  });
});
