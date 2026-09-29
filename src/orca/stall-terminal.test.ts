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
import type { OrcaWorkerReadResult, OrcaWorkerShowResult } from "./types.js";

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

describe("worker-show fixture", () => {
  it("is a dispatched dispatch with no heartbeat and a zone-less UTC dispatchedAt", () => {
    const s = load<OrcaWorkerShowResult>("worker-show-dispatched.json");
    expect(s.dispatch.id).toBe(DISPATCH);
    expect(s.dispatch.status).toBe("dispatched");
    expect(s.dispatch.lastHeartbeatAt).toBeNull();
    expect(s.dispatch.dispatchedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});
