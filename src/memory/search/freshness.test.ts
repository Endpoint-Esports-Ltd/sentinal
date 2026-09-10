/**
 * Freshness helper tests
 *
 * `applyFreshness` is the SINGLE shared formula used by both the hybrid
 * strategy and the FTS-only fallback: recency is ADDED to the base score
 * first, then the sum is MULTIPLIED by the (floored) quality score.
 */

import { describe, it, expect } from "bun:test";
import { applyFreshness, MAX_RECENCY_BOOST } from "./freshness.js";
import { SEARCH_CONSTANTS } from "../types.js";
import type { Observation } from "../types.js";

const DAY = 24 * 60 * 60 * 1000;

function obs(overrides: Partial<Observation> = {}): Observation {
  const now = Date.now();
  return {
    id: 1,
    sessionId: "s",
    projectPath: "/p",
    timestamp: now,
    type: "discovery",
    title: "t",
    content: "c",
    filePaths: [],
    tags: [],
    metadata: {},
    qualityScore: 1.0,
    ...overrides,
  } as Observation;
}

describe("applyFreshness", () => {
  it("adds recency boost first, then multiplies by quality (order matters)", () => {
    const now = Date.now();
    // Fresh (age ~0) → recency factor ~1 → boost ~MAX_RECENCY_BOOST.
    const o = obs({ timestamp: now, qualityScore: 0.5 });
    const base = 1.0;
    // Expected: (base + ~MAX_RECENCY_BOOST) * 0.5, NOT base*0.5 + boost.
    const expected = (base + MAX_RECENCY_BOOST) * 0.5;
    expect(applyFreshness(base, o, now)).toBeCloseTo(expected, 5);
  });

  it("applies no recency boost once age exceeds the recency window", () => {
    const now = Date.now();
    const old = now - (SEARCH_CONSTANTS.RECENCY_WINDOW_MS + DAY);
    const o = obs({ timestamp: old, qualityScore: 1.0 });
    // No boost → base * quality = base.
    expect(applyFreshness(1.0, o, now)).toBeCloseTo(1.0, 5);
  });

  it("floors the quality multiplier at 0.1", () => {
    const now = Date.now();
    const old = now - (SEARCH_CONSTANTS.RECENCY_WINDOW_MS + DAY); // no boost
    const o = obs({ timestamp: old, qualityScore: 0.0 });
    expect(applyFreshness(1.0, o, now)).toBeCloseTo(0.1, 5);
  });

  it("defaults missing qualityScore to 1.0", () => {
    const now = Date.now();
    const old = now - (SEARCH_CONSTANTS.RECENCY_WINDOW_MS + DAY);
    const o = obs({ timestamp: old });
    delete (o as { qualityScore?: number }).qualityScore;
    expect(applyFreshness(2.0, o, now)).toBeCloseTo(2.0, 5);
  });

  it("ranks a fresher, higher-quality observation above a stale one at equal base", () => {
    const now = Date.now();
    const fresh = obs({ timestamp: now, qualityScore: 1.0 });
    const stale = obs({
      timestamp: now - (SEARCH_CONSTANTS.RECENCY_WINDOW_MS + DAY),
      qualityScore: 0.2,
    });
    expect(applyFreshness(1.0, fresh, now)).toBeGreaterThan(
      applyFreshness(1.0, stale, now),
    );
  });
});
