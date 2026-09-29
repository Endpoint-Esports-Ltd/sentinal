/**
 * Result shapes of the Orca CLI (`orchestration.contract.v1`, Orca 1.4.215),
 * as recorded in `src/orca/__fixtures__/`. Only the fields Sentinal reads are
 * typed; Orca may add more. Type-only module — no runtime imports.
 */

/** `orchestration run-create` / `run-current`. */
export interface OrcaRun {
  id: string;
  objective?: string;
  coordinator_handle: string;
  consumer_generation?: number;
  created_at?: string;
  updated_at?: string;
}

export interface OrcaMutation {
  requestId: string;
  replayed: boolean;
}

export interface OrcaRunCreateResult {
  run: OrcaRun;
  mutation?: OrcaMutation;
}

export type OrcaTaskStatus =
  "pending" | "ready" | "dispatched" | "completed" | "failed" | (string & {});

/** `orchestration task-create`. `deps` is a JSON-encoded string array. */
export interface OrcaTask {
  id: string;
  run_id: string;
  parent_id: string | null;
  task_title?: string;
  display_name?: string;
  spec: string;
  status: OrcaTaskStatus;
  deps: string;
  result: unknown;
  created_at?: string;
  completed_at?: string | null;
}

export interface OrcaTaskCreateResult {
  task: OrcaTask;
  mutation?: OrcaMutation;
}

/** One entry of a worker-start receipt's `effects` / `residualResources`. */
export interface OrcaResource {
  kind: "worktree" | "terminal" | "setup" | "dispatch_input" | (string & {});
  action?: string;
  role?: string;
  id?: string;
  state?: string;
  [key: string]: unknown;
}

export interface OrcaAgentLaunch {
  agent: string;
  model: string | null;
  effort: string | null;
}

/**
 * `orchestration worker-start`. The envelope is `ok:true` even when the start
 * failed: check `state === "failed"` (then `failedStage`, `lastError`, and the
 * terminals left behind in `residualResources`).
 */
export interface OrcaWorkerStartReceipt {
  runId: string;
  taskId: string;
  dispatchId: string;
  state: "ready" | "failed" | (string & {});
  stage: string;
  failedStage?: string;
  lastError?: string;
  /** `"unsupported"` when the provider cannot report that a turn began (OpenCode). */
  turnStart?: string;
  /** Prompt delivery receipt; `observation: "unsupported"` = delivery unconfirmable. */
  prompt?: { stages?: string[]; provider?: string; observation?: string };
  launch?: { requested: OrcaAgentLaunch; effective: OrcaAgentLaunch };
  effects?: OrcaResource[];
  residualResources: OrcaResource[];
  recovery?: string;
  timeoutMs?: number;
  mutation?: OrcaMutation;
}

export type OrcaMessageType =
  "worker_done" | "escalation" | "heartbeat" | (string & {});

/** A coordinator message. `payload` is a JSON-encoded string (or null). */
export interface OrcaMessage {
  id: string;
  run_id: string;
  from_handle: string;
  to_handle: string;
  subject: string;
  body: string;
  type: OrcaMessageType;
  priority?: string;
  thread_id?: string | null;
  payload: string | null;
  created_at: string;
  delivered_at?: string | null;
}

/** The decoded `payload` of a `worker_done` message. */
export interface OrcaWorkerDonePayload {
  taskId: string;
  dispatchId: string;
  outcome: "succeeded" | "failed" | (string & {});
  filesModified?: string[];
  reportPath?: string;
}

/**
 * `orchestration check [--wait]`. `timedOut: true` is a checkpoint (keep
 * waiting), not a failure.
 */
export interface OrcaCheckResult {
  runId: string;
  deliveryId: string | null;
  messages: OrcaMessage[];
  count: number;
  acknowledged: unknown;
  timedOut: boolean;
  cancelled: boolean;
  connectionLost: boolean;
  mutation?: OrcaMutation;
}

export interface OrcaTranscriptBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OrcaTranscriptMessage {
  id: string;
  role: "user" | "assistant" | (string & {});
  blocks: OrcaTranscriptBlock[];
  /** Epoch milliseconds. */
  timestamp: number;
  source?: string;
}

