/**
 * Orca-precedence liveness + the never-started evidence/attention helpers
 * (docs/plans/2026-09-30-orca-unverifiable-never-started.md, Task 2).
 * Fixtures only — never the real `orca`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GAP_REASONS,
  neverStartedEvidence,
  ownTerminalLive,
  resolveLiveness,
  unverifiableAttention,
} from "./stall-liveness.js";
import { terminalTail } from "./stall-terminal.js";
import type {
  OrcaWorkerListRow,
  OrcaWorkerReadResult,
  OrcaWorkerShowResult,
} from "./types.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")).result as T;

const D = "ctx_d209000000a1";
const read209 = () =>
  load<OrcaWorkerReadResult>("worker-read-terminal-home-unverifiable.json");
const show209 = () =>
  load<OrcaWorkerShowResult>("worker-show-unverifiable-209.json");
const AT = Date.parse("2026-09-29T23:11:43Z");
const MIN = 60_000;

function row(verdict: string, reason?: string): OrcaWorkerListRow {
  return {
    dispatchId: D,
    taskId: "task_d209000000a1",
    projection: {
      outcome: "in_progress",
      liveness: { verdict, ...(reason ? { reason } : {}) },
      attention: { categories: ["unverifiable"], requiresAction: true },
    },
  };
}

function showWith(verdict: string, reason?: string): OrcaWorkerShowResult {
  const s = show209();
  s.projection = {
    ...s.projection,
    liveness: { verdict, ...(reason ? { reason } : {}) },
  };
  return s;
}

describe("resolveLiveness", () => {
  it("uses the list verdict when it is live or exited", () => {
    expect(resolveLiveness({ row: row("live") }).verdict).toBe("live");
    expect(resolveLiveness({ row: row("exited") })).toMatchObject({
      verdict: "exited",
      source: "list",
    });
  });

  it("lets worker-show outrank a client-gap unverifiable row (Orca's guide)", () => {
    for (const reason of GAP_REASONS) {
      expect(
        resolveLiveness({
          row: row("unverifiable", reason),
          show: showWith("live"),
        }),
      ).toMatchObject({ verdict: "live", source: "worker-show" });
      expect(
        resolveLiveness({
          row: row("unverifiable", reason),
          show: showWith("exited"),
        }),
      ).toMatchObject({ verdict: "exited", source: "worker-show" });
    }
  });

  it("never lets worker-show outrank host_unavailable (contact loss)", () => {
    const r = resolveLiveness({
      row: row("unverifiable", "host_unavailable"),
      show: showWith("exited"),
    });
    expect(r.verdict).toBe("absent");
    expect(GAP_REASONS).not.toContain("host_unavailable");
  });

  it("stays absent when both are unverifiable (the 1.4.209 case)", () => {
    expect(
      resolveLiveness({
        row: row("unverifiable", "missing_status"),
        read: read209(),
        show: show209(),
      }),
    ).toMatchObject({ verdict: "absent", reason: "missing_status" });
  });

  it("falls back to the read's projection without a list row", () => {
    expect(resolveLiveness({ read: read209() })).toMatchObject({
      verdict: "absent",
      reason: "missing_status",
    });
  });
});

describe("ownTerminalLive", () => {
  it("accepts the real 1.4.209 fields: read status live + matching handle", () => {
    expect(ownTerminalLive({ read: read209(), show: show209() })).toBe(true);
  });

  it("refuses a handle mismatch or a non-live terminal", () => {
    const r = read209();
    r.terminal = { ...r.terminal, handle: "term_other" };
    expect(ownTerminalLive({ read: r, show: show209() })).toBe(false);
    const r2 = read209();
    r2.status = { ...r2.status, liveness: "exited" };
    expect(ownTerminalLive({ read: r2, show: show209() })).toBe(false);
  });

  it("accepts worker-show observation live + exactWorker, and nothing weaker", () => {
    const s = show209();
    s.observation = { status: "live", exactWorker: true };
    expect(ownTerminalLive({ read: null, show: s })).toBe(true);
    s.observation = { status: "live", exactWorker: false };
    expect(ownTerminalLive({ read: null, show: s })).toBe(false);
  });
});

describe("neverStartedEvidence", () => {
  const tail = () => terminalTail(read209())!;

  it("holds for the real dropped prompt past the threshold", () => {
    const e = neverStartedEvidence({
      tail: tail(),
      dispatchId: D,
      show: show209(),
      now: AT + 4 * MIN,
    });
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.evidence).toContain("240 s");
  });

  it("fails with the reason for each missing condition", () => {
    expect(
      neverStartedEvidence({
        tail: tail(),
        dispatchId: D,
        show: show209(),
        now: AT + 2 * MIN,
      }).ok,
    ).toBe(false);
    const hb = show209();
    hb.dispatch.lastHeartbeatAt = "2026-09-29 23:12:00";
    expect(
      neverStartedEvidence({
        tail: tail(),
        dispatchId: D,
        show: hb,
        now: AT + 4 * MIN,
      }).ok,
    ).toBe(false);
    expect(
      neverStartedEvidence({
        tail: [...tail(), `  ┃  --dispatch-id ${D}`],
        dispatchId: D,
        show: show209(),
        now: AT + 4 * MIN,
      }).ok,
    ).toBe(false);
    expect(
      neverStartedEvidence({
        tail: ["  ┃  working…"],
        dispatchId: D,
        show: show209(),
        now: AT + 4 * MIN,
      }).ok,
    ).toBe(false);
    expect(
      neverStartedEvidence({
        tail: tail(),
        dispatchId: D,
        show: null,
        now: AT + 4 * MIN,
      }).ok,
    ).toBe(false);
  });
});

describe("unverifiableAttention", () => {
  const base = () => ({
    row: row("unverifiable", "missing_status"),
    read: read209(),
    show: show209(),
    now: AT + 4 * MIN,
  });

  it("reports the real 1.4.209 dropped prompt as never-started-unverifiable", () => {
    const a = unverifiableAttention(base());
    expect(a).toMatchObject({
      kind: "never-started-unverifiable",
      dispatchId: D,
      taskId: "task_d209000000a1",
    });
    expect(a!.evidence).toContain("missing_status");
    expect(a!.evidence).toContain("own terminal");
    expect(a).not.toHaveProperty("evidenceId");
  });

  it("reports nothing for host_unavailable, a live verdict, or a young dispatch", () => {
    expect(
      unverifiableAttention({
        ...base(),
        row: row("unverifiable", "host_unavailable"),
      }),
    ).toBeNull();
    expect(unverifiableAttention({ ...base(), row: row("live") })).toBeNull();
    expect(unverifiableAttention({ ...base(), now: AT + MIN })).toBeNull();
  });
});

describe("real #13 d11 stall-time capture (Orca 1.4.209, wide screen)", () => {
  const read = () => load<OrcaWorkerReadResult>("worker-read-d11-wide.json");
  const show = () => load<OrcaWorkerShowResult>("worker-show-d11-stall.json");
  const at = Date.parse("2026-09-30T17:40:00Z");

  it("ties the live terminal to the dispatch through observation AND through read status + handle", () => {
    expect(ownTerminalLive({ read: null, show: show() })).toBe(true);
    const s = show();
    delete s.observation;
    expect(ownTerminalLive({ read: read(), show: s })).toBe(true);
  });

  it("raises never-started-unverifiable at +4 min, not at +1 min", () => {
    const row: OrcaWorkerListRow = {
      dispatchId: "ctx_d130000000b1",
      taskId: "task_d130000000b1",
      projection: {
        outcome: "in_progress",
        liveness: { verdict: "unverifiable", reason: "missing_status" },
        attention: { categories: ["unverifiable"], requiresAction: true },
      },
    };
    expect(
      unverifiableAttention({
        row,
        read: read(),
        show: show(),
        now: at + 4 * MIN,
      })?.kind,
    ).toBe("never-started-unverifiable");
    expect(
      unverifiableAttention({ row, read: read(), show: show(), now: at + MIN }),
    ).toBeNull();
  });
});
