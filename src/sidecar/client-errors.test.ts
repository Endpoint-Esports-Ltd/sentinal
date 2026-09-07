/**
 * Tests for sidecar failure classification (issue #9).
 *
 * The bug: `enrich()` in client.ts hardcoded the word "unreachable" into EVERY
 * fetch rejection, including a client-side read TIMEOUT. A destructive
 * `worktree_cleanup` that had FULLY SUCCEEDED server-side reported
 *
 *   POST /worktree/cleanup failed: sidecar at unix:~/.sentinal/sidecar.sock
 *   unreachable — The operation timed out. (23)
 *
 * ...which reads as "it did not run", so the caller retried a destructive
 * operation. The distinction already existed in `fetchWithReconnect`
 * (`err.name === "TimeoutError"`, used to refuse a retry precisely BECAUSE the
 * request may have reached the server) — it was simply discarded at format
 * time.
 */

import { describe, it, expect } from "bun:test";
import {
  classifySidecarFailure,
  isTimeoutFailure,
  DESTRUCTIVE_PATHS,
} from "./client-errors.js";

/**
 * The real rejection Bun produces for `AbortSignal.timeout`. Verified against
 * Bun directly: a DOMException with name "TimeoutError", message "The operation
 * timed out." and legacy `code` 23 (DOMException.TIMEOUT_ERR) — which is
 * exactly the "(23)" in the reported error string.
 */
function timeoutError(): Error {
  return new DOMException("The operation timed out.", "TimeoutError");
}

/** A genuine connection failure — the socket is not there at all. */
function connectError(): Error {
  const e = new Error(
    "Unable to connect. Is the computer able to access the url?",
  );
  (e as unknown as { code: string }).code = "ConnectionRefused";
  return e;
}

describe("isTimeoutFailure", () => {
  it("should identify a TimeoutError", () => {
    expect(isTimeoutFailure(timeoutError())).toBe(true);
  });

  it("should not identify a connection failure as a timeout", () => {
    expect(isTimeoutFailure(connectError())).toBe(false);
  });

  it("should not throw on non-Error values", () => {
    expect(isTimeoutFailure("boom")).toBe(false);
    expect(isTimeoutFailure(null)).toBe(false);
    expect(isTimeoutFailure(undefined)).toBe(false);
  });
});

describe("classifySidecarFailure — timeout branch (the bug)", () => {
  const target = "unix:/Users/x/.sentinal/sidecar.sock";

  it("should NOT claim the sidecar is unreachable on a timeout", () => {
    const err = classifySidecarFailure(
      timeoutError(),
      "POST",
      "/worktree/cleanup",
      target,
      30_000,
    );
    expect(err.message).not.toMatch(/unreachable/i);
  });

  it("should state the outcome is unknown and may still be running", () => {
    const err = classifySidecarFailure(
      timeoutError(),
      "POST",
      "/worktree/cleanup",
      target,
      30_000,
    );
    expect(err.message).toMatch(/may still be running/i);
    expect(err.message).toMatch(/unknown/i);
  });

  it("should name the elapsed budget so the caller can size it", () => {
    const err = classifySidecarFailure(
      timeoutError(),
      "POST",
      "/worktree/cleanup",
      target,
      30_000,
    );
    expect(err.message).toContain("30000ms");
  });

  it("should name the env var that raises the budget", () => {
    const err = classifySidecarFailure(
      timeoutError(),
      "POST",
      "/worktree/cleanup",
      target,
      30_000,
    );
    expect(err.message).toContain("SENTINAL_SIDECAR_TIMEOUT_MS");
  });

  it("should still identify the method, path and target", () => {
    const err = classifySidecarFailure(
      timeoutError(),
      "POST",
      "/worktree/cleanup",
      target,
      30_000,
    );
    expect(err.message).toContain("POST /worktree/cleanup");
    expect(err.message).toContain(target);
  });

  it("should tell a DESTRUCTIVE caller to reconcile before retrying", () => {
    for (const path of DESTRUCTIVE_PATHS) {
      const err = classifySidecarFailure(
        timeoutError(),
        "POST",
        path,
        target,
        30_000,
      );
      expect(err.message).toContain("git worktree list");
      expect(err.message).toMatch(/before retrying/i);
    }
  });

  it("should NOT tell a read-only caller to reconcile git state", () => {
    // /context is read-only — a retry is harmless and the git advice is noise.
    const err = classifySidecarFailure(
      timeoutError(),
      "GET",
      "/context",
      target,
      30_000,
    );
    expect(err.message).not.toContain("git worktree list");
    // ...but it must STILL not claim the sidecar was unreachable.
    expect(err.message).not.toMatch(/unreachable/i);
  });
});

describe("classifySidecarFailure — connect branch (preservation)", () => {
  const target = "unix:/Users/x/.sentinal/sidecar.sock";

  it("should preserve the existing 'unreachable' wording verbatim", () => {
    const err = classifySidecarFailure(
      connectError(),
      "POST",
      "/observation",
      target,
      2_000,
    );
    // This is the exact shape src/sidecar/client.test.ts:625-627 asserts.
    expect(err.message).toMatch(/POST \/observation failed: .*unreachable/);
    expect(err.message).toBe(
      `POST /observation failed: sidecar at ${target} unreachable — ` +
        `Unable to connect. Is the computer able to access the url? (ConnectionRefused)`,
    );
  });

  it("should preserve the error code suffix when present", () => {
    const err = classifySidecarFailure(
      connectError(),
      "GET",
      "/ping",
      target,
      2_000,
    );
    expect(err.message).toContain("(ConnectionRefused)");
  });

  it("should omit the code suffix when the error carries none", () => {
    const err = classifySidecarFailure(
      new Error("socket hang up"),
      "GET",
      "/ping",
      target,
      2_000,
    );
    expect(err.message).toBe(
      `GET /ping failed: sidecar at ${target} unreachable — socket hang up`,
    );
  });

  it("should stringify non-Error rejections", () => {
    const err = classifySidecarFailure("boom", "GET", "/ping", target, 2_000);
    expect(err.message).toContain("boom");
    expect(err.message).toContain("unreachable");
  });
});
