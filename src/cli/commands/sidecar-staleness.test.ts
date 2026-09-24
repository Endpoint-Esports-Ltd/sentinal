import { describe, expect, it, afterEach, spyOn, mock } from "bun:test";
import {
  warnIfSidecarStale,
  formatStaleSidecarWarning,
} from "./sidecar-staleness.js";
import { SidecarClient } from "../../sidecar/client.js";
import * as lifecycleStart from "../../sidecar/lifecycle-start.js";

type Health = { status: string; pid: number; version?: string };

function fakeConnect(health: Health | (() => Promise<Health>)) {
  let connects = 0;
  const connect = async () => {
    connects++;
    return {
      health: typeof health === "function" ? health : async () => health,
    };
  };
  return { connect, count: () => connects };
}

describe("warnIfSidecarStale", () => {
  afterEach(() => mock.restore());

  it("prints exactly one line naming both versions when the sidecar is stale", async () => {
    const lines: string[] = [];
    const { connect } = fakeConnect({
      status: "ok",
      pid: 1,
      version: "1.37.1",
    });

    const printed = await warnIfSidecarStale("1.38.0", {
      connect,
      log: (l) => lines.push(l),
    });

    expect(lines).toEqual([
      "Running sidecar is v1.37.1 (installed v1.38.0). It will retire when no sessions are active, or run 'sentinal sidecar restart' to switch now.",
    ]);
    expect(printed).toBe(lines[0]!);
    expect(lines[0]).not.toContain("\n");
  });

  it("is silent when the sidecar reports the same version", async () => {
    const lines: string[] = [];
    const { connect } = fakeConnect({
      status: "ok",
      pid: 1,
      version: "1.38.0",
    });

    const printed = await warnIfSidecarStale("1.38.0", {
      connect,
      log: (l) => lines.push(l),
    });

    expect(printed).toBeNull();
    expect(lines).toEqual([]);
  });

  it("is silent when no sidecar is running", async () => {
    const lines: string[] = [];
    const printed = await warnIfSidecarStale("1.38.0", {
      connect: async () => null,
      log: (l) => lines.push(l),
    });

    expect(printed).toBeNull();
    expect(lines).toEqual([]);
  });

  it("is silent when the sidecar reports no version (pre-M2c)", async () => {
    const lines: string[] = [];
    const { connect } = fakeConnect({ status: "ok", pid: 1 });

    const printed = await warnIfSidecarStale("1.38.0", {
      connect,
      log: (l) => lines.push(l),
    });

    expect(printed).toBeNull();
    expect(lines).toEqual([]);
  });

  it("never throws when connect or health fails", async () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);

    expect(
      await warnIfSidecarStale("1.38.0", {
        connect: async () => {
          throw new Error("boom");
        },
        log,
      }),
    ).toBeNull();

    const { connect } = fakeConnect(async () => {
      throw new Error("health down");
    });
    expect(await warnIfSidecarStale("1.38.0", { connect, log })).toBeNull();
    expect(lines).toEqual([]);
  });

  it("gives up silently when health() hangs", async () => {
    const lines: string[] = [];
    const { connect } = fakeConnect(() => new Promise<Health>(() => {}));

    const printed = await warnIfSidecarStale("1.38.0", {
      connect,
      log: (l) => lines.push(l),
      timeoutMs: 20,
    });

    expect(printed).toBeNull();
    expect(lines).toEqual([]);
  });

  it("defaults to SidecarClient.connect() and never retries or autostarts", async () => {
    const connectSpy = spyOn(SidecarClient, "connect").mockResolvedValue(null);
    const retrySpy = spyOn(SidecarClient, "connectWithRetry").mockResolvedValue(
      null,
    );
    const autoStartSpy = spyOn(
      lifecycleStart,
      "autoStartSidecar",
    ).mockImplementation(() => {});

    const printed = await warnIfSidecarStale("1.38.0", { log: () => {} });

    expect(printed).toBeNull();
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).not.toHaveBeenCalled();
    expect(autoStartSpy).not.toHaveBeenCalled();
  });
});

describe("formatStaleSidecarWarning", () => {
  it("advises the (background) restart command", () => {
    expect(formatStaleSidecarWarning("1.0.0", "2.0.0")).toBe(
      "Running sidecar is v1.0.0 (installed v2.0.0). It will retire when no sessions are active, or run 'sentinal sidecar restart' to switch now.",
    );
  });
});
