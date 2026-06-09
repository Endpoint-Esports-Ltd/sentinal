/**
 * Sentinal Spec Worktree — OpenCode Workspace Adaptor
 *
 * Registers a "sentinal-spec-worktree" adaptor in OpenCode's workspace creation
 * UI. When selected, the workspace pre-fills from the active spec plan and
 * targets the associated git worktree.
 *
 * Types are inlined (not imported from @opencode-ai/plugin) because that package
 * lives in OpenCode's own node_modules, not sentinal's. The shapes match the
 * WorkspaceAdaptor API from @opencode-ai/plugin v1.4.4+.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { SidecarClient } from "../sidecar/client.js";

// ─── Inlined OpenCode workspace types ────────────────────────────────────────
// Matches @opencode-ai/plugin WorkspaceAdaptor API (confirmed in SDK types).
// Do NOT import from @opencode-ai/plugin — the package is not in sentinal's deps.

export interface WorkspaceInfo {
  id: string;
  type: string;
  name: string;
  branch: string | null;
  directory: string | null;
  extra: unknown | null;
  projectID: string;
}

export type WorkspaceTarget =
  | { type: "local"; directory: string }
  | { type: "remote"; url: string | URL; headers?: Record<string, string> };

export interface WorkspaceAdaptor {
  name: string;
  description: string;
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>;
  create(config: WorkspaceInfo, from?: WorkspaceInfo): Promise<void>;
  remove(config: WorkspaceInfo): Promise<void>;
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a plan slug from a full plan file path. */
function slugFromPlanPath(planPath: string): string {
  return basename(planPath, ".md");
}

/** Read the compact-state.json from a project directory. Returns null on any error. */
function readCompactState(
  projectDir: string,
): { activePlan: string | null } | null {
  try {
    const path = join(projectDir, ".sentinal", "compact-state.json");
    if (!existsSync(path)) return null;
    const state = JSON.parse(readFileSync(path, "utf-8")) as {
      activePlan?: string | null;
    };
    return { activePlan: state.activePlan ?? null };
  } catch {
    return null;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the Sentinal Spec Worktree workspace adaptor.
 *
 * @param sidecar - Live SidecarClient, or null when unavailable.
 * @param executor - Injectable command executor (default: Node child_process.execSync).
 *   Tests inject a no-op to avoid spawning real git/sentinal processes.
 */
export function createSpecWorktreeAdaptor(
  sidecar: SidecarClient | null,
  executor?: (cmd: string, args: string[]) => void,
): WorkspaceAdaptor {
  const exec = executor ?? defaultExecutor;

  return {
    name: "Sentinal Spec Worktree",
    description:
      "Create an isolated git worktree for a Sentinal spec plan. Pre-fills from the active plan.",

    // ── configure ────────────────────────────────────────────────────────────
    async configure(config: WorkspaceInfo): Promise<WorkspaceInfo> {
      try {
        let planPath: string | null = null;

        // 1. Try sidecar (fast, 1s timeout)
        if (sidecar) {
          const spec = await Promise.race([
            sidecar.getCurrentSpec(config.directory ?? ""),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 1000),
            ),
          ]);
          if (spec?.planFile) planPath = spec.planFile;
        }

        // 2. Fallback: compact-state.json
        if (!planPath && config.directory) {
          const state = readCompactState(config.directory);
          if (state?.activePlan) planPath = state.activePlan;
        }

        if (!planPath) return config;

        const slug = slugFromPlanPath(planPath);
        return {
          ...config,
          name: `spec/${slug}`,
          branch: `sentinal/spec-${slug}`,
          extra: { planPath },
        };
      } catch {
        return config;
      }
    },

    // ── target ───────────────────────────────────────────────────────────────
    async target(config: WorkspaceInfo): Promise<WorkspaceTarget> {
      const fallback: WorkspaceTarget = {
        type: "local",
        directory: config.directory ?? ".",
      };

      try {
        const extra = config.extra as { planPath?: string } | null;
        const planPath = extra?.planPath;
        if (!planPath) return fallback;

        const slug = slugFromPlanPath(planPath);
        if (!slug || !config.directory) return fallback;

        if (sidecar) {
          const wt = await Promise.race([
            sidecar.resolveWorktreeBySlug(slug, config.directory),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 1000),
            ),
          ]);
          if (wt?.worktreePath) {
            return { type: "local", directory: wt.worktreePath };
          }
        }
      } catch {
        /* non-fatal — return fallback */
      }

      return fallback;
    },

    // ── create ───────────────────────────────────────────────────────────────
    async create(config: WorkspaceInfo): Promise<void> {
      try {
        const extra = config.extra as { planPath?: string } | null;
        const planPath = extra?.planPath ?? config.name;
        if (!planPath) return;

        // Derive slug: strip "spec/" prefix if name form used, or from path
        const slug = planPath.includes("/")
          ? slugFromPlanPath(planPath)
          : planPath.replace(/^spec\//, "");

        if (!slug) return;

        exec("sentinal", [
          "worktree",
          "create",
          slug,
          "--project",
          config.directory ?? ".",
        ]);
      } catch {
        // Non-fatal — sentinal may not be in PATH (common on macOS GUI apps).
        // The user will see an error in plugin.debug.log but the workspace
        // creation dialog won't crash.
      }
    },

    // ── remove ───────────────────────────────────────────────────────────────
    async remove(config: WorkspaceInfo): Promise<void> {
      try {
        if (!sidecar) return;

        const extra = config.extra as { planPath?: string } | null;
        const planPath = extra?.planPath;
        if (!planPath) return;

        const slug = slugFromPlanPath(planPath);
        const wt = await sidecar.resolveWorktreeBySlug(
          slug,
          config.directory ?? "",
        );
        if (!wt) return;

        await sidecar.abandonWorktree(wt.id);
      } catch {
        /* non-fatal */
      }
    },
  };
}

// ─── Default executor ─────────────────────────────────────────────────────────

function defaultExecutor(cmd: string, args: string[]): void {
  // Use Node's execSync — safe to call from the OpenCode plugin (Node.js runtime).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execSync } =
    require("node:child_process") as typeof import("node:child_process");
  execSync(`${cmd} ${args.join(" ")}`, { stdio: "ignore" });
}
