/**
 * Sentinal Plugin for OpenCode
 *
 * Quality enforcement plugin for TypeScript, Angular, and NestJS projects.
 * Provides automatic quality checks on file edits, tool redirection hints,
 * session state management across context compaction, and persistent memory.
 *
 * Features:
 * - File length enforcement (warn at 400, block at 600 lines)
 * - TDD enforcement (companion test file checks)
 * - NestJS pattern validation (DTOs, controllers, entities)
 * - Angular 17+ pattern validation (standalone components, control flow)
 * - Quality checks (tsc, eslint, prettier) on-demand via quality_report MCP tool
 * - Tool redirection hints (semantic search suggestions)
 * - Context usage monitoring with visual bar
 * - Session state preservation across compaction
 * - Persistent memory: auto-capture learning moments + restore at session start
 *
 * NOTE: This plugin runs inside OpenCode's embedded Node.js runtime (NOT Bun).
 * All DB operations go through the sidecar HTTP API. No bun:sqlite dependency.
 *
 * Imports are from specific source files (not the barrel export) to avoid
 * pulling in bun:sqlite transitively during bundling.
 */

// ─── Safe imports (no bun:sqlite dependency) ─────────────────────────────────
import {
  isTestFile,
  getExpectedTestPaths,
  shouldSkipTddGuard,
  isGuardedFile,
  getImplPathForTest,
} from "../../../src/utils/tdd.js";
import { checkNestPatterns, isNestFile } from "../../../src/checkers/nestjs.js";
import { isAngularFile } from "../../../src/checkers/angular.js";
import { detectFramework } from "../../../src/checkers/detect.js";
import { checkFileLength } from "../../../src/utils/file-length.js";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  TEST_FAIL_INDICATORS,
  TEST_PASS_INDICATORS,
} from "../../../src/memory/capture.js";
import type { ToolEvent } from "../../../src/memory/capture.js";
import { findActivePlan, shouldBlockStop } from "../../../src/spec/detect.js";
import { processInstructionsLoaded } from "../../../src/hooks/instructions-loaded.js";
import { processPostCompact } from "../../../src/hooks/post-compact.js";
import { processTaskCreated } from "../../../src/hooks/task-created.js";
import { handleCompactionAutocontinue } from "../../../src/opencode/compaction-autocontinue.js";
import { buildCompactionContext } from "../../../src/opencode/compaction-context.js";
import { createTddStatusTool } from "../../../src/opencode/native-tdd-status.js";
import { buildSemanticQuery } from "../../../src/memory/restore.js";
import {
  aggregateTokenUsage,
  CONTEXT_CHECK_INTERVAL,
} from "../../../src/sessions/token-usage.js";
import { getContextWarning } from "../../../src/sessions/context-display.js";
import type { SessionMessage } from "../../../src/sessions/token-usage.js";
import { SidecarClient } from "../../../src/sidecar/client.js";
import { ObservationQueue } from "../../../src/sidecar/observation-queue.js";
import {
  createSpecWorktreeAdaptor,
  type WorkspaceAdaptor,
} from "../../../src/opencode/workspace-adaptor.js";
import { logToFile, PLUGIN_LOG_FILE } from "../../../src/utils/file-log.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

// Type definitions for OpenCode plugin system
interface PluginContext {
  project: { name: string; path: string };
  directory: string;
  worktree: string;
  client: {
    app: {
      log(options: {
        body: { service: string; level: string; message: string };
      }): Promise<void>;
    };
    session: {
      messages(options: { path: { id: string } }): Promise<unknown>;
    };
  };
  $: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  experimental_workspace?: {
    register(type: string, adaptor: WorkspaceAdaptor): void;
  };
}

type Plugin = (context: PluginContext) => Promise<PluginHooks>;

interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: { directory: string; worktree: string },
  ): Promise<unknown>;
}

