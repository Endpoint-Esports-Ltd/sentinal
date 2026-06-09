/**
 * buildCompactionContext — pure function for token-budget-aware compaction context.
 *
 * Returns an array of context strings (spec and/or memory) proportionally sized
 * to fit within a reserved token budget. No sidecar dependency, no SQLite imports.
 *
 * Token estimation heuristic: ~4 chars per token (Math.ceil(text.length / 4)).
 * Sentinal uses 30% of the reserved token budget.
 */

export interface CompactionContextOptions {
  specContext: string | null;
  memoryContext: string | null;
  reservedTokens: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildCompactionContext(
  opts: CompactionContextOptions,
): string[] {
  const { specContext, memoryContext, reservedTokens } = opts;

  // Rule 1: zero budget → nothing
  if (reservedTokens === 0) {
    return [];
  }

  // Rule 2: Sentinal uses 30% of the reserved budget
  let budget = Math.floor(reservedTokens * 0.3);

  const result: string[] = [];

  // Rule 4–8: spec first, then memory
  if (specContext !== null) {
    const specTokens = estimateTokens(specContext);

    if (specTokens <= budget) {
      // Spec fits — include it whole
      result.push(specContext);
      budget -= specTokens;
    } else {
      // Spec too large — truncate to budget * 4 chars (Rule 7)
      const truncated = specContext.slice(0, budget * 4);
      result.push(truncated);
      budget = 0; // no budget left after truncated spec
    }
  }

  // Rule 6 & 9: memory — include whole or drop (never truncate)
  if (memoryContext !== null && budget > 0) {
    const memTokens = estimateTokens(memoryContext);
    if (memTokens <= budget) {
      result.push(memoryContext);
    }
    // else: drop — Rule 9 says never truncate memory
  }

  return result;
}
