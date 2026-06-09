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
interface PluginContext {
  project: {
    name: string;
    path: string;
  };
  directory: string;
  worktree: string;
  client: {
    app: {
      log(options: {
        body: {
          service: string;
          level: string;
          message: string;
        };
      }): Promise<void>;
    };
    session: {
      messages(options: {
        path: {
          id: string;
        };
      }): Promise<unknown>;
    };
  };
  $: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}
type Plugin = (context: PluginContext) => Promise<PluginHooks>;
interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: {
      directory: string;
      worktree: string;
    },
  ): Promise<unknown>;
}
interface PluginHooks {
  "tool.execute.before"?: (
    input: {
      tool: string;
    },
    output: {
      args: Record<string, unknown>;
    },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: {
      tool: string;
    },
    output: {
      args: Record<string, unknown>;
    },
  ) => Promise<void>;
  "experimental.session.compacting"?: (
    input: {
      sessionID: string;
    },
    output: {
      context: string[];
      prompt?: string;
    },
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => Promise<void>;
  "compaction.autocontinue"?: (
    input: {
      sessionID: string;
    },
    output: {
      continue: boolean;
      context: string[];
    },
  ) => Promise<void>;
  event?: (input: {
    event: {
      type: string;
      properties?: {
        info?: {
          id?: string;
        };
      };
      sessionID?: string;
    };
  }) => Promise<void>;
  tool?: Record<string, ToolDefinition>;
}
export declare const SentinalPlugin: Plugin;
export default SentinalPlugin;
//# sourceMappingURL=sentinal.d.ts.map
