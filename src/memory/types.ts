/**
 * Memory System Type Definitions
 *
 * Core interfaces, enums, and Zod schemas for the persistent memory system.
 */

import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const OBSERVATION_TYPES = [
  "decision",
  "discovery",
  "error",
  "fix",
  "pattern",
] as const;

export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const ASSISTANT_TYPES = ["claude-code", "opencode"] as const;
export type AssistantType = (typeof ASSISTANT_TYPES)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const ObservationSchema = z.object({
  id: z.number(),
  sessionId: z.string(),
  projectPath: z.string(),
  timestamp: z.number(),
  type: z.enum(OBSERVATION_TYPES),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  filePaths: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

export const CreateObservationSchema = ObservationSchema.omit({ id: true });

export const SessionSchema = z.object({
  id: z.string(),
  startTime: z.number(),
  endTime: z.number().nullable(),
  projectPath: z.string(),
  assistant: z.enum(ASSISTANT_TYPES),
  observationCount: z.number().default(0),
  summary: z.string().nullable(),
  transcriptPath: z.string().nullable().default(null),
});

export interface ListSessionsOptions {
  project?: string;
  assistant?: AssistantType;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export const STALE_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export const SearchFiltersSchema = z.object({
  project: z.string().optional(),
  type: z.enum(OBSERVATION_TYPES).optional(),
  types: z.array(z.enum(OBSERVATION_TYPES)).optional(),
  tags: z.array(z.string()).optional(),
  dateStart: z.number().optional(),
  dateEnd: z.number().optional(),
  limit: z.number().min(1).max(200).default(20),
  offset: z.number().min(0).default(0),
  orderBy: z.enum(["date_desc", "date_asc", "relevance"]).default("relevance"),
  exactMatch: z.boolean().default(false),
});

// ─── Interfaces ───────────────────────────────────────────────────────────────

export type Observation = z.infer<typeof ObservationSchema>;
export type CreateObservation = z.infer<typeof CreateObservationSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export interface SearchResult {
  id: number;
  title: string;
  type: ObservationType;
  timestamp: number;
  score: number;
  estimatedTokens: number;
  snippet: string;
  tags: string[];
  filePaths: string[];
}

export interface TimelineEntry {
  id: number;
  type: ObservationType;
  title: string;
  timestamp: number;
  isAnchor: boolean;
  snippet: string;
}

export interface TimelineResult {
  anchor: number;
  entries: TimelineEntry[];
  totalBefore: number;
  totalAfter: number;
}

export interface MemoryStats {
  totalObservations: number;
  totalSessions: number;
  byType: Record<ObservationType, number>;
  byProject: Record<string, number>;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  databaseSizeBytes: number;
}

// ─── Raw DB Row Types ─────────────────────────────────────────────────────────

export interface RawObservation {
  id: number;
  session_id: string;
  project_path: string;
  timestamp: number;
  type: string;
  title: string;
  content: string;
  file_paths: string;
  tags: string;
  metadata: string;
}

export interface RawSession {
  id: string;
  start_time: number;
  end_time: number | null;
  project_path: string;
  assistant: string;
  observation_count: number;
  summary: string | null;
  transcript_path: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const SEARCH_CONSTANTS = {
  RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000, // 90 days
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 200,
  CHARS_PER_TOKEN_ESTIMATE: 4,
  SNIPPET_LENGTH: 200,
} as const;

export const NOTIFICATION_TYPES = ["info", "warning", "error", "success"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NotificationSchema = z.object({
  id: z.number(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().min(1),
  message: z.string().nullable(),
  source: z.string().nullable(),
  specId: z.string().nullable(),
  sessionId: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.number(),
});

export type Notification = z.infer<typeof NotificationSchema>;

export interface RawNotification {
  id: number;
  type: string;
  title: string;
  message: string | null;
  source: string | null;
  spec_id: string | null;
  session_id: string | null;
  read: number;
  created_at: number;
}

export const DB_CONSTANTS = {
  DB_DIR: ".sentinal",
  DB_NAME: "memory.db",
  SCHEMA_VERSION: 6,
} as const;
