/**
 * Type definitions for OpenCode Plugin System
 *
 * These types are based on the OpenCode plugin documentation at:
 * https://opencode.ai/docs/plugins
 *
 * Note: Once @opencode-ai/plugin is published to npm, these can be replaced
 * with the official package.
 */

import { z } from "zod";

/**
 * Context provided to plugins
 */
export interface PluginContext {
  /** Current project information */
  project: {
    name: string;
    path: string;
  };
  /** Current working directory */
  directory: string;
  /** Git worktree path (if in a worktree) */
  worktree: string;
  /** OpenCode SDK client for interacting with the AI */
  client: PluginClient;
  /** Bun's shell API for executing commands */
  $: ShellFunction;
}

/**
 * Shell function type (Bun's $`` template literal)
 */
export interface ShellFunction {
  (strings: TemplateStringsArray, ...values: unknown[]): ShellPromise;
}

export interface ShellPromise extends Promise<ShellResult> {
  quiet(): ShellPromise;
  nothrow(): ShellPromise;
  text(): Promise<string>;
}

export interface ShellResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  text(): string;
}

/**
 * OpenCode SDK client
 */
export interface PluginClient {
  app: {
    log(options: { body: LogBody }): Promise<void>;
  };
}

export interface LogBody {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * Tool execution input
 */
export interface ToolExecuteInput {
  tool: string;
  sessionID?: string;
  messageID?: string;
}

/**
 * Tool execution output (mutable)
 */
export interface ToolExecuteOutput {
  args: Record<string, unknown>;
}

/**
 * Session compacting input
 */
export interface SessionCompactingInput {
  sessionID: string;
}

/**
 * Session compacting output (mutable)
 */
export interface SessionCompactingOutput {
  context: string[];
  prompt?: string;
}

/**
 * Event types
 */
export interface SessionEvent {
  type:
    | "session.created"
    | "session.compacted"
    | "session.deleted"
    | "session.diff"
    | "session.error"
    | "session.idle"
    | "session.status"
    | "session.updated";
  sessionID?: string;
  data?: unknown;
}

export interface EventInput {
  event: SessionEvent;
}

/**
 * Plugin hooks
 */
export interface PluginHooks {
  /** Called before a tool is executed */
  "tool.execute.before"?: (
    input: ToolExecuteInput,
    output: ToolExecuteOutput
  ) => Promise<void>;

  /** Called after a tool is executed */
  "tool.execute.after"?: (
    input: ToolExecuteInput,
    output: ToolExecuteOutput
  ) => Promise<void>;

  /** Called when a session is being compacted (experimental) */
  "experimental.session.compacting"?: (
    input: SessionCompactingInput,
    output: SessionCompactingOutput
  ) => Promise<void>;

  /** General event handler */
  event?: (input: EventInput) => Promise<void>;

  /** Custom tools */
  tool?: Record<string, ToolDefinition>;
}

/**
 * Plugin function type
 */
export type Plugin = (context: PluginContext) => Promise<PluginHooks>;

/**
 * Tool definition
 */
export interface ToolDefinition {
  description: string;
  args: Record<string, z.ZodType>;
  execute(
    args: Record<string, unknown>,
    context: ToolExecuteContext
  ): Promise<unknown>;
}

export interface ToolExecuteContext {
  agent: string;
  sessionID: string;
  messageID: string;
  directory: string;
  worktree: string;
}

/**
 * Tool helper function
 */
export interface ToolHelper {
  <T extends Record<string, z.ZodType>>(definition: {
    description: string;
    args: T;
    execute(
      args: { [K in keyof T]: z.infer<T[K]> },
      context: ToolExecuteContext
    ): Promise<unknown>;
  }): ToolDefinition;

  schema: typeof z;
}

/**
 * Declare the tool helper as available from @opencode-ai/plugin
 */
declare const tool: ToolHelper;

declare module "@opencode-ai/plugin" {
  export type { Plugin, PluginContext, PluginHooks, ToolDefinition };
  export { tool };
}
