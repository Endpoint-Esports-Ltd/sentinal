/**
 * Freshness weighting — the single shared "recency + quality" formula.
 *
 * Both the hybrid strategy and the FTS-only fallback rank results by
 * freshness so that `memory_update` (which resets timestamp) and the
 * age-based quality decay affect ranking on BOTH search paths.
 *
 * ⚠️ Order of operations MUST match the original hybrid math:
 *   1. Recency boost is ADDED to the base score first.
 *   2. The sum is THEN multiplied by the (floored) quality score.
 * i.e. `(base + recencyBoost) * quality`, NOT `base * quality + recencyBoost`.
 */

import { SEARCH_CONSTANTS } from "../types.js";
import type { Observation } from "../types.js";

/** Max recency boost added to the score for very recent observations. */
export const MAX_RECENCY_BOOST = 0.1;

/** Lower bound on the quality multiplier so decay re-orders rather than nulls. */
const MIN_QUALITY_MULTIPLIER = 0.1;

/**
 * Apply recency + quality weighting to a base relevance score.
 *
 * @param baseScore  The base relevance score (e.g. combined vector+fts, or a
 *                   positional FTS score).
 * @param obs        The observation (uses `timestamp` and `qualityScore`).
 * @param now        Current time in ms — injectable for deterministic tests.
 */
export function applyFreshness(
  baseScore: number,
  obs: Observation,
  now: number,
): number {
  let score = baseScore;

  // Recency boost: linear decay over the recency window.
  const age = now - obs.timestamp;
  if (age < SEARCH_CONSTANTS.RECENCY_WINDOW_MS) {
    const recencyFactor = 1 - age / SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
    score += recencyFactor * MAX_RECENCY_BOOST;
  }

  // Quality weighting: prioritize high-quality observations, floored so a
  // decayed item is demoted but not zeroed out.
  score *= Math.max(obs.qualityScore ?? 1.0, MIN_QUALITY_MULTIPLIER);

  return score;
}
