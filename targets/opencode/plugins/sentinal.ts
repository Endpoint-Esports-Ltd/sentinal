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
import { isTestFile, getExpectedTestPaths } from "../../../src/utils/tdd.js";
import { checkNestPatterns, isNestFile } from "../../../src/checkers/nestjs.js";
import { isAngularFile } from "../../../src/checkers/angular.js";
import { detectFramework } from "../../../src/checkers/detect.js";
import { checkFileLength } from "../../../src/utils/file-length.js";
import { analyzeEvent, EventBuffer, MIN_CAPTURE_CONFIDENCE, TEST_FAIL_INDICATORS, TEST_PASS_INDICATORS } from "../../../src/memory/capture.js";
import type { ToolEvent } from "../../../src/memory/capture.js";
import { findActivePlan, shouldBlockStop } from "../../../src/spec/detect.js";
import { aggregateTokenUsage, CONTEXT_CHECK_INTERVAL } from "../../../src/sessions/token-usage.js";
import { getContextWarning } from "../../../src/sessions/context-display.js";
import type { SessionMessage } from "../../../src/sessions/token-usage.js";
import { SidecarClient } from "../../../src/sidecar/client.js";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from "node:fs";
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
      log(options: { body: { service: string; level: string; message: string } }): Promise<void>;
    };
    session: {
      messages(options: { path: { id: string } }): Promise<unknown>;
    };
  };
  $: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}

type Plugin = (context: PluginContext) => Promise<PluginHooks>;

interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: { directory: string; worktree: string }): Promise<string>;
}

interface PluginHooks {
  "tool.execute.before"?: (input: { tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;
  "tool.execute.after"?: (input: { tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;
  "experimental.session.compacting"?: (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>;
  event?: (input: { event: { type: string; properties?: { info?: { id?: string } }; sessionID?: string } }) => Promise<void>;
  tool?: Record<string, ToolDefinition>;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

const VAGUE_GREP_INDICATORS = [
  /^how\s/i, /^what\s/i, /^where\s/i, /^why\s/i,
  /^find\s.*that/i, /\bworks?\b/i, /\bhandles?\b/i, /\bimplements?\b/i,
];

interface CompactState {
  activePlan: string | null;
  memoryContext: string | null;
  timestamp: string;
  cwd: string;
}

// ─── Node.js-compatible helpers ──────────────────────────────────────────────

const SENTINAL_DIR = join(homedir(), ".sentinal");
const DEBUG_LOG_PATH = join(SENTINAL_DIR, "plugin.debug.log");

/** Append a timestamped line to ~/.sentinal/plugin.debug.log */
function log(message: string): void {
  try {
    if (!existsSync(SENTINAL_DIR)) mkdirSync(SENTINAL_DIR, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `${ts} ${message}\n`);
  } catch { /* non-fatal — never crash the plugin for logging */ }
}

/** Spawn a sentinal sub-command if the PID file is stale or missing. */
function autoStartProcess(pidFile: string, ...args: string[]): void {
  const pidPath = join(SENTINAL_DIR, pidFile);
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isNaN(pid)) { process.kill(pid, 0); return; }
    } catch { /* stale PID */ }
  }
  const binPath = join(SENTINAL_DIR, "bin", "sentinal");
  if (!existsSync(binPath)) return;
  try { const c = spawn(binPath, args, { stdio: "ignore", detached: true }); c.unref(); } catch { /* non-fatal */ }
}

function stopProcess(pidFile: string): void {
  const pidPath = join(SENTINAL_DIR, pidFile);
  if (!existsSync(pidPath)) return;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!Number.isNaN(pid)) process.kill(pid, "SIGTERM");
    unlinkSync(pidPath);
  } catch { /* ignore */ }
}

function stopDashboard(): void { stopProcess("server.pid"); }
function stopSidecar(): void { stopProcess("sidecar.pid"); }

// ─── TDD via sidecar ─────────────────────────────────────────────────────────

/** TDD guard via sidecar: returns error message if blocked, null if allowed. */
async function sidecarTddGuard(
  sidecar: SidecarClient,
  toolName: string,
  filePath: string,
  cwd: string,
): Promise<string | null> {
  if (!["write", "edit", "multiedit", "patch"].includes(toolName.toLowerCase())) return null;
  if (isTestFile(filePath)) return null;
  if (!/\.(ts|tsx)$/.test(filePath)) return null;

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
    const isEdit = ["write", "edit", "multiedit", "patch"].includes(toolName.toLowerCase());

    // Case 1: Test file written → TEST_WRITTEN
    if (isEdit && filePath && isTestFile(filePath)) {
      const implMatch = filePath.match(/^(.+)\.(spec|test)\.(ts|tsx|js|jsx)$/);
      const implPath = implMatch ? `${implMatch[1]}.${implMatch[3]}` : filePath;
      await sidecar.setTddState({ filePath: implPath, state: "TEST_WRITTEN", testFilePath: filePath });
      return;
    }

    // Case 2: Bash shows test failure → RED_CONFIRMED (set on last known TEST_WRITTEN file)
    // Note: this is a simplified version — the full tracker in Claude Code hooks queries
    // all active TDD states and transitions them. For now we rely on the guard endpoint
    // which reads the latest state from the sidecar.
    if (toolName.toLowerCase() === "bash" && bashOutput && TEST_FAIL_INDICATORS.some(r => r.test(bashOutput))) {
      // TODO: Add /tdd-state/transition endpoint to sidecar for bulk state transitions
      return;
    }

    // Case 3: Bash shows test pass → clear state
    if (toolName.toLowerCase() === "bash" && bashOutput && TEST_PASS_INDICATORS.some(r => r.test(bashOutput))) {
      // TODO: Add /tdd-state/transition endpoint to sidecar for bulk state transitions
    }
  } catch { /* non-fatal */ }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const SentinalPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const projectRoot = worktree || directory;

