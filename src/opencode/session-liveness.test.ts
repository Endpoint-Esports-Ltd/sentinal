/**
 * session-liveness — OpenCode SDK active-sessions probe for the stop-guard.
 *
 * RED phase: fails until src/opencode/session-liveness.ts exists.
 *
 * Builds a LivenessProbe from the OpenCode SDK `client.session.list()`
 * (verified available on installed OpenCode 1.18.3). Fail-safe: returns null
 * when the SDK surface is absent/malformed so the caller falls back to the
 * MemoryStore. Never flips a decision to "allow" on error.
 */

import { describe, it, expect } from "bun:test";
import { buildLivenessProbe } from "./session-liveness.js";

const now = Date.now();

function client(sessions: Array<{ id: string; updated: number }>): unknown {
  return {
    session: {
      list: async () => ({
        data: sessions.map((s) => ({
          id: s.id,
          time: { created: s.updated, updated: s.updated },
        })),
      }),
    },
  };
}

describe("buildLivenessProbe", () => {
  it("returns null when client has no session.list (fall back to store)", async () => {
    const probe = await buildLivenessProbe({ client: {} as unknown });
    expect(probe).toBeNull();
  });

  it("returns null when client is undefined", async () => {
    const probe = await buildLivenessProbe({ client: undefined });
    expect(probe).toBeNull();
  });

  it("returns null when session.list rejects (fall back to store)", async () => {
    const bad = {
      session: {
        list: async () => {
          throw new Error("SDK error");
        },
      },
    };
    const probe = await buildLivenessProbe({ client: bad as unknown });
    expect(probe).toBeNull();
  });

  it("returns null when the payload is malformed (not an array)", async () => {
    const weird = { session: { list: async () => ({ data: "nope" }) } };
    const probe = await buildLivenessProbe({ client: weird as unknown });
    expect(probe).toBeNull();
  });

  it("probe reports a recently-updated session as alive", async () => {
    const probe = await buildLivenessProbe({
      client: client([{ id: "sess-A", updated: now - 60_000 }]) as unknown,
    });
    expect(probe).not.toBeNull();
    expect(probe!("sess-A")).toBe(true);
  });

  it("probe reports an unlisted session as NOT alive", async () => {
    const probe = await buildLivenessProbe({
      client: client([{ id: "sess-A", updated: now - 60_000 }]) as unknown,
    });
    expect(probe!("sess-B")).toBe(false);
  });

  it("probe reports a stale (old updated) session as NOT alive", async () => {
    const probe = await buildLivenessProbe({
      client: client([{ id: "sess-A", updated: now - 3 * 60 * 60 * 1000 }]) as unknown,
      windowMs: 45 * 60 * 1000,
    });
    expect(probe!("sess-A")).toBe(false);
  });
});
