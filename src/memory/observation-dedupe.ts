/**
 * Observation de-duplication (D3 signed errors, D10 auto-captures).
 *
 * Split out of `service.ts` for length. `MemoryService.addObservationDeduped`
 * delegates here, passing its own `addObservation` as the insert path so
 * sanitization and vector indexing stay in one place. `service.ts`
 * re-exports the window constants and `DedupedObservationResult`.
 */

import type { MemoryStore } from "./store.js";
import type { CreateObservation, Observation } from "./types.js";
import { sanitizeObservationFields } from "./sanitize.js";
import { computeDedupeSignature, isAutoCapture } from "./dedupe-signature.js";

/**
 * D3: a signed error repeating within this window of its FIRST sighting is
 * counted on the existing row instead of inserted. Fixed, not sliding —
 * repeats never move the row's timestamp.
 */
export const ERROR_DEDUP_WINDOW_MS = 30 * 60 * 1000;

/** D10: the same fixed first-sight window, for every signed observation. */
export const AUTO_CAPTURE_DEDUP_WINDOW_MS = ERROR_DEDUP_WINDOW_MS;

/** D10: auto-captured `fix` rows also collapse on (project, title). */
export const FIX_TITLE_DEDUP_WINDOW_MS = 5 * 60 * 1000;

export interface DedupedObservationResult {
  observation: Observation;
  /** true when an existing row absorbed this sighting (no insert). */
  deduplicated: boolean;
  /** true when the observation was signed, i.e. eligible for dedupe. */
  deduplicable: boolean;
}

/**
 * Add an observation, de-duplicating repeats — the body of
 * `MemoryService.addObservationDeduped` (see its doc comment). `add` is the
 * service's sanitizing, vector-indexing insert.
 */
export function addObservationDeduped(
  store: MemoryStore,
  obs: CreateObservation,
  add: (obs: CreateObservation) => Observation,
): DedupedObservationResult {
  const clientSignature = obs.metadata?.signature;
  const signature =
    obs.type === "error" &&
    typeof clientSignature === "string" &&
    clientSignature
      ? clientSignature
      : computeDedupeSignature(obs);
  if (!signature) {
    return {
      observation: add(obs),
      deduplicated: false,
      deduplicable: false,
    };
  }

  const existing =
    store.findRecentBySignature(
      obs.projectPath,
      obs.type,
      signature,
      obs.timestamp - AUTO_CAPTURE_DEDUP_WINDOW_MS,
    ) ??
    (obs.type === "fix" && isAutoCapture(obs.metadata)
      ? store.findRecentAutoCaptureByTitle(
          obs.projectPath,
          "fix",
          sanitizeObservationFields({ title: obs.title, content: "" }).title,
          obs.timestamp - FIX_TITLE_DEDUP_WINDOW_MS,
        )
      : null);
  if (existing) {
    const repeated = store.recordRepeat(existing.id, obs.timestamp);
    if (repeated) {
      return {
        observation: repeated,
        deduplicated: true,
        deduplicable: true,
      };
    }
  }

  return {
    observation: add({
      ...obs,
      metadata: { ...obs.metadata, signature, occurrences: 1 },
    }),
    deduplicated: false,
    deduplicable: true,
  };
}