/** `orchestration worker-read --source auto`. */
export interface OrcaWorkerReadResult {
  dispatchId: string;
  source: string;
  provider?: string;
  transcript?: {
    messages: OrcaTranscriptMessage[];
    nextCursor?: string | null;
    limited?: boolean;
    returnedMessageCount?: number;
  };
  cursor?: string | null;
  /** Why there is no transcript (`provider_unsupported` for OpenCode, 1.4.216). */
  fallbackReason?: string;
  /** Present when `source === "terminal"`: the bounded terminal tail. */
  terminal?: { handle?: string; status?: string; tail?: string[] };
  [key: string]: unknown;
}

/**
 * `orchestration worker-show --dispatch <id>` (recorded 1.4.216).
 * `dispatchedAt` is `"YYYY-MM-DD HH:MM:SS"` in UTC WITHOUT a zone.
 */
export interface OrcaWorkerShowResult {
  dispatch: {
    id: string;
    status?: string;
    dispatchedAt?: string | null;
    lastHeartbeatAt?: string | null;
    [key: string]: unknown;
  };
  worker?: { state?: string; stage?: string; [key: string]: unknown };
  projection?: OrcaWorkerProjection | null;
  [key: string]: unknown;
}

/** `orchestration run-current`: `run` is null when no Run is bound. */
export interface OrcaRunCurrentResult {
  run: OrcaRun | null;
}

export type OrcaLivenessVerdict =
  "live" | "exited" | "unverifiable" | (string & {});

/**
 * The fleet projection of one Dispatch (`worker-list` rows, `worker-read`).
 * Field names read from Orca 1.4.215's CLI formatter (`worker-terminal-handlers.js`)
 * and the recorded `worker-read` fixture; everything is optional.
 */
export interface OrcaWorkerProjection {
  dispatchId?: string;
  taskId?: string;
  runId?: string;
  outcome?: "in_progress" | (string & {});
  stage?: { worker?: string; dispatch?: string; activity?: string };
  liveness?: { verdict?: OrcaLivenessVerdict; reason?: string };
  attention?: { categories?: string[]; requiresAction?: boolean };
  nextAction?: { kind?: string; argv?: string[] };
  [key: string]: unknown;
}

/** One `orchestration worker-list` row (shape from Orca's CLI source, not a capture). */
export interface OrcaWorkerListRow {
  dispatchId: string;
  taskId?: string;
  workerState?: string;
  dispatchStatus?: string;
  terminalState?: string | null;
  projection?: OrcaWorkerProjection | null;
  [key: string]: unknown;
}

export interface OrcaWorkerListResult {
  workers: OrcaWorkerListRow[];
  counts?: Record<string, number>;
  page?: { hasMore?: boolean; nextCursor?: string | null };
  [key: string]: unknown;
}

/** `worker-release` / `worker-retain` (fields from Orca's `formatWorkerRelease`). */
export interface OrcaWorkerReleaseResult {
  dispatchId: string;
  state:
    | "released"
    | "already_released"
    | "retained"
    | "release_pending"
    | "release_unknown"
    | (string & {});
  reason?: string;
  processAction?: string;
  lastError?: string;
  recovery?: string;
  mutation?: OrcaMutation;
}

/** `worker-stop` (fields from Orca's CLI formatter). */
export interface OrcaWorkerStopResult {
  dispatchId: string;
  state: "stop_unknown" | (string & {});
  processAction?: string;
  lastError?: string;
  warning?: string;
  mutation?: OrcaMutation;
}

/** `worktree create` / `worktree show` → `{worktree}`; `id` is `<repo-id>::<path>`. */
export interface OrcaWorktreeRecord {
  id?: string;
  path?: string;
  branch?: string;
  hostId?: string | null;
  displayName?: string;
  parentWorktreeId?: string | null;
  [key: string]: unknown;
}

export interface OrcaWorktreeResult {
  worktree?: OrcaWorktreeRecord;
  [key: string]: unknown;
}

/** `status` (top level, not under `orchestration`). */
export interface OrcaStatusResult {
  app?: { running?: boolean; desktopWindowStatus?: string };
  runtime?: {
    state?: string;
    reachable?: boolean;
    connectionState?: string;
    runtimeId?: string;
    appVersion?: string;
    capabilities?: string[];
  };
  graph?: { state?: string };
}

export interface OrcaRateLimitEntry {
  provider: string;
  status: "ok" | "error" | "unavailable" | (string & {});
  error: string | null;
  updatedAt?: number;
  usageMetadata?: {
    failureKind?: string;
    retryAtMs?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** `account list`. Only `rateLimits` is read (per-agent auth health). */
export interface OrcaAccountListResult {
  rateLimits?: Record<string, OrcaRateLimitEntry | unknown>;
  [key: string]: unknown;
}
