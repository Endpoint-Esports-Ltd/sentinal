/**
 * Sentinal Shared Library
 * 
 * Common utilities and checkers used by both Claude Code and OpenCode targets.
 * This module provides reusable quality enforcement functions.
 */

export { checkFileLength, type FileLengthResult } from "./utils/file-length.js";
export { isTestFile, getExpectedTestPaths, isTrivialEdit } from "./utils/tdd.js";
export { isNestFile, checkNestPatterns, type NestCheckResult } from "./checkers/nestjs.js";
export { isAngularFile, type AngularCheckResult } from "./checkers/angular.js";
export { detectPackageManager, detectTestRunner, detectFramework, type PackageManager, type TestRunner, type Framework } from "./checkers/detect.js";

// ─── Memory System ────────────────────────────────────────────────────────────
export { MemoryStore, getDbPath } from "./memory/store.js";
export { MemoryService, type MemoryServiceOptions } from "./memory/service.js";
export { EmbeddingService, EMBEDDING_CONSTANTS } from "./memory/embeddings.js";
export { VectorStore, loadCustomSqlite, type VectorResult, type VectorSearchOptions } from "./memory/vector-store.js";
export { SearchOrchestrator } from "./memory/search/orchestrator.js";
export { analyzeEvent, EventBuffer, MIN_CAPTURE_CONFIDENCE } from "./memory/capture.js";
export type { ToolEvent, CaptureDecision } from "./memory/capture.js";
export { sanitize, sanitizeObservationFields } from "./memory/sanitize.js";
export { loadConfig, isMemoryEnabled, clearConfigCache, getConfigPath, type MemoryConfig } from "./memory/config.js";
export { restoreContext } from "./memory/restore.js";
export type { RestoreOptions, RestoredContext } from "./memory/restore.js";
export type {
  Observation,
  CreateObservation,
  Session,
  SearchFilters,
  SearchResult,
  TimelineResult,
  TimelineEntry,
  MemoryStats,
  ObservationType,
  AssistantType,
} from "./memory/types.js";
export { OBSERVATION_TYPES, ASSISTANT_TYPES, SEARCH_CONSTANTS, DB_CONSTANTS } from "./memory/types.js";

// ─── Maintenance ─────────────────────────────────────────────────────────────
export { rebuildFtsIndex, rebuildVectorIndex, backupDatabase, checkIntegrity } from "./memory/maintenance.js";

// ─── MCP Server & CLI ────────────────────────────────────────────────────────
export { createSentinalServer } from "./mcp/server.js";
export { registerMemoryTools } from "./memory/mcp-tools.js";
export { runCli, parseArgs } from "./memory/cli.js";

// ─── Spec System ─────────────────────────────────────────────────────────────
export { parsePlanFile, parsePlanContent, slugFromFilename } from "./spec/parser.js";
export { findActivePlan, shouldBlockStop, detectSpecType } from "./spec/detect.js";
export { SpecStore } from "./spec/store.js";
export { registerSpecTools } from "./spec/mcp-tools.js";
export type { Spec, SpecTask, SpecStatus, SpecType, TaskStatus } from "./spec/types.js";
export { SPEC_STATUSES, SPEC_TYPES, TASK_STATUSES, ACTIVE_STATUSES, TERMINAL_STATUSES } from "./spec/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────
export { getModelRouting, setModelRouting, resetModelRouting } from "./config/model-routing.js";
export { ModelRoutingSchema, DEFAULT_MODEL_ROUTING, MODEL_ROUTING_KEY } from "./config/types.js";
export type { ModelRouting } from "./config/types.js";

// ─── Sessions ────────────────────────────────────────────────────────────────
export { estimateContextUsage, type ContextUsage } from "./sessions/context.js";
