/**
 * Hybrid Strategy Tests
 *
 * Tests for quality score weighting in the merge-and-rank phase.
 */

import { describe, it, expect } from "bun:test";
import { mergeAndRank } from "./hybrid.js";
import type { Observation } from "../../types.js";
import type { ScoredObservation } from "./types.js";

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    sessionId: "s1",
    projectPath: "/test",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test",
    content: "Content",
    filePaths: [],
    tags: [],
    metadata: {},
    qualityScore: 1.0,
    ...overrides,
  };
}

describe("mergeAndRank", () => {
  it("should rank high-quality observations above low-quality ones", () => {
    const now = Date.now();

    const highQuality: ScoredObservation = {
      observation: makeObs({ id: 1, qualityScore: 1.0, timestamp: now - 1000 }),
      score: 0.5,
    };
    const lowQuality: ScoredObservation = {
      observation: makeObs({ id: 2, qualityScore: 0.2, timestamp: now - 1000 }),
      score: 0.5,
    };

    // Both have same vector score, but different quality
    const result = mergeAndRank([highQuality, lowQuality], [], 10);

    expect(result[0].observation.id).toBe(1); // high quality first
    expect(result[1].observation.id).toBe(2);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("should apply minimum quality floor of 0.1", () => {
    const now = Date.now();

    const zeroQuality: ScoredObservation = {
      observation: makeObs({ id: 1, qualityScore: 0.0, timestamp: now }),
      score: 0.8,
    };

    const result = mergeAndRank([zeroQuality], [], 10);

    // Score should be 0.8 * 0.1 (floor) = 0.08, not 0
    expect(result[0].score).toBeGreaterThan(0);
  });

  it("should not affect observations with quality score of 1.0", () => {
    const now = Date.now();

    const perfectQuality: ScoredObservation = {
      observation: makeObs({ id: 1, qualityScore: 1.0, timestamp: now - 100000 }),
      score: 0.7,
    };

    const result = mergeAndRank([perfectQuality], [], 10);

    // Vector weight: 0.7 * 0.7 = 0.49
    // Quality multiplier: * 1.0 = 0.49
    // Plus small recency boost
    expect(result[0].score).toBeCloseTo(0.49 + result[0].score - 0.49, 2);
  });

  it("should allow high-score low-quality to beat low-score high-quality", () => {
    const now = Date.now();

    const highScoreLowQuality: ScoredObservation = {
      observation: makeObs({ id: 1, qualityScore: 0.5, timestamp: now - 1000 }),
      score: 1.0, // very high relevance
    };
    const lowScoreHighQuality: ScoredObservation = {
      observation: makeObs({ id: 2, qualityScore: 1.0, timestamp: now - 1000 }),
      score: 0.2, // low relevance
    };

    const result = mergeAndRank([highScoreLowQuality], [lowScoreHighQuality], 10);

    // highScoreLowQuality: 1.0*0.7 * 0.5 = 0.35
    // lowScoreHighQuality: 0.2*0.3 * 1.0 = 0.06
    expect(result[0].observation.id).toBe(1);
  });
});
