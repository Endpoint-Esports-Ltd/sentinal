/**
 * Config Type Definitions
 *
 * Interfaces and Zod schemas for the settings system.
 * Model routing defines recommended models per spec workflow phase.
 */

import { z } from "zod";

// ─── Model Routing ───────────────────────────────────────────────────────────

export const ModelRoutingSchema = z.object({
  planning: z.string().default("opus"),
  implementation: z.string().default("sonnet"),
  verification: z.string().default("sonnet"),
  plan_reviewer: z.string().default("sonnet"),
  spec_reviewer: z.string().default("sonnet"),
});

export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  planning: "opus",
  implementation: "sonnet",
  verification: "sonnet",
  plan_reviewer: "sonnet",
  spec_reviewer: "sonnet",
};

/** The key used to store model routing in the settings table. */
export const MODEL_ROUTING_KEY = "model_routing";