  const eventBuffer = new EventBuffer(20);
  let sidecar: SidecarClient | null = null;
  let sessionId: string | null = null;
  let toolCallCount = 0;

  // Auto-start sidecar + dashboard (Node.js-compatible spawn)
  try { autoStartProcess("sidecar.pid", "sidecar", "start"); } catch { /* non-fatal */ }
  try { autoStartProcess("server.pid", "serve"); } catch { /* non-fatal */ }

  // Inline: avoid importing config.ts which pulls in types.ts → zod
  const memoryEnabled = (() => {
    try {
      const cfgPath = join(SENTINAL_DIR, "config.json");
      if (existsSync(cfgPath)) {
        const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
        return raw?.memory?.enabled !== false;
      }
    } catch { /* invalid JSON */ }
    return true;
  })();

  if (memoryEnabled) {
    try { sidecar = await SidecarClient.connectWithRetry(10, 200); } catch { /* unavailable */ }
    if (sidecar) {
      log("Connected to sidecar");
    } else {
      log("Sidecar unavailable — memory features disabled");
    }
  } else {
    log("Memory system disabled via config");
  }

  // Eager session creation (fallback if session.created never fires)
  sessionId = `opencode-${Date.now()}`;
  try {
    if (sidecar) {
      await sidecar.createSession({ id: sessionId, projectPath: projectRoot, assistant: "opencode" });
      log(`Eager session created: ${sessionId} (sidecar)`);
    }
  } catch (e) {
    log(`Eager session insert failed: ${e instanceof Error ? e.message : e}`);
  }

  await client.app.log({
    body: { service: "sentinal", level: "info", message: `Sentinal initialized for: ${projectRoot}` },
  });