interface PluginHooks {
  "tool.execute.before"?: (
    input: { tool: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>;
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => Promise<void>;
  "compaction.autocontinue"?: (
    input: { sessionID: string },
    output: { continue: boolean; context: string[] },
  ) => Promise<void>;
  event?: (input: {
    event: {
      type: string;
      properties?: {
        info?: {
          id?: string;
          parentSessionId?: string;
          title?: string;
        };
      };
      sessionID?: string;
    };
  }) => Promise<void>;
  tool?: Record<string, ToolDefinition>;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

import {
  getGrepHint,
  getFetchHint,
  getPreEditGuide,
  checkSessionConflict,
  transitionTddState,
  resolveProjectRoot,
} from "./sentinal-helpers.js";

interface CompactState {
  activePlan: string | null;
  memoryContext: string | null;
  timestamp: string;
  cwd: string;
}

// ─── Node.js-compatible helpers ──────────────────────────────────────────────

const SENTINAL_DIR = join(homedir(), ".sentinal");

/** Append a timestamped line to ~/.sentinal/plugin.debug.log */
function log(message: string): void {
  logToFile(PLUGIN_LOG_FILE, message);
}

/** Spawn a sentinal sub-command if the PID file is stale or missing. */
function autoStartProcess(pidFile: string, ...args: string[]): void {
  const pidPath = join(SENTINAL_DIR, pidFile);
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isNaN(pid)) {
        process.kill(pid, 0);
        return;
      }
    } catch {
      /* stale PID */
    }
  }
  const binPath = join(SENTINAL_DIR, "bin", "sentinal");
  if (!existsSync(binPath)) return;
  try {
    log(
      `respawn: ${args.join(" ")} (pid file ${existsSync(pidPath) ? "stale" : "missing"})`,
    );
    const c = spawn(binPath, args, { stdio: "ignore", detached: true });
    c.unref();
  } catch {
    /* non-fatal */
  }
}

function stopProcess(pidFile: string): void {
  const pidPath = join(SENTINAL_DIR, pidFile);
  if (!existsSync(pidPath)) return;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!Number.isNaN(pid)) process.kill(pid, "SIGTERM");
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
}

function stopDashboard(): void {
  stopProcess("server.pid");
}
function stopSidecar(): void {
  stopProcess("sidecar.pid");
}

// ─── TDD via sidecar ─────────────────────────────────────────────────────────

/** TDD guard via sidecar: returns error message if blocked, null if allowed. */
async function sidecarTddGuard(
  sidecar: SidecarClient,
  toolName: string,
  filePath: string,
  cwd: string,
): Promise<string | null> {
  if (!["write", "edit", "multiedit", "patch"].includes(toolName.toLowerCase()))
    return null;
  if (!isGuardedFile(filePath)) return null;

  try {
    const { state, hasActiveSpec } = await sidecar.getTddState(filePath, cwd);
    if (!hasActiveSpec) return null;
    if (state === "RED_CONFIRMED") return null;

    const descriptions: Record<string, string> = {
      IDLE: "no test has been written yet for this file",
      TEST_WRITTEN: "a test has been written but not confirmed to fail yet",
      GREEN_CONFIRMED: "the previous TDD cycle is complete",
    };
    const desc = descriptions[state] ?? "TDD state is unknown";
    return `[Sentinal TDD Guard] Cannot edit implementation file: ${desc}.\nFollow RED-GREEN-REFACTOR:\n  1. Write a failing test\n  2. Run tests and confirm failure\n  3. Only then edit implementation`;
  } catch {
    return null; // sidecar unavailable, don't block
  }
}

