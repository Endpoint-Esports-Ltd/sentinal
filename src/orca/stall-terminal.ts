/**
 * Terminal-tail analysis for stall detection (issue #12).
 *
 * When Orca has no provider transcript for a worker (OpenCode on 1.4.216:
 * `fallbackReason: "provider_unsupported"`), `worker-read --source auto`
 * returns the bounded terminal tail instead. These pure helpers read that
 * tail for POSITIVE evidence only:
 *   - the agent's empty home screen (a conversation never began);
 *   - whether the dispatch id was ever echoed (the brief's preamble names it);
 *   - an auth failure printed on screen.
 *
 * ⛔ The echoed preamble carries the dispatch capability (`dcap_…`), a
 * secret. Every string that leaves this module goes through
 * `redactCapabilities`.
 */

import type { OrcaWorkerReadResult } from "./types.js";

/** Login failures, shared by the transcript and terminal-tail paths. */
export const AUTH_PATTERNS: readonly RegExp[] = [
  /please run \/login/i,
  /oauth access token is invalid/i,
  /\bnot logged in\b/i,
  /\bAPI Error:?\s*401\b/i,
  /\b401\b[^\n]{0,40}\b(unauthori[sz]ed|oauth|token|auth\w*)/i,
];

/**
 * The loose, final-turn-free auth phrasing (`401 … token`) is left out on
 * purpose: a terminal tail also shows test output and code, so only the
 * provider's own wording counts there.
 */
const TAIL_AUTH_PATTERNS: readonly RegExp[] = AUTH_PATTERNS.slice(0, 4);
/** The tail's last N non-blank lines stand in for the transcript's final turn. */
const TAIL_AUTH_WINDOW = 8;

/**
 * An agent's empty home screen: visible only while no conversation exists.
 * Only signatures observed live belong here (OpenCode 1.18.33, 2026-09-29).
 * EVERY pattern must match some line, each anchored at the line start, so a
 * working agent that merely prints or quotes the placeholder (code, grep
 * output, a JSON fixture) is never taken for the home screen.
 */
export const HOME_SCREEN_SIGNATURES: ReadonlyArray<{
  agent: string;
  patterns: readonly RegExp[];
}> = [
  {
    agent: "opencode",
    patterns: [
      /^\s*█▀▀█ █▀▀█ █▀▀█ █▀▀▄/, // the splash logo's top row
      /^\s*┃\s+Ask anything…/, // the input box's placeholder
    ],
  },
];

const CAPABILITY = /dcap_[A-Za-z0-9_-]+/g;
/** Whitespace and the box-drawing characters TUIs frame their input with. */
const FRAME = /[\s┃╹│╻┆┊]+/g;
const CLIP = 160;

/** The terminal tail of a terminal-source read, else `null`. */
export function terminalTail(
  read: OrcaWorkerReadResult | null | undefined,
): string[] | null {
  if (!read || read.source !== "terminal") return null;
  const tail = read.terminal?.tail;
  return Array.isArray(tail) ? tail.filter((l) => typeof l === "string") : null;
}

export function redactCapabilities(s: string): string {
  return s.replace(CAPABILITY, "dcap_REDACTED");
}

export function showsHomeScreen(tail: readonly string[]): boolean {
  return HOME_SCREEN_SIGNATURES.some((s) =>
    s.patterns.every((p) => tail.some((line) => p.test(line))),
  );
}

/**
 * Was the dispatch id ever echoed? Joins the tail without whitespace or box
 * characters, so an id the terminal wrapped across two lines still matches.
 */
export function mentionsDispatch(
  tail: readonly string[],
  dispatchId: string,
): boolean {
  if (!dispatchId) return false;
  return tail.join("").replace(FRAME, "").includes(dispatchId);
}

/**
 * An auth failure in the bottom of the tail (the terminal's "final turn"),
 * in the provider's own phrasing — redacted and clipped.
 */
export function authErrorInTail(tail: readonly string[]): string | null {
  const bottom = tail.filter((l) => l.trim() !== "").slice(-TAIL_AUTH_WINDOW);
  const line = bottom.find((l) => TAIL_AUTH_PATTERNS.some((p) => p.test(l)));
  if (line === undefined) return null;
  const t = redactCapabilities(line).replace(/\s+/g, " ").trim();
  return t.length > CLIP ? `${t.slice(0, CLIP)}…` : t;
}
