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
  SESSION_LIVENESS_WINDOW_MS,
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
export { resolveStopDecision } from "./spec/ownership.js";
export type { StopDecisionInput, StopDecision } from "./spec/ownership.js";
export { resolvePlansDir, resolvePlanFilePath } from "./spec/plans-dir.js";
export type {
  ResolvePlansDirOptions,
  ResolvePlanFilePathOptions,
} from "./spec/plans-dir.js";
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
// Appended (Phase 2). Phase 3 appends below this — do not restructure.
export {
  LIVE_WORKTREE_STATUSES,
  type LiveWorktreeStatus,
  type ResolvedWorktree,
} from "./worktree/types.js";
// The two DECLARED opt-outs. `WorktreeConfig.stopOwnedRuntime` and
// `.unknownSentinalTokens` are required and fail closed, so any consumer
// building a config literal needs a way to say "nothing to do" on purpose.
export { NO_RUNTIME_STOP, NO_TOKEN_CHECK } from "./worktree/types.js";
export {
  MAIN_CHECKOUT_SLOT,
  FIRST_ALLOCATABLE_SLOT,
  SLOT_ENV_RELATIVE_PATH,
  SLOT_ENV_VAR,
  findFreeSlot,
  isAllocatableSlot,
  allocateSlot,
  tryAllocateSlot,
  insertWithSlot,
  readSlotFromWorktree,
  formatSlot,
} from "./worktree/slots.js";
export type { InsertWithSlotOptions } from "./worktree/slots.js";
export {
  seedWorktreeConfig,
  seedNonFatally,
  discoverSeedSources,
  interpolateSlot,
  hasSlotPlaceholder,
  notIsolatedWarning,
  SLOT_PLACEHOLDER,
  SEED_FILENAME,
  SEED_TARGET_FILENAME,
} from "./worktree/worktree-config.js";
export type { SeedOptions, SeedResult } from "./worktree/worktree-config.js";
export {
  excludeFromGit,
  isIgnored,
  isTracked,
} from "./worktree/git-exclude.js";
export type {
  ExcludeMechanism,
  ExcludeResult,
} from "./worktree/git-exclude.js";

// ─── Runtime contract (Phase 3) ──────────────────────────────────────────────
// `.sentinal/runtime.json` — project-authored, machine-readable up/readiness/
// down + the isolation map. Absence of the file is inert by design.
export {
  RuntimeConfigSchema,
  RUNTIME_CONFIG_RELATIVE_PATH,
  RUNTIME_LOG_RELATIVE_PATH,
  RUNTIME_LOG_TAIL_LINES,
  RESOURCE_CLASSES,
  ISOLATION_STATES,
  isolationOf,
  sharedResourceNames,
} from "./runtime/schema.js";
export type {
  RuntimeConfig,
  ResourceClass,
  IsolationState,
  IsolationVerdict,
} from "./runtime/schema.js";
export {
  SLOT_TOKEN,
  SENTINAL_TOKENS,
  INTERPOLATED_FIELDS,
  interpolateStrict,
  unknownSentinalTokens,
} from "./runtime/interpolate.js";
export { stripJsonComments } from "./runtime/jsonc.js";
export { loadRuntimeConfig } from "./runtime/loader.js";
export type { LoadedRuntimeConfig } from "./runtime/loader.js";
export { scaffoldRuntimeConfig } from "./runtime/scaffold.js";
export type { ScaffoldResult } from "./runtime/scaffold.js";
export { registerRuntimeTools } from "./runtime/mcp-tools.js";
export type { RuntimeToolsDeps } from "./runtime/mcp-tools.js";

// ─── Runtime lifecycle (Phase 4) ─────────────────────────────────────────────
// Process OWNERSHIP: spawn detached into a group Sentinal owns, record it in a
// worktree-local pidfile, and terminate exactly that group — the correct
// alternative to `pkill -f`, which is the entire point of the master plan.
//
// ⛔ Nothing here ever signals a PID or PGID without ownership verification, and
// everything refuses when verification is impossible. Read `ownership.ts` before
// changing any of it.
export { RUNTIME_PIDFILE_RELATIVE_PATH } from "./runtime/schema.js";
// ⚠️ `isProcessAlive` is deliberately NOT re-exported here — the barrel already
// publishes the dashboard's identically-named function (`:193`), and two
// same-named liveness helpers on one public surface is a trap. The runtime copy
// stays module-local; import it from `src/runtime/ownership.js` directly.
export {
  processBelongsToWorktree,
  listGroupMembers,
  verifiedGroupMembers,
  maySignalGroup,
} from "./runtime/ownership.js";
export type {
  OwnershipProbes,
  GroupProbes,
  GroupProbeResult,
  SignalGateVerdict,
} from "./runtime/ownership.js";
export {
  runtimePidfilePath,
  readPidfile,
  writePidfile,
  markPidfileReady,
  removePidfile,
  inspectPidfile,
  ownsLiveRuntime,
} from "./runtime/pidfile.js";
export type {
  RuntimePidfile,
  PidfileVerdict,
  LiveRuntimeVerdict,
} from "./runtime/pidfile.js";
export {
  spawnDetached,
  resolvePgid,
  runtimeLogPath,
  readLogTail,
} from "./runtime/spawn.js";
export type {
  SpawnDetachedOptions,
  SpawnDetachedResult,
} from "./runtime/spawn.js";
export { awaitReadiness } from "./runtime/readiness.js";
export type { ReadinessResult } from "./runtime/readiness.js";
export { stopOwnedGroup, assertStillAlive } from "./runtime/teardown.js";
export type { StopResult, TeardownDeps } from "./runtime/teardown.js";
export {
  runtimeUp,
  runtimeStop,
  readinessPort,
  isPortBound,
} from "./runtime/lifecycle.js";
export type { RuntimeUpResult, RuntimeUpDeps } from "./runtime/lifecycle.js";
export { registerRuntimeLifecycleTools } from "./runtime/lifecycle-mcp-tools.js";
export { runtimeWorktreeConfig } from "./runtime/worktree-deps.js";

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
// Primary access is via `@endpoint/sentinal/opencode-plugin`.
// Direct re-export removed: targets/opencode/ is outside rootDir for the
// Claude Code tsconfig, causing TS6059.  Callers should use the subpath.
