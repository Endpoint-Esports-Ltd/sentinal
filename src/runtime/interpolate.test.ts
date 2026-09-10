/**
 * Closed `${SENTINAL_*}` namespace tests (Phase 3, Task 2 — D6 narrowed).
 *
 * The load-bearing assertions are the ones about what is NOT touched: `up` and
 * `down` are shell command strings, so anything outside Sentinal's own prefix
 * must survive verbatim.
 */

import { describe, it, expect } from "bun:test";
import {
  interpolateStrict,
  unknownSentinalTokens,
  unknownTokenMessage,
  SLOT_TOKEN,
  SENTINAL_TOKENS,
  INTERPOLATED_FIELDS,
} from "./interpolate.js";

describe("closed namespace", () => {
  it("is exactly one token", () => {
    expect(SLOT_TOKEN).toBe("SENTINAL_WORKTREE_SLOT");
    expect([...SENTINAL_TOKENS]).toEqual(["SENTINAL_WORKTREE_SLOT"]);
  });

  it("interpolates exactly up, down and readiness.target", () => {
    expect([...INTERPOLATED_FIELDS]).toEqual(["up", "down", "readiness.target"]);
  });
});

describe("unknownSentinalTokens", () => {
  it("returns the offending tokens with their braces, in order", () => {
    expect(
      unknownSentinalTokens(
        "a ${SENTINAL_A} b ${SENTINAL_WORKTREE_SLOT} c ${SENTINAL_B}",
      ),
    ).toEqual(["${SENTINAL_A}", "${SENTINAL_B}"]);
  });

  it("ignores every non-SENTINAL token and bare $VAR", () => {
    expect(unknownSentinalTokens("${PORT:-3000} $HOME ${DOCKER_HOST}")).toEqual(
      [],
    );
  });

  it("does NOT fall through to process.env within the prefix", () => {
    process.env.SENTINAL_MADE_UP = "surprise";
    try {
      expect(unknownSentinalTokens("${SENTINAL_MADE_UP}")).toEqual([
        "${SENTINAL_MADE_UP}",
      ]);
    } finally {
      delete process.env.SENTINAL_MADE_UP;
    }
  });

  it("sees a shell-defaulted Sentinal token so it can be rejected", () => {
    expect(unknownSentinalTokens("${SENTINAL_WORKTREE_SLOT:-0}")).toEqual([
      "${SENTINAL_WORKTREE_SLOT:-0}",
    ]);
  });

  it("returns nothing for text with no tokens at all", () => {
    expect(unknownSentinalTokens("npm start")).toEqual([]);
  });
});

describe("unknownTokenMessage", () => {
  it("names every offending token and the field", () => {
    const msg = unknownTokenMessage(["${SENTINAL_X}"], "up");
    expect(msg).toContain("${SENTINAL_X}");
    expect(msg).toContain("`up`");
  });

  it("states that non-SENTINAL tokens are passed through", () => {
    expect(unknownTokenMessage(["${SENTINAL_X}"], "up")).toContain("verbatim");
  });
});

describe("interpolateStrict", () => {
  it("substitutes every occurrence of the slot token", () => {
    expect(
      interpolateStrict(
        "up ${SENTINAL_WORKTREE_SLOT} ${SENTINAL_WORKTREE_SLOT}",
        3,
      ),
    ).toBe("up 3 3");
  });

  it("passes non-SENTINAL tokens and bare $VAR through VERBATIM", () => {
    const cmd =
      "PORT=${PORT:-3000} FOO=$BAR npm start ${SENTINAL_WORKTREE_SLOT}";
    expect(interpolateStrict(cmd, 7)).toBe(
      "PORT=${PORT:-3000} FOO=$BAR npm start 7",
    );
  });

  it("leaves the placeholder IN PLACE when there is no slot", () => {
    // Mirrors Phase 2's unsubstitutedPlaceholderWarning: substituting an empty
    // or invented value would silently point at a resource that is not ours.
    expect(interpolateStrict("up ${SENTINAL_WORKTREE_SLOT}", null)).toBe(
      "up ${SENTINAL_WORKTREE_SLOT}",
    );
  });

  it("throws on an unknown SENTINAL_ token rather than substituting empty", () => {
    expect(() => interpolateStrict("up ${SENTINAL_NOPE}", 1)).toThrow(
      /\$\{SENTINAL_NOPE\}/,
    );
  });

  it("throws even when there is no slot — validation precedes substitution", () => {
    expect(() => interpolateStrict("up ${SENTINAL_NOPE}", null)).toThrow(
      /\$\{SENTINAL_NOPE\}/,
    );
  });

  it("is a no-op on a command with no tokens", () => {
    expect(interpolateStrict("npm start", 1)).toBe("npm start");
  });

  it("substitutes slot 0 correctly — not falsy-skipped", () => {
    expect(interpolateStrict("db_${SENTINAL_WORKTREE_SLOT}", 0)).toBe("db_0");
  });
});
