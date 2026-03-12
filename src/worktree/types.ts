/**
 * Git Worktree Type Definitions
 *
 * Interfaces, enums, and Zod schemas for the git worktree system.
 */

import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const WORKTREE_STATUSES = [
  "active",
  "ready-to-merge",
  "merged",
  "abandoned",
] as const;

export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const WorktreeSchema = z.object({
  id: z.string().min(1),
  specId: z.string().nullable().optional(),
  projectPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  baseBranch: z.string().min(1),
  baseCommit: z.string().min(1),
  status: z.enum(WORKTREE_STATUSES),
  createdAt: z.number(),
  mergedAt: z.number().nullable().optional(),
  mergeCommit: z.string().nullable().optional(),
});

export type Worktree = z.infer<typeof WorktreeSchema>;

export const WorktreeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  directory: z.string().default(".sentinal/worktrees"),
  branchPrefix: z.string().default("sentinal/spec-"),
  maxActive: z.number().int().min(1).default(5),
  autoCleanup: z.boolean().default(true),
});

export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema>;

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = WorktreeConfigSchema.parse({});

// ─── Diff Types ───────────────────────────────────────────────────────────────

export interface DiffFileSummary {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: DiffFileSummary[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "GIT_TOO_OLD"
      | "NOT_A_REPO"
      | "MAX_ACTIVE"
      | "NOT_FOUND"
      | "CONFLICT"
      | "GIT_ERROR"
      | "ALREADY_EXISTS",
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}