  return {
    "tool.execute.before": async (input, output) => {
      const { tool } = input;
      const args = output.args || {};

      // TDD Guard via sidecar
      const filePath = args.file_path ?? args.filePath ?? args.path;
      if (sidecar && typeof filePath === "string") {
        const guardMsg = await sidecarTddGuard(sidecar, tool, filePath, projectRoot);
        if (guardMsg) throw new Error(guardMsg);
      }

      if (tool === "grep" && typeof args.pattern === "string") {
        if (VAGUE_GREP_INDICATORS.some((r) => r.test(args.pattern as string))) {
          await client.app.log({
            body: {
              service: "sentinal", level: "info",
              message: `[Hint] This grep pattern looks like a semantic query. Consider using a code search tool or reading relevant files directly.`,
            },
          });
        }
      }

      if (tool === "fetch") {
        await client.app.log({
          body: {
            service: "sentinal", level: "info",
            message: `[Hint] For full page rendering, consider using the MCP web-fetch tool if available.`,
          },
        });
      }
    },

    "tool.execute.after": async (input, output) => {
      const QUALITY_TOOLS = ["write", "edit", "patch"];
      const MEMORY_TOOLS = ["write", "edit", "patch", "bash", "shell", "terminal"];

      // Context monitoring — only query OpenCode's session API with a real session ID
      // (our eager "opencode-<ts>" IDs cause Hono validator errors in the TUI)
      toolCallCount++;
      const hasRealSessionId = sessionId && !sessionId.startsWith("opencode-");
      if (hasRealSessionId && toolCallCount % CONTEXT_CHECK_INTERVAL === 0) {
        try {
          const response = await client.session.messages({ path: { id: sessionId! } });
          const messages = ((response as unknown as { data?: unknown })?.data ?? response ?? []) as SessionMessage[];
          if (Array.isArray(messages)) {
            const usage = aggregateTokenUsage(messages);
            const warning = getContextWarning(usage);
            if (warning) {
              await client.app.log({
                body: { service: "sentinal", level: usage.percent >= 95 ? "error" : "warn", message: `[Sentinal] ${warning}` },
              });
            }
          }
        } catch { /* non-fatal */ }
      }

      if (!MEMORY_TOOLS.includes(input.tool)) return;

      const filePath = output.args?.filePath || output.args?.file_path || output.args?.path;
      const issues: string[] = [];
      let shouldBlock = false;

      // Quality checks
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

            const nestResults = checkNestPatterns(filePath, content);
            for (const r of nestResults) {
              issues.push(`[NestJS] ${r.message}`);
              if (r.severity === "error") shouldBlock = true;
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
          } catch { /* file might not exist yet */ }

          if (!isTestFile(filePath)) {
            const testPaths = getExpectedTestPaths(filePath);
            if (testPaths.length > 0 && !testPaths.some((tp) => existsSync(tp))) {
              issues.push(`No companion test file found. Expected: ${testPaths[0]}`);
            }
          }

          try {
            const cmd = $`npx tsc --noEmit 2>&1` as { quiet(): { nothrow(): Promise<{ exitCode: number; text(): Promise<string> }> } };
            const result = await cmd.quiet().nothrow();
            if (result.exitCode !== 0) {
              const out = await result.text();
              const errors = out.split("\n").filter((l: string) => l.includes("error TS")).slice(0, 5);
              if (errors.length > 0) issues.push(`TypeScript errors:\n${errors.join("\n")}`);
            }
          } catch { /* tsc not available */ }

          if (issues.length > 0) {
            const level = shouldBlock ? "error" : "warn";
            await client.app.log({
              body: {
                service: "sentinal", level,
                message: `Quality issues in ${filePath}:\n\n${issues.map((i) => `- ${i}`).join("\n")}`,
              },
            });
            if (shouldBlock) throw new Error(`[Sentinal] Blocking due to critical issues:\n${issues.join("\n")}`);
          }
        }
      }

      // TDD Tracker via sidecar
      if (sidecar) {
        const trackerFilePath = typeof filePath === "string" ? filePath : undefined;
        const bashOutput = ["bash", "shell", "terminal"].includes(input.tool)
          ? (output.args?.output as string | undefined)
          : undefined;
        await sidecarTddTrack(sidecar, input.tool, trackerFilePath, bashOutput);
      }

