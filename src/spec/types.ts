/**
 * Spec Workflow Type Definitions
 *
 * Core enums, interfaces, and Zod schemas for plan file parsing
 * and spec tracking in SQLite.
 */

import { z } from "zod";

// --- Enums ---

export const SPEC_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "VERIFIED",
  "CANCELLED",
  "APPROVED",
  "DRAFT",
  "PLANNING",
  "IMPLEMENTING",
  "VERIFYING",
  "FAILED",
] as const;

export type SpecStatus = (typeof SPEC_STATUSES)[number];

export const SPEC_TYPES = ["feature", "bugfix"] as const;
export type SpecType = (typeof SPEC_TYPES)[number];

export const TASK_STATUSES = ["pending", "in-progress", "complete", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses that indicate the spec is still active (not done). */
export const ACTIVE_STATUSES: readonly SpecStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "IMPLEMENTING",
  "VERIFYING",
] as const;

/** Statuses that indicate the spec is terminal (no more work). */
export const TERMINAL_STATUSES: readonly SpecStatus[] = [
  "VERIFIED",
  "CANCELLED",
] as const;

// --- Schemas ---

export const SpecTaskSchema = z.object({
  position: z.number().int().min(1),
  title: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  description: z.string().optional(),
  testStrategy: z.string().optional(),
  definitionOfDone: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});

export const SpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(SPEC_STATUSES),
  type: z.enum(SPEC_TYPES),
  approved: z.boolean().default(false),
  planFile: z.string().min(1),
  created: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  tasks: z.array(SpecTaskSchema).default([]),
  metadata: z
    .object({
      iterations: z.number().optional(),
      worktree: z.boolean().optional(),
    })
    .default({}),
});

// --- Interfaces ---

export type Spec = z.infer<typeof SpecSchema>;
export type SpecTask = z.infer<typeof SpecTaskSchema>;
