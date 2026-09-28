import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { agentAuth, detectOrca, ORCA_CONTRACT_CAPABILITY } from "./detect.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const HANDLE = "term_66fae77e-858c-4ad2-a392-99ab04b4cd13";

/** Replays a canned output per first argument. Never spawns the real `orca`. */
function fakeRunner(byCommand: Record<string, OrcaRunOutput | Error>) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const r = byCommand[args[0]];
    if (!r) throw new Error(`unexpected orca call: ${args.join(" ")}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { runner, calls };
}

const ok = (stdout: string): OrcaRunOutput => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

function statusWith(mutate: (s: any) => void): OrcaRunOutput {
  const s = JSON.parse(fixture("status-ready.json"));
  mutate(s);
  return ok(JSON.stringify(s));
}

describe("detectOrca", () => {
  it("is available on the recorded ready status inside an Orca terminal", async () => {
    const { runner, calls } = fakeRunner({
      status: ok(fixture("status-ready.json")),
    });
    const d = await detectOrca({
      env: { ORCA_TERMINAL_HANDLE: HANDLE },
      runner,
    });
    expect(d.available).toBe(true);
    expect(d.reason).toBe("ready");
    expect(d.terminalHandle).toBe(HANDLE);
    expect(d.appVersion).toBe("1.4.215");
    expect(d.capabilities).toContain(ORCA_CONTRACT_CAPABILITY);
    expect(calls).toEqual([["status", "--json"]]);
  });

  it("is unavailable without ORCA_TERMINAL_HANDLE and does not run orca at all", async () => {
    for (const env of [{}, { ORCA_TERMINAL_HANDLE: "   " }]) {
      const { runner, calls } = fakeRunner({});
      const d = await detectOrca({ env, runner });
      expect(d.available).toBe(false);
      expect(d.reason).toBe("no-terminal-handle");
      expect(d.terminalHandle).toBeNull();
      expect(d.detail).toContain("ORCA_TERMINAL_HANDLE");
      expect(calls).toEqual([]);
    }
  });

  it("is unavailable when the runtime is not ready", async () => {
    const { runner } = fakeRunner({
      status: statusWith((s) => (s.result.runtime.state = "starting")),
    });
    const d = await detectOrca({
      env: { ORCA_TERMINAL_HANDLE: HANDLE },
      runner,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toBe("runtime-not-ready");
    expect(d.detail).toContain("starting");
    expect(d.terminalHandle).toBe(HANDLE);
  });

  it("is unavailable when the runtime is unreachable", async () => {
    const { runner } = fakeRunner({
      status: statusWith((s) => (s.result.runtime.reachable = false)),
    });
    const d = await detectOrca({
      env: { ORCA_TERMINAL_HANDLE: HANDLE },
      runner,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toBe("runtime-unreachable");
  });

  it("is unavailable without the orchestration contract capability", async () => {
    const { runner } = fakeRunner({
      status: statusWith(
        (s) =>
          (s.result.runtime.capabilities = s.result.runtime.capabilities.filter(
            (c: string) => c !== ORCA_CONTRACT_CAPABILITY,
          )),
      ),
    });
    const d = await detectOrca({
      env: { ORCA_TERMINAL_HANDLE: HANDLE },
      runner,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toBe("missing-capability");
    expect(d.appVersion).toBe("1.4.215");
    expect(d.detail).toContain(ORCA_CONTRACT_CAPABILITY);
  });

  it("is unavailable when orca cannot run", async () => {
    const { runner } = fakeRunner({ status: new Error("spawn orca ENOENT") });
    const d = await detectOrca({
      env: { ORCA_TERMINAL_HANDLE: HANDLE },
      runner,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toBe("orca-unavailable");
    expect(d.detail).toContain("ENOENT");
  });

  it("is unavailable when status returns an error envelope", async () => {
    const { runner } = fakeRunner({
      status: {
        exitCode: 1,
        stdout: fixture("unknown-command.json"),
        stderr: "",
      },
    });
    const d = await detectOrca({
      env: { ORCA_TERMINAL_HANDLE: HANDLE },
      runner,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toBe("orca-unavailable");
    expect(d.detail).toContain("invalid_argument");
  });
});

describe("agentAuth", () => {
  it("claude with failureKind stale-token → stale-token (spike S4 host state)", async () => {
    const { runner, calls } = fakeRunner({
      account: ok(fixture("account-list-stale-token.json")),
    });
    const a = await agentAuth("claude", { runner });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("stale-token");
    expect(a.detail).toContain("/login");
    expect(calls).toEqual([["account", "list", "--json"]]);
  });

  it("claude with status error + failureKind rate-limited (recorded) → not ok, reports the kind", async () => {
    const { runner } = fakeRunner({
      account: ok(fixture("account-list-rate-limited.json")),
    });
    const a = await agentAuth("claude", { runner });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("rate-limited");
    if (a.ok) throw new Error("unreachable");
    expect(a.retryAtMs).toBe(1790622220112);
  });

  it("claude with status error and no failureKind → stale-token", async () => {
    const acct = JSON.parse(fixture("account-list-rate-limited.json"));
    delete acct.result.rateLimits.claude.usageMetadata;
    const { runner } = fakeRunner({ account: ok(JSON.stringify(acct)) });
    const a = await agentAuth("claude", { runner });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("stale-token");
  });

  it("a failureKind alone (status not error) is enough to refuse", async () => {
    const acct = JSON.parse(fixture("account-list-rate-limited.json"));
    acct.result.rateLimits.codex.usageMetadata = { failureKind: "stale-token" };
    const { runner } = fakeRunner({ account: ok(JSON.stringify(acct)) });
    const a = await agentAuth("codex", { runner });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("stale-token");
  });

  it("claude healthy → ok", async () => {
    const acct = JSON.parse(fixture("account-list-rate-limited.json"));
    acct.result.rateLimits.claude = {
      provider: "claude",
      status: "ok",
      error: null,
    };
    const { runner } = fakeRunner({ account: ok(JSON.stringify(acct)) });
    const a = await agentAuth("claude", { runner });
    expect(a).toMatchObject({
      ok: true,
      reason: "ok",
      agent: "claude",
      status: "ok",
    });
  });

  it("codex unavailable without a failureKind (recorded) → ok, status passed through", async () => {
    const { runner } = fakeRunner({
      account: ok(fixture("account-list-rate-limited.json")),
    });
    const a = await agentAuth("codex", { runner });
    expect(a).toMatchObject({ ok: true, reason: "ok", status: "unavailable" });
  });

  it("opencode and other agents are not managed by Orca — no orca call", async () => {
    for (const agent of ["opencode", "cursor", "gemini"]) {
      const { runner, calls } = fakeRunner({});
      const a = await agentAuth(agent, { runner });
      expect(a).toEqual({ ok: true, agent, reason: "not-managed-by-orca" });
      expect(calls).toEqual([]);
    }
  });

  it("fails open with reason unknown when account list cannot be read", async () => {
    const { runner } = fakeRunner({ account: new Error("spawn orca ENOENT") });
    const a = await agentAuth("claude", { runner });
    expect(a.ok).toBe(true);
    expect(a.reason).toBe("unknown");
    expect(a.detail).toContain("ENOENT");
  });

  it("fails open with reason unknown when the agent has no rateLimits entry", async () => {
    const acct = JSON.parse(fixture("account-list-rate-limited.json"));
    delete acct.result.rateLimits.claude;
    const { runner } = fakeRunner({ account: ok(JSON.stringify(acct)) });
    const a = await agentAuth("claude", { runner });
    expect(a).toMatchObject({ ok: true, reason: "unknown" });
  });

  it("matches the agent id case-insensitively", async () => {
    const { runner } = fakeRunner({
      account: ok(fixture("account-list-stale-token.json")),
    });
    const a = await agentAuth("Claude", { runner });
    expect(a.ok).toBe(false);
    expect(a.agent).toBe("claude");
  });
});
