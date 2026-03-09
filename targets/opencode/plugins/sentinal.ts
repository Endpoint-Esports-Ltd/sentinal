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
 * - Session state preservation across compaction
 * - Persistent memory: auto-capture learning moments + restore at session start
 *
 * NOTE: Prettier and ESLint are handled automatically by OpenCode's
 * built-in formatter system - we don't need to run them manually!
 *
 * This plugin imports shared utilities from src/ for deduplication with Claude Code.
 */

// Import paths work for both development (symlink) and installed (copied) scenarios
// The parent directory contains src/ in both cases
import { isTestFile, getExpectedTestPaths, checkNestPatterns, isNestFile } from "../src/index.ts";
import { isAngularFile } from "../src/checkers/angular.ts";
import { detectFramework, detectPackageManager } from "../src/checkers/detect.ts";
import { MemoryStore, MemoryService } from "../src/index.ts";
import { isMemoryEnabled } from "../src/memory/config.ts";
import { analyzeEvent, EventBuffer, MIN_CAPTURE_CONFIDENCE, type ToolEvent } from "../src/memory/capture.ts";
import { restoreContext } from "../src/memory/restore.ts";

// Type definitions for OpenCode plugin system
interface PluginContext {
  project: { name: string; path: string };
  directory: string;
  worktree: string;
  client: {
    app: {
      log(options: { body: { service: string; level: string; message: string } }): Promise<void>;
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

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const WARN_THRESHOLD = 400;
const BLOCK_THRESHOLD = 600;
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

function checkFileLength(lineCount: number, filePath: string): { severity: "warn" | "block"; message: string } | null {
  if (isTestFile(filePath)) return null;

  if (lineCount > BLOCK_THRESHOLD) {
    return {
      severity: "block",
      message: `File exceeds ${BLOCK_THRESHOLD} lines (${lineCount}). Split into smaller modules.`
    };
  }

  if (lineCount > WARN_THRESHOLD) {
    return {
      severity: "warn",
      message: `File has ${lineCount} lines (warning threshold: ${WARN_THRESHOLD}). Consider splitting.`
    };
  }

  return null;
}

export const SentinalPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const projectRoot = worktree || directory;

  // Memory system: event buffer for pattern detection
  const eventBuffer = new EventBuffer(20);
  let memoryService: MemoryService | null = null;
  let sessionId: string | null = null;

  if (isMemoryEnabled()) {
    try {
      const store = new MemoryStore();
      memoryService = new MemoryService(store);
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
      if (!["write", "edit", "patch"].includes(input.tool)) return;

      const filePath = output.args?.filePath || output.args?.file_path || output.args?.path;
      if (!filePath || typeof filePath !== "string") return;

      const ext = filePath.slice(filePath.lastIndexOf("."));
      if (!TS_EXTENSIONS.includes(ext)) return;

      const issues: string[] = [];
      let shouldBlock = false;

      try {
        const content = readFileSync(filePath, "utf-8");
        const lineCount = content.split("\n").length;

        const lengthResult = checkFileLength(lineCount, filePath);
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

      // Memory capture: analyze tool event for learning moments
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
      const plansDir = join(projectRoot, "docs", "plans");
      let activePlan: string | null = null;
      let planStatus: string | null = null;

      if (existsSync(plansDir)) {
        try {
          const files = readdirSync(plansDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .reverse();

          for (const file of files) {
            const content = readFileSync(join(plansDir, file), "utf-8");
            const match = content.match(/\*\*Status:\*\*\s*(PENDING|COMPLETE|VERIFIED)/);
            if (match && match[1] !== "VERIFIED") {
              activePlan = join(plansDir, file);
              planStatus = match[1];
              break;
            }
          }
        } catch {
          // Ignore
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

      if (event.type === "session.idle") {
        const plansDir = join(projectRoot, "docs", "plans");
        if (existsSync(plansDir)) {
          try {
            const files = readdirSync(plansDir)
              .filter((f) => f.endsWith(".md"))
              .sort()
              .reverse();

            for (const file of files) {
              const content = readFileSync(join(plansDir, file), "utf-8");
              const match = content.match(/\*\*Status:\*\*\s*(PENDING|COMPLETE)/);
              if (match) {
                const planPath = join(plansDir, file);
                await client.app.log({
                  body: {
                    service: "sentinal",
                    level: "warn",
                    message: `[Sentinal] Active spec plan is ${match[1]}.\n\nPlan: ${planPath}\n\nConsider resuming with: /spec ${planPath}`,
                  },
                });
                break;
              }
            }
          } catch {
            // Ignore
          }
        }
      }
    },
  };
};

export default SentinalPlugin;
