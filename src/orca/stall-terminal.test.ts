import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_PATTERNS,
  HOME_SCREEN_SIGNATURES,
  authErrorInTail,
  mentionsDispatch,
  redactCapabilities,
  showsHomeScreen,
  terminalTail,
} from "./stall-terminal.js";
import type {
  OrcaTerminalCreateResult,
  OrcaTerminalReadResult,
  OrcaTerminalWaitResult,
  OrcaWorkerReadResult,
  OrcaWorkerShowResult,
} from "./types.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")).result as T;

/** Recorded live: the brief landed (its preamble is echoed on screen). */
const started = () =>
  load<OrcaWorkerReadResult>("worker-read-terminal-started.json");
/** Composite: the recorded screen of an OpenCode whose input was lost. */
const home = () => load<OrcaWorkerReadResult>("worker-read-terminal-home.json");
const DISPATCH = "ctx_c8a313c725e8";
const READ_LIMIT = 20;

describe("terminalTail", () => {
  it("returns the tail of a terminal-source read", () => {
    const tail = terminalTail(started());
    expect(Array.isArray(tail)).toBe(true);
    expect(tail!.length).toBeGreaterThan(0);
  });

  it("returns null for a transcript read or a read without a tail", () => {
    expect(
      terminalTail({
        dispatchId: "x",
        source: "transcript",
      } as OrcaWorkerReadResult),
    ).toBeNull();
    expect(
      terminalTail({
        dispatchId: "x",
        source: "terminal",
      } as OrcaWorkerReadResult),
    ).toBeNull();
    expect(terminalTail(null)).toBeNull();
  });
});

describe("mentionsDispatch", () => {
  it("finds the dispatch id in a tail whose brief landed", () => {
    expect(mentionsDispatch(terminalTail(started())!, DISPATCH)).toBe(true);
  });

  it("does not find it on the dropped-prompt home screen", () => {
    expect(mentionsDispatch(terminalTail(home())!, DISPATCH)).toBe(false);
  });

  it("matches an id wrapped across two terminal lines inside a box", () => {
    const tail = [
      "  ┃  --task-id task_1 --dispatch-id ctx_c8a3",
      "  ┃  13c725e8 --outcome",
    ];
    expect(mentionsDispatch(tail, DISPATCH)).toBe(true);
  });

  it("never matches an empty id", () => {
    expect(mentionsDispatch(["anything"], "")).toBe(false);
  });
});

describe("showsHomeScreen", () => {
  it("recognises OpenCode's empty home screen", () => {
    expect(showsHomeScreen(terminalTail(home())!)).toBe(true);
  });

  it("does not flag a tail where a conversation is under way", () => {
    expect(showsHomeScreen(terminalTail(started())!)).toBe(false);
  });

  it("still sees the home screen in the last READ_LIMIT lines (Pre-Mortem 1)", () => {
    const tail = terminalTail(home())!;
    expect(tail.length).toBeLessThanOrEqual(READ_LIMIT);
    expect(showsHomeScreen(tail.slice(-READ_LIMIT))).toBe(true);
  });

  it("does not flag a working worker whose output merely quotes the placeholder (review should_fix)", () => {
    // e.g. an agent reading this very module or its fixtures
    const tail = [
      "  ┃  $ rg -n 'Ask anything' src/orca",
      "  ┃  src/orca/stall-terminal.ts:33:  pattern: /Ask anything/",
      '  "  ┃  Ask anything… \\"What is the tech stack\\"",',
      "  ┃  Build · Claude Opus 5.5 Anthropic",
    ];
    expect(showsHomeScreen(tail)).toBe(false);
  });

  it("needs the splash logo as well as the framed placeholder", () => {
    const tail = terminalTail(home())!;
    const noLogo = tail.filter((l) => !/█▀▀█/.test(l) && !/▀▀▀▀ █▀▀▀/.test(l));
    expect(showsHomeScreen(noLogo)).toBe(false);
    const noPlaceholder = tail.filter((l) => !l.includes("Ask anything"));
    expect(showsHomeScreen(noPlaceholder)).toBe(false);
  });

  it("carries one verified signature per agent", () => {
    expect(HOME_SCREEN_SIGNATURES.map((s) => s.agent)).toEqual(["opencode"]);
  });
});

