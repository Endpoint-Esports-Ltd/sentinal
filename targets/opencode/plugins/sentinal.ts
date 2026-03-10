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
 * - TypeScript type checking (tsc --noEmit)
 * - Tool redirection hints (semantic search suggestions)
 * - Context usage monitoring with visual bar (▓/░ blocks)
 * - Session state preservation across compaction
 * - Persistent memory: auto-capture learning moments + restore at session start
 *
 * NOTE: Prettier and ESLint are handled automatically by OpenCode's
 * built-in formatter system - we don't need to run them manually!
 *
 * This plugin imports shared utilities from src/ for deduplication with Claude Code.
 */

import {
  isTestFile, getExpectedTestPaths, checkNestPatterns, isNestFile,
  isAngularFile, detectFramework, detectPackageManager,
  checkFileLength,
  MemoryStore, MemoryService, isMemoryEnabled,
  analyzeEvent, EventBuffer, MIN_CAPTURE_CONFIDENCE, type ToolEvent,
  restoreContext,
  findActivePlan, shouldBlockStop, SpecStore,
  aggregateTokenUsage, getContextWarning, CONTEXT_CHECK_INTERVAL,
  autoStartDashboard, stopServer,
  type AssistantType, type SessionMessage,
} from "@endpoint/sentinal";

// Type definitions for OpenCode plugin system
interface PluginContext {
  project: { name: string; path: string };
  directory: string;
  worktree: string;
  client: {
    app: {
      log(options: { body: { service: string; level: string; message: string } }): Promise<void>;
    };
    session: {
      messages(options: { path: { id: string } }): Promise<unknown>;
    };
  };
  $: (strings: TemplateStringsArray, ...values: unknown[]) => any;
}

type Plugin = (context: PluginContext) => Promise<PluginHooks>;

