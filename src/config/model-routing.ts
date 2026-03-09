/**
 * Model Routing
 *
 * Convenience accessors for reading/writing model routing preferences
 * from the SQLite settings table. Falls back to defaults when no
 * setting exists or stored value is invalid.
 */

import type { MemoryStore } from "../memory/store.js";
import {
  ModelRoutingSchema,
  DEFAULT_MODEL_ROUTING,
  MODEL_ROUTING_KEY,
  type ModelRouting,
} from "./types.js";

/**
 * Get the current model routing config from the store.
 * Returns defaults if no setting exists or stored value is invalid.
 */
export function getModelRouting(store: MemoryStore): ModelRouting {
  const raw = store.getSetting(MODEL_ROUTING_KEY);
  if (!raw) return { ...DEFAULT_MODEL_ROUTING };

  try {
    const parsed = JSON.parse(raw);
    const result = ModelRoutingSchema.safeParse(parsed);
    return result.success ? result.data : { ...DEFAULT_MODEL_ROUTING };
  } catch {
    return { ...DEFAULT_MODEL_ROUTING };
  }
}

/**
 * Set model routing config. Merges partial updates with the current config.
 */
export function setModelRouting(
  store: MemoryStore,
  partial: Partial<ModelRouting>,
): ModelRouting {
  const current = getModelRouting(store);
  const merged = { ...current, ...partial };
  store.setSetting(MODEL_ROUTING_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Reset model routing to defaults by deleting the stored setting.
 */
export function resetModelRouting(store: MemoryStore): void {
  store.deleteSetting(MODEL_ROUTING_KEY);
}