describe("redactCapabilities", () => {
  it("replaces every capability token", () => {
    const s = "--dispatch-capability dcap_FAKE-token_1 then dcap_ABC123 end";
    const out = redactCapabilities(s);
    expect(out).toBe(
      "--dispatch-capability dcap_REDACTED then dcap_REDACTED end",
    );
    expect(out.match(/dcap_[A-Za-z0-9_-]+/g)).toEqual([
      "dcap_REDACTED",
      "dcap_REDACTED",
    ]);
  });
});

describe("authErrorInTail", () => {
  it("returns the redacted matching line for a login failure", () => {
    const line = authErrorInTail([
      "  ┃  $ orca orchestration send --dispatch-capability dcap_secret123",
      "  API Error: 401 Please run /login dcap_secret456",
    ]);
    expect(line).not.toBeNull();
    expect(line).toContain("401");
    expect(line).not.toContain("secret");
  });

  it("ignores a loose '401 Unauthorized' (test output, code) — provider phrasing only", () => {
    expect(
      authErrorInTail([
        "  ┃  expect(res.status).toBe(401) // 401 Unauthorized token",
        "  ┃  Build · Claude Opus 5.5 Anthropic",
      ]),
    ).toBeNull();
  });

  it("only judges the bottom of the tail, like the transcript's final turn", () => {
    const far = [
      "  ┃  API Error: 401 Please run /login",
      ...Array.from({ length: 12 }, (_, i) => `  ┃  working on step ${i}`),
    ];
    expect(authErrorInTail(far)).toBeNull();
    expect(
      authErrorInTail([...far, "  ┃  API Error: 401 Please run /login"]),
    ).not.toBeNull();
  });

  it("returns null when no auth pattern matches", () => {
    expect(authErrorInTail(terminalTail(started())!)).toBeNull();
    expect(AUTH_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("real 1.4.209 dropped prompt (issue #12, unverifiable liveness)", () => {
  const read = () =>
    load<OrcaWorkerReadResult>("worker-read-terminal-home-unverifiable.json");

  it("shows the home screen and never the dispatch id", () => {
    const tail = terminalTail(read())!;
    expect(showsHomeScreen(tail)).toBe(true);
    expect(mentionsDispatch(tail, "ctx_d209000000a1")).toBe(false);
  });

  it("carries the terminal's own live status and handle, and an unverifiable projection", () => {
    const r = read();
    expect(r.status?.liveness).toBe("live");
    expect(r.terminal?.handle).toBe("term_d209-worker");
    expect(r.fallbackReason).toBe("session_not_reported");
    const s = load<OrcaWorkerShowResult>("worker-show-unverifiable-209.json");
    expect(s.dispatch.assigneeHandle).toBe("term_d209-worker");
    expect(s.worker?.agentTerminalHandle).toBe("term_d209-worker");
    expect(s.observation).toBeUndefined();
  });
});

describe("worker-show fixture", () => {
  it("is a dispatched dispatch with no heartbeat and a zone-less UTC dispatchedAt", () => {
    const s = load<OrcaWorkerShowResult>("worker-show-dispatched.json");
    expect(s.dispatch.id).toBe(DISPATCH);
    expect(s.dispatch.status).toBe("dispatched");
    expect(s.dispatch.lastHeartbeatAt).toBeNull();
    expect(s.dispatch.dispatchedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});

describe("terminal-read fixtures (pre-warm readiness signal)", () => {
  const tailOf = (name: string): string[] =>
    load<OrcaTerminalReadResult>(name).terminal.tail ?? [];

  it("recognises the drawn input box on a real home screen and on the wide 160-column d11 screen", () => {
    expect(showsHomeScreen(tailOf("terminal-read-home.json"))).toBe(true);
    const wide = terminalTail(
      load<OrcaWorkerReadResult>("worker-read-d11-wide.json"),
    )!;
    expect(showsHomeScreen(wide)).toBe(true);
  });

  it("does not see the home screen once a conversation is on screen", () => {
    expect(showsHomeScreen(tailOf("terminal-read-conversation.json"))).toBe(
      false,
    );
  });

  it("reads the created handle and the tui-idle verdict from the real captures", () => {
    const c = load<OrcaTerminalCreateResult>("terminal-create.json");
    expect(c.terminal.handle).toMatch(/^term_/);
    const w = load<OrcaTerminalWaitResult>("terminal-wait-tui-idle.json");
    expect(w.wait.satisfied).toBe(true);
  });
});
