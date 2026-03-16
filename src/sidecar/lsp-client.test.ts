/**
 * LSP Client Tests
 *
 * Tests for the TypeScript language server LSP client.
 * Note: These tests require typescript-language-server to be installed.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { LspClient, isLspAvailable, type LspDiagnostic } from "./lsp-client.js";

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

  it("should initialize and report ready state", async () => {
    client = new LspClient();
    const projectPath = process.cwd();

    // Initialize should complete without error
    await client.initialize(projectPath);
    expect(client.isReady()).toBe(true);
  });

  it("should return diagnostics as an array", async () => {
    client = new LspClient();
    const projectPath = process.cwd();

    // getDiagnostics initializes internally if needed
    const diagnostics = await client.getDiagnostics(projectPath);

    // Should return an array (possibly empty if no errors)
    expect(Array.isArray(diagnostics)).toBe(true);
    // Each diagnostic should have the expected shape
    for (const d of diagnostics.slice(0, 3)) {
      expect(typeof d.file).toBe("string");
      expect(typeof d.line).toBe("number");
      expect(typeof d.message).toBe("string");
    }
  }, 30000); // LSP server may take time to initialize and analyze

  it("should recover from server crash", async () => {
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
  });

  it("should shutdown cleanly", async () => {
    client = new LspClient();
    await client.initialize(process.cwd());

    client.shutdown();
    expect(client.isReady()).toBe(false);
    client = null; // prevent afterEach double-shutdown
  });
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