interface PluginHooks {
  "tool.execute.before"?: (input: { tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;
  "tool.execute.after"?: (input: { tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;
  "experimental.session.compacting"?: (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>;
  event?: (input: { event: { type: string; sessionID?: string } }) => Promise<void>;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

const VAGUE_GREP_INDICATORS = [
  /^how\s/i, /^what\s/i, /^where\s/i, /^why\s/i,
  /^find\s.*that/i, /\bworks?\b/i, /\bhandles?\b/i, /\bimplements?\b/i
];

interface CompactState {
  activePlan: string | null;
  memoryContext: string | null;
  timestamp: string;
  cwd: string;
}

export const SentinalPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const projectRoot = worktree || directory;

  // Memory system: event buffer for pattern detection
  const eventBuffer = new EventBuffer(20);
  let memoryStore: MemoryStore | null = null;
  let memoryService: MemoryService | null = null;
  let sessionId: string | null = null;

  // Context monitoring: throttle checks to every N tool calls
  let toolCallCount = 0;

  if (isMemoryEnabled()) {
    try {
      memoryStore = new MemoryStore();
      memoryService = new MemoryService(memoryStore);
    } catch {
      // Memory unavailable, continue without it
    }
  }

  await client.app.log({
    body: {
      service: "sentinal",
      level: "info",
      message: `Sentinal initialized for: ${projectRoot}`,
    },
  });

  return {
    "tool.execute.before": async (input, output) => {
      const { tool } = input;
      const args = output.args || {};

      if (tool === "grep" && typeof args.pattern === "string") {
        if (VAGUE_GREP_INDICATORS.some((r) => r.test(args.pattern as string))) {
          await client.app.log({
            body: {
              service: "sentinal",
              level: "info",
              message: `[Hint] This grep pattern looks like a semantic query. Consider using a code search tool or reading relevant files directly.`,
            },
          });
        }
      }

      if (tool === "fetch") {
        await client.app.log({
          body: {
            service: "sentinal",
            level: "info",
            message: `[Hint] For full page rendering, consider using the MCP web-fetch tool if available.`,
          },
        });
      }
    },

    "tool.execute.after": async (input, output) => {
      const QUALITY_TOOLS = ["write", "edit", "patch"];
      const MEMORY_TOOLS = ["write", "edit", "patch", "bash", "shell", "terminal"];

      // Context monitoring: check every N tool calls (any tool, not just MEMORY_TOOLS)
      toolCallCount++;
      if (sessionId && toolCallCount % CONTEXT_CHECK_INTERVAL === 0) {
        try {
          const response = await client.session.messages({ path: { id: sessionId } });
          const messages = ((response as any)?.data ?? response ?? []) as SessionMessage[];
          if (Array.isArray(messages)) {
            const usage = aggregateTokenUsage(messages);
            const warning = getContextWarning(usage);
            if (warning) {
              await client.app.log({
                body: { service: "sentinal", level: usage.percent >= 95 ? "error" : "warn", message: `[Sentinal] ${warning}` },
              });
            }
          }
        } catch {
          // Context monitoring failure is non-fatal
        }
      }

      if (!MEMORY_TOOLS.includes(input.tool)) return;

      const filePath = output.args?.filePath || output.args?.file_path || output.args?.path;
      const issues: string[] = [];
      let shouldBlock = false;

      // Quality checks: only for file-writing tools on TS files
      if (QUALITY_TOOLS.includes(input.tool) && filePath && typeof filePath === "string") {
        const ext = filePath.slice(filePath.lastIndexOf("."));
        if (TS_EXTENSIONS.includes(ext)) {
          try {
            const content = readFileSync(filePath, "utf-8");
            const lineCount = content.split("\n").length;

            const lengthResult = checkFileLength(filePath, lineCount);
            if (lengthResult) {
              issues.push(lengthResult.message);
              if (lengthResult.severity === "block") shouldBlock = true;
            }

            if (checkNestPatterns(filePath, content).length > 0) {
              const nestResults = checkNestPatterns(filePath, content);
              for (const r of nestResults) {
                issues.push(`[NestJS] ${r.message}`);
                if (r.severity === "error") shouldBlock = true;
              }
            }

            const frameworks = detectFramework(projectRoot);
            if (frameworks.includes("angular") && isAngularFile(filePath)) {
              if (content.includes("@Component") && !content.includes("standalone: true")) {
                issues.push(`[Angular] Standalone components are required in Angular 17+. Add 'standalone: true' to @Component decorator.`);
              }
              if (content.includes("*ngIf") || content.includes("*ngFor")) {
                issues.push(`[Angular] Use Angular 17+ control flow (@if, @for) instead of *ngIf/*ngFor.`);
              }
            }
          } catch {
            // File might not exist yet
          }

          if (!isTestFile(filePath)) {
            const testPaths = getExpectedTestPaths(filePath);
            if (testPaths.length > 0 && !testPaths.some((tp) => existsSync(tp))) {
              issues.push(`No companion test file found. Expected: ${testPaths[0]}`);
            }
          }

          try {
            const result = await $`npx tsc --noEmit 2>&1`.quiet().nothrow();
            if (result.exitCode !== 0) {
              const out = await result.text();
              const errors = out.split("\n").filter((l) => l.includes("error TS")).slice(0, 5);
              if (errors.length > 0) {
                issues.push(`TypeScript errors:\n${errors.join("\n")}`);
              }
            }
          } catch {
            // tsc not available
          }

          if (issues.length > 0) {
            const level = shouldBlock ? "error" : "warn";
            await client.app.log({
              body: {
                service: "sentinal",
                level,
                message: `Quality issues in ${filePath}:\n\n${issues.map((i) => `• ${i}`).join("\n")}`,
              },
            });

            if (shouldBlock) {
              throw new Error(`[Sentinal] Blocking due to critical issues:\n${issues.join("\n")}`);
            }
          }
        }
      }

      // Memory capture: analyze tool event for learning moments (runs for all MEMORY_TOOLS)
      if (memoryService && sessionId) {
        try {
          const event: ToolEvent = {
            toolName: input.tool,
            filePath: typeof filePath === "string" ? filePath : undefined,
            success: !shouldBlock,
            output: issues.length > 0 ? issues.join("\n").slice(0, 500) : undefined,
            timestamp: Date.now(),
          };

          eventBuffer.push(event);
          const decision = analyzeEvent(event, eventBuffer);

          if (decision.shouldCapture && decision.confidence >= MIN_CAPTURE_CONFIDENCE) {
            memoryService.addObservation({
              sessionId,
              projectPath: projectRoot,
              timestamp: Date.now(),
              type: decision.type,
              title: decision.title,
              content: decision.content,
              filePaths: decision.filePaths,
              tags: decision.tags,
              metadata: { source: "auto-capture", confidence: decision.confidence, toolName: input.tool },
            });
          }
        } catch {
          // Memory capture failure is non-fatal
        }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      // Use shared spec detection (handles both metadata formats)
      const active = findActivePlan(projectRoot);
      const activePlan = active?.filePath ?? null;
      const planStatus = active?.spec.status ?? null;

      // Sync active spec to SQLite index before compaction
      if (active && memoryStore) {
        try {
          const specStore = new SpecStore(memoryStore);
          specStore.syncFromPlanFile(active.filePath, projectRoot);
        } catch {
          // Spec sync failure is non-fatal
        }
      }

      // Save memory context for post-compact restoration
      let memoryContext: string | null = null;
      if (memoryService) {
        try {
          const restored = restoreContext(memoryService, { projectPath: projectRoot });
          if (restored.hasMemory) {
            memoryContext = restored.markdown;
          }
        } catch {
          // Memory unavailable, continue without it
        }
      }

      // Persist state to disk for session restoration
      const stateDir = join(projectRoot, ".sentinal");
      mkdirSync(stateDir, { recursive: true });
      const state: CompactState = {
        activePlan,
        memoryContext,
        timestamp: new Date().toISOString(),
        cwd: projectRoot,
      };
      writeFileSync(join(stateDir, "compact-state.json"), JSON.stringify(state, null, 2));

      // Inject spec plan context into compacted prompt
      if (activePlan) {
        output.context.push(`## Sentinal /spec Workflow State

**Active Plan:** ${activePlan}
**Status:** ${planStatus}

Resume the /spec workflow by reading the plan file and continuing from where you left off.
- If PENDING: Continue with implementation or await user approval
- If COMPLETE: Run verification phase

Use \`/spec ${activePlan}\` to resume the workflow.`);
      }

      // Inject memory context into compacted prompt
      if (memoryContext) {
        output.context.push(memoryContext);
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Track session ID for memory capture
        sessionId = event.sessionID ?? `opencode-${Date.now()}`;

        // Create session record in SQLite
        if (memoryStore) {
          try {
            memoryStore.insertSession({
              id: sessionId,
              startTime: Date.now(),
              endTime: null,
              projectPath: projectRoot,
              assistant: "opencode" as AssistantType,
              summary: null,
              transcriptPath: null,
            });
          } catch {
            // Non-fatal — session tracking is supplementary
          }
        }

        // Auto-start dashboard if not running
        try {
          autoStartDashboard();
        } catch {
          // Non-fatal — dashboard is supplementary
        }

        // Restore memory context at session start
        if (memoryService) {
          try {
            const restored = restoreContext(memoryService, { projectPath: projectRoot });
            if (restored.hasMemory && restored.markdown) {
              await client.app.log({
                body: {
                  service: "sentinal",
                  level: "info",
                  message: restored.markdown,
                },
              });
            }
          } catch {
            // Memory restore failure is non-fatal
          }
        }

        // Restore spec plan state from previous compaction
        const stateFile = join(projectRoot, ".sentinal", "compact-state.json");
        if (existsSync(stateFile)) {
          try {
            const state: CompactState = JSON.parse(readFileSync(stateFile, "utf-8"));
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
            // Ignore
          }
        }
      }

      if (event.type === "session.deleted") {
        if (memoryStore && sessionId) {
          try {
            // End session record in SQLite
            memoryStore.endSession(sessionId);

            // Create session-end notification
            memoryStore.insertNotification({
              type: "info",
              title: "Session ended",
              message: `Session ${sessionId.slice(0, 8)} ended`,
              source: "session-end",
              sessionId,
            });

            // Auto-stop dashboard if no active sessions remain
            const activeSessions = memoryStore.getActiveSessions();
            if (activeSessions.length === 0) {
              stopServer();
            }
          } catch {
            // Non-fatal — session may not have been started
          }
        }

        // Clean up event buffer (no longer needed after session ends)
        const bufferPath = join(projectRoot, ".sentinal", "event-buffer.json");
        try {
          if (existsSync(bufferPath)) {
            unlinkSync(bufferPath);
          }
        } catch {
          // Non-fatal cleanup
        }
      }

      if (event.type === "session.idle") {
        // Use shared spec detection + stop guard logic
        const active = findActivePlan(projectRoot);
        const reason = shouldBlockStop(active?.spec.status ?? null);
        if (reason) {
          // Note: session.idle can warn but cannot block (unlike Claude Code's Stop hook)
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
  };
};

export default SentinalPlugin;
