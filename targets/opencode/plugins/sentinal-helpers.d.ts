/**
 * Sentinal Plugin Helpers
 *
 * Extracted helper functions for the OpenCode plugin to keep the
 * main plugin file under the 600-line limit.
 */
export interface ResolveProjectRootResult {
  root: string | null;
  reason?: string;
}
/**
 * Resolve a safe, writable project root from OpenCode plugin context values.
 *
 * OpenCode can pass `/` (filesystem root) as `worktree` or `directory` when
 * launched in a non-git directory. This function tries candidates in priority
 * order (worktree → directory → cwd) and returns the first one that:
 *   - is not the filesystem root (`/`, `\`, or a bare drive letter like `C:\`)
 *   - exists on disk
 *   - is writable by the current user
 *
 * Returns `{ root: null, reason }` when no valid candidate is found, allowing
 * the caller to skip per-project `.sentinal/` writes gracefully.
 *
 * The `opts` parameter allows injecting fake filesystem deps in unit tests.
 */
export declare function resolveProjectRoot(
  worktree: string | undefined,
  directory: string | undefined,
  opts?: {
    cwd?: () => string;
    exists?: (p: string) => boolean;
    isWritable?: (p: string) => boolean;
  },
): ResolveProjectRootResult;
export declare function getGrepHint(pattern: string): string | null;
export declare function getFetchHint(): string;
interface SidecarLike {
  memorySearch(opts: {
    query: string;
    project: string;
    limit: number;
  }): Promise<
    Array<{
      id: number;
      title: string;
      type: string;
      timestamp: number;
      filePaths: string[];
    }>
  >;
}
/**
 * Query sidecar for file-specific observations and return a guidance hint.
 * Returns null if no relevant observations exist.
 */
export declare function getPreEditGuide(
  sidecar: SidecarLike,
  filePath: string,
  projectRoot: string,
): Promise<string | null>;
interface SessionCheckSidecar {
  getActiveSessions(): Promise<
    Array<{
      id: string;
      assistant: string;
      projectPath: string;
    }>
  >;
}
/**
 * Check for concurrent sessions on the same project via sidecar.
 * Returns a warning message or null if no conflicts.
 */
export declare function checkSessionConflict(
  sidecar: SessionCheckSidecar,
  currentSessionId: string,
  projectRoot: string,
): Promise<string | null>;
interface TddTransitionSidecar {
  tddTransition(
    action: "confirm_red" | "confirm_green",
    specId?: string,
  ): Promise<{
    count: number;
  }>;
}
/**
 * Trigger bulk TDD state transitions via sidecar.
 * Fire-and-forget — errors are silently swallowed.
 */
export declare function transitionTddState(
  sidecar: TddTransitionSidecar,
  action: "confirm_red" | "confirm_green",
  specId?: string,
): Promise<void>;
export {};
//# sourceMappingURL=sentinal-helpers.d.ts.map