/** TDD tracker via sidecar: fire-and-forget state updates. */
async function sidecarTddTrack(
  sidecar: SidecarClient,
  toolName: string,
  filePath: string | undefined,
  bashOutput: string | undefined,
): Promise<void> {
  try {
    const isEdit = ["write", "edit", "multiedit", "patch"].includes(
      toolName.toLowerCase(),
    );

    // Case 1: Test file written → TEST_WRITTEN
    if (isEdit && filePath && isTestFile(filePath)) {
      const implPath = getImplPathForTest(filePath) ?? filePath;
      await sidecar.setTddState({
        filePath: implPath,
        state: "TEST_WRITTEN",
        testFilePath: filePath,
      });
      return;
    }

    // Case 2: Bash shows test failure → bulk transition TEST_WRITTEN → RED_CONFIRMED
    if (
      toolName.toLowerCase() === "bash" &&
      bashOutput &&
      TEST_FAIL_INDICATORS.some((r) => r.test(bashOutput))
    ) {
      await transitionTddState(sidecar, "confirm_red");
      return;
    }

    // Case 3: Bash shows test pass → bulk clear RED_CONFIRMED states
    if (
      toolName.toLowerCase() === "bash" &&
      bashOutput &&
      TEST_PASS_INDICATORS.some((r) => r.test(bashOutput))
    ) {
      await transitionTddState(sidecar, "confirm_green");
    }
  } catch {
    /* non-fatal */
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const SentinalPlugin: Plugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  const { root: projectRoot, reason: projectRootReason } = resolveProjectRoot(
    worktree,
    directory,
  );
  // projectRootForSidecar: sidecar tolerates "" as "session-scoped, no persistence"
  const projectRootForSidecar = projectRoot ?? "";

  const eventBuffer = new EventBuffer(20);
  let sidecar: SidecarClient | null = null;
  let sessionId: string | null = null;
  let toolCallCount = 0;
  let draining = false;

  // Auto-start sidecar + dashboard (Node.js-compatible spawn)
  try {
    autoStartProcess("sidecar.pid", "sidecar", "start");
  } catch {
    /* non-fatal */
  }
  try {
    autoStartProcess("server.pid", "serve");
  } catch {
    /* non-fatal */
  }

  // Inline: avoid importing config.ts which pulls in types.ts → zod
  const memoryEnabled = (() => {
    try {
      const cfgPath = join(SENTINAL_DIR, "config.json");
      if (existsSync(cfgPath)) {
        const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
        return raw?.memory?.enabled !== false;
      }
    } catch {
      /* invalid JSON */
    }
    return true;
  })();

  if (memoryEnabled) {
    try {
      sidecar = await SidecarClient.connectWithRetry(10, 200);
    } catch {
      /* unavailable */
    }
    if (sidecar) {
      log("Connected to sidecar");
      // Drain any queued observations from previous sessions
      if (!draining && ObservationQueue.pending() > 0) {
        draining = true;
        try {
          const r = await ObservationQueue.drain(async (obs) => {
            await sidecar!.addObservation(obs);
          }, log);
          if (r.sent > 0) log(`drained ${r.sent} queued observations on init`);
        } catch (e) {
          log(
            `queue drain failed on init: ${e instanceof Error ? e.message : e}`,
          );
        }
        draining = false;
      }
    } else {
      log("Sidecar unavailable — memory features disabled");
    }
  } else {
    log("Memory system disabled via config");
  }

  // Register workspace adaptor if the API is available (OC 1.4.4+)
  if (context.experimental_workspace) {
    context.experimental_workspace.register(
      "sentinal-spec-worktree",
      createSpecWorktreeAdaptor(sidecar),
    );
    log("workspace adaptor registered: sentinal-spec-worktree");
  }

  // Eager session creation (fallback if session.created never fires)
  sessionId = `opencode-${Date.now()}`;
  try {
    if (sidecar) {
      await sidecar.createSession({
        id: sessionId,
        projectPath: projectRootForSidecar,
        assistant: "opencode",
      });
      log(`Eager session created: ${sessionId} (sidecar)`);
    }
  } catch (e) {
    log(`Eager session insert failed: ${e instanceof Error ? e.message : e}`);
  }

  // Warn once when no writable project root was found — per-project state skipped
  if (projectRoot === null) {
    try {
      await client.app.log({
        body: {
          service: "sentinal",
          level: "warn",
          message: `[Sentinal] Per-project state disabled: ${projectRootReason}. Session will work, but compact-state and event-buffer will not persist.`,
        },
      });
    } catch {
      /* log unavailable */
    }
  }

  await client.app.log({
    body: {
      service: "sentinal",
      level: "info",
      message: `Sentinal initialized for: ${projectRoot ?? "(no project root)"}`,
    },
  });

  return {
    "tool.execute.before": async (input, output) => {
      const { tool } = input;
      const args = output.args || {};

      // TDD Guard via sidecar
      const filePath = args.file_path ?? args.filePath ?? args.path;
      if (sidecar && typeof filePath === "string") {
        const guardMsg = await sidecarTddGuard(
          sidecar,
          tool,
          filePath,
          projectRootForSidecar,
        );
        if (guardMsg) throw new Error(guardMsg);
      }

      // Tool redirect hints
      if (tool === "grep" && typeof args.pattern === "string") {
        const grepHint = getGrepHint(args.pattern as string);
        if (grepHint)
          await client.app.log({
            body: { service: "sentinal", level: "info", message: grepHint },
          });
      }
      if (tool === "fetch") {
        await client.app.log({
          body: { service: "sentinal", level: "info", message: getFetchHint() },
        });
      }

      // Pre-edit guidance: inject file-specific observations
      if (sidecar && typeof filePath === "string") {
        const guide = await getPreEditGuide(
          sidecar,
          filePath,
          projectRootForSidecar,
        );
        if (guide)
          await client.app.log({
            body: { service: "sentinal", level: "info", message: guide },
          });
      }
    },

    "tool.execute.after": async (input, output) => {
      const QUALITY_TOOLS = ["write", "edit", "patch"];
      const MEMORY_TOOLS = [
        "write",
        "edit",
        "patch",
        "bash",
        "shell",
        "terminal",
        "multiedit",
      ];

      // ── Sync phase: quality checks (can throw to block) ──────────────
      const filePath =
        output.args?.filePath || output.args?.file_path || output.args?.path;
      const issues: string[] = [];
      let shouldBlock = false;

      if (
        QUALITY_TOOLS.includes(input.tool) &&
        filePath &&
        typeof filePath === "string"
      ) {
        const ext = filePath.slice(filePath.lastIndexOf("."));
        if (TS_EXTENSIONS.includes(ext)) {
          try {
            const content = readFileSync(filePath, "utf-8");
            const lineCount = content.split("\n").length;

            const lengthResult = checkFileLength(filePath, lineCount, content);
            if (lengthResult) {
              issues.push(lengthResult.message);
              if (lengthResult.severity === "block") shouldBlock = true;
            }

            const nestResults = checkNestPatterns(filePath, content);
            for (const r of nestResults) {
              issues.push(`[NestJS] ${r.message}`);
              if (r.severity === "error") shouldBlock = true;
            }

            const frameworks = detectFramework(projectRootForSidecar);
            if (frameworks.includes("angular") && isAngularFile(filePath)) {
              if (
                content.includes("@Component") &&
                !content.includes("standalone: true")
              ) {
                issues.push(
                  `[Angular] Standalone components are required in Angular 17+. Add 'standalone: true' to @Component decorator.`,
                );
              }
              if (content.includes("*ngIf") || content.includes("*ngFor")) {
                issues.push(
                  `[Angular] Use Angular 17+ control flow (@if, @for) instead of *ngIf/*ngFor.`,
                );
              }
            }
          } catch {
            /* file might not exist yet */
          }

          if (!isTestFile(filePath)) {
            const testPaths = getExpectedTestPaths(filePath);
            if (
              testPaths.length > 0 &&
              !testPaths.some((tp) => existsSync(tp))
            ) {
              issues.push(
                `No companion test file found. Expected: ${testPaths[0]}`,
              );
            }
          }

          // NOTE: tsc, eslint, and prettier are now on-demand only via quality_report MCP tool.
          // They no longer run automatically on every edit.

          if (issues.length > 0) {
            const level = shouldBlock ? "error" : "warn";
            await client.app.log({
              body: {
                service: "sentinal",
                level,
                message: `Quality issues in ${filePath}:\n\n${issues.map((i) => `- ${i}`).join("\n")}`,
              },
            });
            if (shouldBlock)
              throw new Error(
                `[Sentinal] Blocking due to critical issues:\n${issues.join("\n")}`,
              );
          }
        }
      }

      if (!MEMORY_TOOLS.includes(input.tool)) return;

      // ── Async phase: fire-and-forget for TDD, memory, context ────────
      // These are side-effect-only operations that don't affect the tool
      // pipeline. Running them as fire-and-forget removes ~50-300ms of
      // blocking per tool call. Errors are swallowed silently.
      const asyncIssues = [...issues];
      const asyncShouldBlock = shouldBlock;
      void (async () => {
        try {
          // Context monitoring — only query OpenCode's session API with a real session ID
          // (our eager "opencode-<ts>" IDs cause Hono validator errors in the TUI)
          toolCallCount++;
          const hasRealSessionId =
            sessionId && !sessionId.startsWith("opencode-");
          if (
            hasRealSessionId &&
            toolCallCount % CONTEXT_CHECK_INTERVAL === 0
          ) {
            try {
              const response = await client.session.messages({
                path: { id: sessionId! },
              });
              const messages = ((response as unknown as { data?: unknown })
                ?.data ??
                response ??
                []) as SessionMessage[];
              if (Array.isArray(messages)) {
                const usage = aggregateTokenUsage(messages);
                const warning = getContextWarning(usage);
                if (warning) {
                  await client.app.log({
                    body: {
                      service: "sentinal",
                      level: usage.percent >= 95 ? "error" : "warn",
                      message: `[Sentinal] ${warning}`,
                    },
                  });
                }
              }
            } catch {
              /* non-fatal */
            }
          }

          // TDD Tracker via sidecar
          if (sidecar) {
            const trackerFilePath =
              typeof filePath === "string" ? filePath : undefined;
            const bashOutput = ["bash", "shell", "terminal"].includes(
              input.tool,
            )
              ? (output.args?.output as string | undefined)
              : undefined;
            await sidecarTddTrack(
              sidecar,
              input.tool,
              trackerFilePath,
              bashOutput,
            );
          }

          // Memory capture (runs even without sidecar — queues when unavailable)
          if (sessionId) {
            // Build output: prefer actual tool output for bash/shell (enables error→fix,
            // TDD cycle, and build-fix heuristics), fall back to quality-check issues
            let eventOutput: string | undefined;
            if (["bash", "shell", "terminal"].includes(input.tool)) {
              const raw =
                output.args?.output ??
                output.args?.stdout ??
                output.args?.stderr;
              if (typeof raw === "string" && raw.length > 0) {
                eventOutput = raw.slice(0, 2000);
              }
            }
            if (!eventOutput && asyncIssues.length > 0) {
              eventOutput = asyncIssues.join("\n").slice(0, 500);
            }

            // For bash tools, use exit code if available; otherwise rely on quality-check blocking
            let eventSuccess = !asyncShouldBlock;
            if (["bash", "shell", "terminal"].includes(input.tool)) {
              const exitCode = output.args?.exitCode ?? output.args?.exit_code;
              if (typeof exitCode === "number") eventSuccess = exitCode === 0;
            }

            const event: ToolEvent = {
              toolName: input.tool,
              filePath: typeof filePath === "string" ? filePath : undefined,
              success: eventSuccess,
              output: eventOutput,
              timestamp: Date.now(),
            };
            eventBuffer.push(event);
            const decision = analyzeEvent(event, eventBuffer);
            if (
              decision.shouldCapture &&
              decision.confidence >= MIN_CAPTURE_CONFIDENCE
            ) {
              const obsPayload = {
                sessionId,
                projectPath: projectRootForSidecar,
                type: decision.type,
                title: decision.title,
                content: decision.content,
                filePaths: decision.filePaths,
                tags: decision.tags,
                metadata: {
                  source: "auto-capture",
                  confidence: decision.confidence,
                  toolName: input.tool,
                },
              };
              if (sidecar) {
                try {
                  await sidecar.addObservation(obsPayload);
                } catch {
                  ObservationQueue.enqueue(obsPayload, log);
                }
              } else {
                ObservationQueue.enqueue(obsPayload, log);
              }
            }
          }
        } catch (e) {
          log(
            `async post-tool work failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      })();
    },

    "experimental.session.compacting": async (input, output) => {
      const active = findActivePlan(projectRootForSidecar);
      const activePlan = active?.filePath ?? null;
      const planStatus = active?.spec.status ?? null;

      let memoryContext: string | null = null;
      const sq = buildSemanticQuery(projectRootForSidecar);
      try {
        if (sidecar) {
          if (active)
            await sidecar.syncSpec(active.filePath, projectRootForSidecar);
          const restored = await sidecar.restoreContext(
            projectRootForSidecar,
            sq,
          );
          if (restored.hasMemory) memoryContext = restored.markdown;
        }
      } catch (e) {
        log(`compaction sidecar failed: ${e instanceof Error ? e.message : e}`);
      }

      if (projectRoot) {
        const stateDir = join(projectRoot, ".sentinal");
        mkdirSync(stateDir, { recursive: true });
        const state: CompactState = {
          activePlan,
          memoryContext,
          timestamp: new Date().toISOString(),
          cwd: projectRoot,
        };
        writeFileSync(
          join(stateDir, "compact-state.json"),
          JSON.stringify(state, null, 2),
        );

        // OC parity: PostCompact — verify compact state and inject context
        void processPostCompact({
          session_id: sessionId ?? "",
          transcript_path: "",
          cwd: projectRoot,
          permission_mode: "default",
          hook_event_name: "PostCompact",
        }).catch(() => {
          /* non-fatal */
        });
      }

      // Build spec context string (if active plan)
      let specContextStr: string | null = null;
      if (activePlan && active) {
        // Build enriched spec context with current task and progress.
        // NOTE: This formatting logic is duplicated from src/hooks/prompt-context.ts
        // (buildSpecContext). The OC plugin can't import from src/ since it's
        // deployed as a single bundled file. Keep both in sync when changing format.
        const tasks = active.spec.tasks ?? [];
        const total = tasks.length;
        const completed = tasks.filter(
          (t: { status: string }) => t.status === "complete",
        ).length;
        const remaining = total - completed;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        const currentTask =
          tasks.find((t: { status: string }) => t.status === "in-progress") ??
          tasks.find((t: { status: string }) => t.status === "pending") ??
          null;

        const specLines = [
          "## Active Spec State",
          "",
          `**Active Plan:** ${activePlan}`,
          `**Status:** ${planStatus}`,
          `**Progress:** ${percent}% (${completed}/${total} tasks, ${remaining} remaining)`,
        ];
        if (currentTask) {
          specLines.push(
            `**Current Task:** Task ${(currentTask as { position: number; title: string }).position}: ${(currentTask as { position: number; title: string }).title}`,
          );
        }
        specLines.push(
          "",
          `Resume with \`/spec ${activePlan}\` to continue the workflow.`,
        );
        specContextStr = specLines.join("\n");
      }

      // Read compaction.reserved from user's opencode.json for token-budget sizing
      let reserved = 10000;
      if (sidecar) {
        try {
          reserved = (await sidecar.getCompactionConfig(projectRootForSidecar))
            .reserved;
        } catch {
          // Non-fatal — use default
        }
      }

      // Inject proportionally sized context (spec prioritized over memory)
      const budgetedContext = buildCompactionContext({
        specContext: specContextStr,
        memoryContext,
        reservedTokens: reserved,
      });
      budgetedContext.forEach((c) => output.context.push(c));
    },

    "experimental.chat.system.transform": async (_input, output) => {
      try {
        // Discover output shape — log keys for debugging on first call
        const keys = Object.keys(output);
        log(`system.transform output keys: [${keys.join(", ")}]`);
        const systemArr = (output.system ?? output.context) as
          | string[]
          | undefined;
        if (!Array.isArray(systemArr)) {
          log(
            `system.transform: no usable array in output — skipping injection`,
          );
          return;
        }

        // Inject active spec context
        const active = findActivePlan(projectRootForSidecar);
        if (active) {
          const { spec, filePath } = active;
          const total = spec.tasks.length;
          const done = spec.tasks.filter((t) => t.status === "complete").length;
          const current =
            spec.tasks.find((t) => t.status === "in-progress")?.title ??
            spec.tasks.find((t) => t.status === "pending")?.title ??
            "none";
          systemArr.push(
            `[Sentinal] Active plan: ${filePath} | Status: ${spec.status} | Task: ${current} | Progress: ${done}/${total}`,
          );
        }

        // Inject model routing hints if non-default
        if (sidecar) {
          try {
            const routing = await sidecar.getModelRouting();
            const defaults = {
              planning: "opus",
              implementation: "sonnet",
              verification: "sonnet",
              plan_reviewer: "sonnet",
              spec_reviewer: "sonnet",
            };
            const isNonDefault = (
              Object.keys(defaults) as Array<keyof typeof defaults>
            ).some((k) => routing[k] !== defaults[k]);
            if (isNonDefault) {
              const parts = Object.entries(routing)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ");
              systemArr.push(
                `[Sentinal] Model routing: ${parts}. Use the specified model when invoking spec skills.`,
              );
            }
          } catch {
            // Sidecar unavailable for model routing — skip
          }
        }
      } catch (e) {
        log(`system.transform failed: ${e instanceof Error ? e.message : e}`);
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Real session ID lives at event.properties.info.id (OpenCode SDK structure)
        const newSessionId =
          event.properties?.info?.id ??
          event.sessionID ??
          `opencode-${Date.now()}`;
        const previousSessionId = sessionId;
        sessionId = newSessionId;
        log(
          `session.created: ${sessionId}${previousSessionId ? ` (replacing ${previousSessionId})` : ""}`,
        );

        try {
          if (sidecar) {
            if (previousSessionId && previousSessionId !== newSessionId) {
              await sidecar.endSession(previousSessionId, {
                notification: false,
              });
            }
            await sidecar.createSession({
              id: sessionId,
              projectPath: projectRootForSidecar,
              assistant: "opencode",
            });
          }
          log(`Session inserted: ${sessionId}`);
        } catch (e) {
          log(`insertSession failed: ${e instanceof Error ? e.message : e}`);
        }

        // Drain queued observations from previous sessions
        if (sidecar && !draining && ObservationQueue.pending() > 0) {
          draining = true;
          try {
            const r = await ObservationQueue.drain(async (obs) => {
              await sidecar!.addObservation(obs);
            }, log);
            if (r.sent > 0)
              log(`drained ${r.sent} queued observations on session.created`);
          } catch (e) {
            log(`queue drain failed: ${e instanceof Error ? e.message : e}`);
          }
          draining = false;
        }

        // Restore memory context and save to compact-state.json for compaction pickup.
        // NOTE: client.app.log() writes to OpenCode's TUI log panel, NOT the LLM's
        // context window. Memory is injected into LLM context during compaction
        // via output.context.push() in the session.compacting handler above.
        // Saving to compact-state.json ensures memory context is available even
        // if the first compaction happens before the sidecar is fully ready.
        try {
          if (sidecar) {
            const restored = await sidecar.restoreContext(
              projectRootForSidecar,
            );
            if (restored.hasMemory && restored.markdown) {
              await client.app.log({
                body: {
                  service: "sentinal",
                  level: "info",
                  message: restored.markdown,
                },
              });
              // Persist for compaction handler pickup (skip if no project root)
              if (projectRoot) {
                const stDir = join(projectRoot, ".sentinal");
                mkdirSync(stDir, { recursive: true });
                const activePlanInfo = findActivePlan(projectRootForSidecar);
                const compactState: CompactState = {
                  activePlan: activePlanInfo?.filePath ?? null,
                  memoryContext: restored.markdown,
                  timestamp: new Date().toISOString(),
                  cwd: projectRoot,
                };
                writeFileSync(
                  join(stDir, "compact-state.json"),
                  JSON.stringify(compactState, null, 2),
                );
              }
            }
          }
        } catch (e) {
          log(`restoreContext failed: ${e instanceof Error ? e.message : e}`);
        }

        // Check for conflicting sessions on the same project
        if (sidecar) {
          const conflictMsg = await checkSessionConflict(
            sidecar,
            sessionId,
            projectRootForSidecar,
          );
          if (conflictMsg)
            await client.app.log({
              body: {
                service: "sentinal",
                level: "warn",
                message: conflictMsg,
              },
            });
        }

        // OC parity: InstructionsLoaded — record CLAUDE.md / AGENTS.md if they exist
        const instructionsFile = existsSync(
          join(projectRootForSidecar, "CLAUDE.md"),
        )
          ? join(projectRootForSidecar, "CLAUDE.md")
          : existsSync(join(projectRootForSidecar, "AGENTS.md"))
            ? join(projectRootForSidecar, "AGENTS.md")
            : null;
        if (instructionsFile) {
          void processInstructionsLoaded({
            session_id: sessionId,
            transcript_path: "",
            cwd: projectRootForSidecar,
            permission_mode: "default",
            hook_event_name: "InstructionsLoaded",
            file_path: instructionsFile,
            memory_type: "Project",
            load_reason: "session_start",
          }).catch(() => {
            /* non-fatal */
          });
        }

        // OC parity: TaskCreated — if this appears to be a subagent session, notify dashboard
        const isSubagent = !!event.properties?.info?.parentSessionId;
        if (isSubagent) {
          void processTaskCreated({
            session_id: sessionId,
            transcript_path: "",
            cwd: projectRootForSidecar,
            permission_mode: "default",
            hook_event_name: "TaskCreated",
            task_id: sessionId,
            task_subject: event.properties?.info?.title ?? "Subagent task",
          }).catch(() => {
            /* non-fatal */
          });
        }

        // Restore spec plan state from previous compaction (skip if no project root)
        const stateFile = projectRoot
          ? join(projectRoot, ".sentinal", "compact-state.json")
          : null;
        if (stateFile && existsSync(stateFile)) {
          try {
            const state: CompactState = JSON.parse(
              readFileSync(stateFile, "utf-8"),
            );
            if (state.activePlan && existsSync(state.activePlan)) {
              await client.app.log({
                body: {
                  service: "sentinal",
                  level: "info",
                  message: `[Sentinal] Session restored. Active plan: ${state.activePlan}\nResume with: /spec ${state.activePlan}`,
                },
              });
            }
          } catch {
            /* ignore */
          }
        }
      }

      // session.updated fires on resume and metadata changes — use it to
      // capture the real session ID when session.created didn't fire (e.g. `opencode -s <id>`)
      if (event.type === "session.updated") {
        const realId = event.properties?.info?.id;
        if (realId && sessionId?.startsWith("opencode-")) {
          const previousSessionId = sessionId;
          sessionId = realId;
          log(
            `session.updated: adopted real session ID ${sessionId} (replacing eager ${previousSessionId})`,
          );
          if (sidecar) {
            // End the eager placeholder session
            try {
              await sidecar.endSession(previousSessionId, {
                notification: false,
              });
            } catch (e) {
              log(
                `end eager session failed: ${e instanceof Error ? e.message : e}`,
              );
            }
            // Create (or re-adopt) the real session — may already exist from a prior instance
            try {
              await sidecar.createSession({
                id: sessionId,
                projectPath: projectRootForSidecar,
                assistant: "opencode",
              });
            } catch (e) {
              log(
                `create real session failed (may already exist): ${e instanceof Error ? e.message : e}`,
              );
            }
          }
        }
      }

      if (event.type === "session.deleted") {
        if (sessionId) {
          try {
            if (sidecar) {
              await sidecar.endSession(sessionId, { notification: true });
              const active = await sidecar.getActiveSessions();
              if (active.length === 0) {
                stopDashboard();
                stopSidecar();
              }
            }
            log(`Session ended: ${sessionId}`);
          } catch (e) {
            log(`endSession failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (projectRoot) {
          const bufferPath = join(
            projectRoot,
            ".sentinal",
            "event-buffer.json",
          );
          try {
            if (existsSync(bufferPath)) unlinkSync(bufferPath);
          } catch {
            /* non-fatal */
          }
        }
      }

      if (event.type === "session.idle") {
        const active = findActivePlan(projectRootForSidecar);
        const reason = shouldBlockStop(active?.spec.status ?? null);
        if (reason) {
          await client.app.log({
            body: {
              service: "sentinal",
              level: "warn",
              message: `[Sentinal] ${reason}`,
            },
          });
        }
      }
    },

    // ─── compaction.autocontinue ───────────────────────────────────────────
    // Fires after compaction completes. Pause if TDD is RED; inject spec
    // resume directive if a spec is active. Experimental — wrap in try/catch.
    "compaction.autocontinue": async (_input, output) => {
      try {
        const result = await handleCompactionAutocontinue(
          sidecar,
          projectRootForSidecar,
        );
        if (!result.shouldContinue) output.continue = false;
        result.context.forEach((c) => output.context.push(c));
      } catch (e) {
        log(
          `compaction.autocontinue error: ${e instanceof Error ? e.message : e}`,
        );
      }
    },

    // ─── Native tools ──────────────────────────────────────────────────────
    tool: {
      sentinal_tdd_status: createTddStatusTool(sidecar),
    },
  };
};

export default SentinalPlugin;