      // Memory capture
      if (sidecar && sessionId) {
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
            await sidecar.addObservation({
              sessionId, projectPath: projectRoot, type: decision.type,
              title: decision.title, content: decision.content,
              filePaths: decision.filePaths, tags: decision.tags,
              metadata: { source: "auto-capture", confidence: decision.confidence, toolName: input.tool },
            });
          }
        } catch { /* non-fatal */ }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const active = findActivePlan(projectRoot);
      const activePlan = active?.filePath ?? null;
      const planStatus = active?.spec.status ?? null;

      let memoryContext: string | null = null;
      try {
        if (sidecar) {
          if (active) await sidecar.syncSpec(active.filePath, projectRoot);
          const restored = await sidecar.restoreContext(projectRoot);
          if (restored.hasMemory) memoryContext = restored.markdown;
        }
      } catch { /* non-fatal */ }

      const stateDir = join(projectRoot, ".sentinal");
      mkdirSync(stateDir, { recursive: true });
      const state: CompactState = {
        activePlan, memoryContext,
        timestamp: new Date().toISOString(),
        cwd: projectRoot,
      };
      writeFileSync(join(stateDir, "compact-state.json"), JSON.stringify(state, null, 2));

      if (activePlan) {
        output.context.push(`## Sentinal /spec Workflow State

**Active Plan:** ${activePlan}
**Status:** ${planStatus}

Resume the /spec workflow by reading the plan file and continuing from where you left off.
- If PENDING: Continue with implementation or await user approval
- If COMPLETE: Run verification phase

Use \`/spec ${activePlan}\` to resume the workflow.`);
      }

      if (memoryContext) output.context.push(memoryContext);
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Real session ID lives at event.properties.info.id (OpenCode SDK structure)
        const newSessionId = event.properties?.info?.id ?? event.sessionID ?? `opencode-${Date.now()}`;
        const previousSessionId = sessionId;
        sessionId = newSessionId;
        log(`session.created: ${sessionId}${previousSessionId ? ` (replacing ${previousSessionId})` : ""}`);

        try {
          if (sidecar) {
            if (previousSessionId && previousSessionId !== newSessionId) {
              await sidecar.endSession(previousSessionId, { notification: false });
            }
            await sidecar.createSession({ id: sessionId, projectPath: projectRoot, assistant: "opencode" });
          }
          log(`Session inserted: ${sessionId}`);
        } catch (e) {
          log(`insertSession failed: ${e instanceof Error ? e.message : e}`);
        }

        // Restore memory context
        try {
          if (sidecar) {
            const restored = await sidecar.restoreContext(projectRoot);
            if (restored.hasMemory && restored.markdown) {
              await client.app.log({ body: { service: "sentinal", level: "info", message: restored.markdown } });
            }
          }
        } catch { /* non-fatal */ }

        // Restore spec plan state from previous compaction
        const stateFile = join(projectRoot, ".sentinal", "compact-state.json");
        if (existsSync(stateFile)) {
          try {
            const state: CompactState = JSON.parse(readFileSync(stateFile, "utf-8"));
            if (state.activePlan && existsSync(state.activePlan)) {
              await client.app.log({ body: { service: "sentinal", level: "info", message: `[Sentinal] Session restored. Active plan: ${state.activePlan}\nResume with: /spec ${state.activePlan}` } });
            }
          } catch { /* ignore */ }
        }
      }

      // session.updated fires on resume and metadata changes — use it to
      // capture the real session ID when session.created didn't fire (e.g. `opencode -s <id>`)
      if (event.type === "session.updated") {
        const realId = event.properties?.info?.id;
        if (realId && sessionId?.startsWith("opencode-")) {
          const previousSessionId = sessionId;
          sessionId = realId;
          log(`session.updated: adopted real session ID ${sessionId} (replacing eager ${previousSessionId})`);
          if (sidecar) {
            // End the eager placeholder session
            try { await sidecar.endSession(previousSessionId, { notification: false }); }
            catch (e) { log(`end eager session failed: ${e instanceof Error ? e.message : e}`); }
            // Create (or re-adopt) the real session — may already exist from a prior instance
            try { await sidecar.createSession({ id: sessionId, projectPath: projectRoot, assistant: "opencode" }); }
            catch (e) { log(`create real session failed (may already exist): ${e instanceof Error ? e.message : e}`); }
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
        const bufferPath = join(projectRoot, ".sentinal", "event-buffer.json");
        try { if (existsSync(bufferPath)) unlinkSync(bufferPath); } catch { /* non-fatal */ }
      }

      if (event.type === "session.idle") {
        const active = findActivePlan(projectRoot);
        const reason = shouldBlockStop(active?.spec.status ?? null);
        if (reason) {
          await client.app.log({
            body: { service: "sentinal", level: "warn", message: `[Sentinal] ${reason}` },
          });
        }
      }
    },

    // NOTE: sentinal-check tool removed — OpenCode's resolveTools passes plugin
    // tool args through toJSONSchema() which expects Zod schema instances, not
    // plain objects. Quality checks are available via the MCP server instead.
  };
};

export default SentinalPlugin;
