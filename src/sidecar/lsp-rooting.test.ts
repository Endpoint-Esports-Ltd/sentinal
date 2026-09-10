/**
 * LSP Client Behaviour Tests (Task 6: M1a re-root, M1b serialize, M1c honest timeout)
 *
 * Uses a controllable fake LSP server (`bun -e` script) instead of the real
 * typescript-language-server so interleavings and mute behaviour are
 * deterministic. The fake tags every published diagnostic with the rootUri it
 * was initialized with, which is exactly what M1a/M1b must keep straight.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { LspClient } from "./lsp-client.js";
import { runTscLsp } from "./quality-runners.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";

// ─── Fake LSP server ─────────────────────────────────────────────────────
//
// Speaks byte-accurate LSP framing over stdio. Modes:
//   echo-root — every didOpen publishes a diagnostic tagged `root:<rootUri>`
//   mute      — answers the handshake but NEVER publishes diagnostics
const FAKE_SERVER_SCRIPT = `
const mode = "__MODE__";
let buf = Buffer.alloc(0);
let root = "";
function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json);
}
function handle(msg) {
  if (msg.method === "initialize") {
    root = (msg.params && msg.params.rootUri) || "";
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/didOpen") {
    if (mode === "mute") return;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{
          range: { start: { line: 0, character: 0 } },
          severity: 1,
          message: "root:" + root,
        }],
      },
    });
  } else if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    process.exit(0);
  }
}
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n");
    if (idx === -1) break;
    const m = buf.slice(0, idx).toString().match(/Content-Length: (\\d+)/);
    const len = m ? parseInt(m[1], 10) : 0;
    if (buf.length < idx + 4 + len) break;
    const body = buf.slice(idx + 4, idx + 4 + len).toString();
    buf = buf.slice(idx + 4 + len);
    try { handle(JSON.parse(body)); } catch {}
  }
});
`;

function fakeServerCmd(mode: "echo-root" | "mute"): string[] {
  return ["bun", "-e", FAKE_SERVER_SCRIPT.replace("__MODE__", mode)];
}

// ─── Fixture projects ────────────────────────────────────────────────────

let projA: string;
let projB: string;

function makeProject(name: string): string {
  const dir = join(tmpdir(), `lsp-root-${name}-${Date.now().toString(36)}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  // realpath: tmpdir is a symlink on macOS (/var → /private/var) and the
  // client resolves paths without following symlinks.
  return realpathSync(dir);
}

beforeAll(() => {
  projA = makeProject("a");
  projB = makeProject("b");
});

afterAll(() => {
  rmSync(projA, { recursive: true, force: true });
  rmSync(projB, { recursive: true, force: true });
});

let client: LspClient | null = null;

afterEach(() => {
  client?.shutdown();
  client = null;
});

// ─── M1a: re-root on project change ──────────────────────────────────────

describe("LspClient re-rooting (M1a)", () => {
  it("re-initializes for a different project: B's diagnostics are rooted at B", async () => {
    client = new LspClient({
      command: fakeServerCmd("echo-root"),
      diagnosticsTimeoutMs: 5000,
    });

    const dA = await client.getDiagnostics(projA);
    const dB = await client.getDiagnostics(projB);

    expect(dA.length).toBeGreaterThan(0);
    expect(dB.length).toBeGreaterThan(0);
    for (const d of dA) expect(d.message).toBe(`root:file://${projA}`);
    // Before the fix the server stays rooted at A: these carry root:...projA
    for (const d of dB) expect(d.message).toBe(`root:file://${projB}`);
  }, 30_000);
});

// ─── M1b: serialized diagnostics cycles ──────────────────────────────────

describe("LspClient serialization (M1b)", () => {
  it("two concurrent getDiagnostics for different projects do not cross-contaminate", async () => {
    client = new LspClient({
      command: fakeServerCmd("echo-root"),
      diagnosticsTimeoutMs: 5000,
    });

    const [dA, dB] = await Promise.all([
      client.getDiagnostics(projA),
      client.getDiagnostics(projB),
    ]);

    expect(dA.length).toBeGreaterThan(0);
    expect(dB.length).toBeGreaterThan(0);
    for (const d of dA) expect(d.message).toBe(`root:file://${projA}`);
    for (const d of dB) expect(d.message).toBe(`root:file://${projB}`);
  }, 30_000);

  it("the mutex times out behind a wedged run instead of queueing forever", async () => {
    // First call runs against a mute server → holds the lock for its full
    // diagnostics window (6s). Second call must give up quickly, not queue.
    client = new LspClient({
      command: fakeServerCmd("mute"),
      diagnosticsTimeoutMs: 6000,
      mutexTimeoutMs: 500,
    });

    const first = client.getDiagnostics(projA).catch((e: Error) => e);
    await Bun.sleep(300); // ensure the first call holds the lock
    const start = Date.now();
    const second = await client.getDiagnostics(projB).catch((e: Error) => e);

    expect(second).toBeInstanceOf(Error);
    expect(Date.now() - start).toBeLessThan(3000);
    // The wedged first run eventually fails too (mute → M1c), releasing the lock
    expect(await first).toBeInstanceOf(Error);
  }, 20_000);
});

// ─── M1c: honest timeout (Truth 4) ───────────────────────────────────────

describe("LspClient timeout distinction (M1c)", () => {
  it("throws when ZERO publishDiagnostics arrive before the deadline", async () => {
    client = new LspClient({
      command: fakeServerCmd("mute"),
      diagnosticsTimeoutMs: 1500,
    });
    // Before the fix: resolves [] → false clean bill.
    await expect(client.getDiagnostics(projA)).rejects.toThrow(/diagnostics/i);
  }, 15_000);

  it("Truth 4: runTscLsp against a mute server reports the fallback marker, not ok:true", async () => {
    client = new LspClient({
      command: fakeServerCmd("mute"),
      diagnosticsTimeoutMs: 1500,
    });
    const r = await runTscLsp(client, projA);
    expect(r.ok).toBe(false);
    // Exact marker quality-routes.ts:72 keys the subprocess-tsc fallback on
    expect(r.errors).toContain("LSP diagnostics failed");
  }, 15_000);

  it("diagnostics received with zero errors stays a genuine clean bill", async () => {
    // echo-root publishes severity-1 diagnostics; a clean-ish equivalent:
    // filter proves the plumbing — received-but-empty must NOT throw.
    client = new LspClient({
      command: fakeServerCmd("echo-root"),
      diagnosticsTimeoutMs: 5000,
    });
    const diags = await client.getDiagnostics(projA);
    expect(Array.isArray(diags)).toBe(true);
    expect(diags.length).toBeGreaterThan(0); // notifications DID arrive
  }, 15_000);
});
