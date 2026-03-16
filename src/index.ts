/**
 * Sentinal Shared Library
 *
 * Common utilities and checkers used by both Claude Code and OpenCode targets.
 * This module provides reusable quality enforcement functions.
 */

export { checkFileLength, type FileLengthResult } from "./utils/file-length.js";
export {
  isTestFile,
  getExpectedTestPaths,
  isTrivialEdit,
} from "./utils/tdd.js";
export {
  isNestFile,
  checkNestPatterns,
  type NestCheckResult,
} from "./checkers/nestjs.js";
export { isAngularFile, type AngularCheckResult } from "./checkers/angular.js";
export {
  detectPackageManager,
  detectTestRunner,
  detectFramework,
  type PackageManager,
  type TestRunner,
  type Framework,
} from "./checkers/detect.js";

// ─── Memory System ────────────────────────────────────────────────────────────
export { MemoryStore, getDbPath } from "./memory/store.js";
export { MemoryService, type MemoryServiceOptions } from "./memory/service.js";
export { EmbeddingService, EMBEDDING_CONSTANTS } from "./memory/embeddings.js";
export {
  VectorStore,
  loadCustomSqlite,
  type VectorResult,
  type VectorSearchOptions,
} from "./memory/vector-store.js";
export { SearchOrchestrator } from "./memory/search/orchestrator.js";
export {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  TEST_FAIL_INDICATORS,
  TEST_PASS_INDICATORS,
} from "./memory/capture.js";
export type { ToolEvent, CaptureDecision } from "./memory/capture.js";
export { sanitize, sanitizeObservationFields } from "./memory/sanitize.js";
export {
  loadConfig,
  isMemoryEnabled,
  clearConfigCache,
  getConfigPath,
  type MemoryConfig,
} from "./memory/config.js";
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
  ListSessionsOptions,
  Notification,
  NotificationType,
  TddCycle,
  TddCycleState,
  SpecEvent,
  SpecEventType,
} from "./memory/types.js";
export {
  OBSERVATION_TYPES,
  ASSISTANT_TYPES,
  NOTIFICATION_TYPES,
  SEARCH_CONSTANTS,
  DB_CONSTANTS,
  STALE_SESSION_THRESHOLD_MS,
  TDD_CYCLE_STATES,
  SPEC_EVENT_TYPES,
} from "./memory/types.js";

// ─── TDD MCP Tools ───────────────────────────────────────────────────────────
export { registerTddTools } from "./tdd/mcp-tools.js";
export type { TddToolsDeps } from "./tdd/mcp-tools.js";

// ─── Analysis MCP Tools ───────────────────────────────────────────────────────
export { registerAnalysisTools } from "./analysis/mcp-tools.js";
export type { AnalysisToolsDeps } from "./analysis/mcp-tools.js";

// ─── TDD Enforcement ─────────────────────────────────────────────────────────
export { readTddState } from "./memory/tdd-state.js";
export {
  hasTestFailure,
  hasTestPass,
  getImplPathForTest,
} from "./hooks/tdd-tracker.js";
export { processTddGuard, type TddGuardInput } from "./hooks/tdd-guard.js";
export {
  processTddTracking,
  type TddTrackerInput,
} from "./hooks/tdd-tracker.js";

// ─── Maintenance ─────────────────────────────────────────────────────────────
export {
  rebuildFtsIndex,
  rebuildVectorIndex,
  backupDatabase,
  checkIntegrity,
} from "./memory/maintenance.js";

// ─── MCP Server & CLI ────────────────────────────────────────────────────────
export { createSentinalServer } from "./mcp/server.js";
export { registerMemoryTools } from "./memory/mcp-tools.js";
export { runCli, parseArgs } from "./memory/cli.js";

// ─── Spec System ─────────────────────────────────────────────────────────────
export {
  parsePlanFile,
  parsePlanContent,
  slugFromFilename,
} from "./spec/parser.js";
export {
  findActivePlan,
  shouldBlockStop,
  detectSpecType,
} from "./spec/detect.js";
export { SpecStore } from "./spec/store.js";
export { registerSpecTools } from "./spec/mcp-tools.js";
export type { SpecToolsDeps } from "./spec/mcp-tools.js";
export type {
  Spec,
  SpecTask,
  SpecStatus,
  SpecType,
  TaskStatus,
} from "./spec/types.js";
export {
  SPEC_STATUSES,
  SPEC_TYPES,
  TASK_STATUSES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from "./spec/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────
export {
  getModelRouting,
  setModelRouting,
  resetModelRouting,
} from "./config/model-routing.js";
export {
  ModelRoutingSchema,
  DEFAULT_MODEL_ROUTING,
  MODEL_ROUTING_KEY,
} from "./config/types.js";
export type { ModelRouting } from "./config/types.js";

// ─── Sessions ────────────────────────────────────────────────────────────────
export { estimateContextUsage, type ContextUsage } from "./sessions/context.js";
export {
  formatTokens,
  formatContextBar,
  getContextWarning,
} from "./sessions/context-display.js";
export {
  aggregateTokenUsage,
  CONTEXT_CHECK_INTERVAL,
} from "./sessions/token-usage.js";
export type { SessionMessage, MessageTokens } from "./sessions/token-usage.js";

// ─── Git / Worktree ──────────────────────────────────────────────────────────
// ─── Dashboard ───────────────────────────────────────────────────────────────
export { startServer, type ServerOptions } from "./dashboard/server.js";
export {
  writePidFile,
  readPidFile,
  removePidFile,
  isServerRunning,
  isProcessAlive,
  stopServer,
  getPidFilePath,
  autoStartDashboard,
  findSentinalBin,
} from "./dashboard/lifecycle.js";

// ─── Git / Worktree ──────────────────────────────────────────────────────────
export { WorktreeStore } from "./worktree/store.js";
export { WorktreeManager } from "./worktree/manager.js";
export { registerWorktreeTools } from "./worktree/mcp-tools.js";
export type { WorktreeToolsDeps } from "./worktree/mcp-tools.js";
export {
  gitExec,
  gitExecOrThrow,
  getCurrentBranch,
  detectBaseBranch,
  branchExists,
  getRepoRoot,
  getCurrentCommit,
  getGitVersion,
  checkGitVersion,
  slugify,
  randomHex,
} from "./git/utils.js";
export type {
  Worktree,
  WorktreeConfig,
  DiffSummary,
  DiffFileSummary,
} from "./worktree/types.js";
export {
  WorktreeError,
  WORKTREE_STATUSES,
  WorktreeSchema,
  WorktreeConfigSchema,
  DEFAULT_WORKTREE_CONFIG,
} from "./worktree/types.js";
export type { WorktreeStatus } from "./worktree/types.js";

// ─── Sidecar ─────────────────────────────────────────────────────────────────
export {
  getSidecarSocketPath,
  getSidecarPortPath,
  getSidecarPidPath,
} from "./sidecar/paths.js";
export { SidecarClient, withSidecarOrDirect } from "./sidecar/client.js";
export {
  autoStartSidecar,
  isSidecarRunning,
  getSidecarStatus,
  stopSidecarProcess,
} from "./sidecar/lifecycle.js";
export { startSidecar, stopSidecar } from "./sidecar/server.js";

// ─── OpenCode Plugin ────────────────────────────────────────────────────────
// Re-exported as fallback if OpenCode doesn't support subpath imports.
// Primary access is via `@endpoint/sentinal/opencode-plugin`.
export { SentinalPlugin } from "../targets/opencode/plugins/sentinal.js";
