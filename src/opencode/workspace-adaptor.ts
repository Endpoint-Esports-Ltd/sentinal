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

// ─── Worktree resolution timeout sentinel ────────────────────────────────────
// Distinct from `null` (which means "sidecar answered: no worktree exists").
// TIMEOUT means "the sidecar did NOT answer in time" — an INDETERMINATE result.
// Collapsing these two into `null` was the root cause of the silent-main leak
// (2026-07-24): on timeout we cannot know a worktree isn't active, so falling
// back to the main checkout silently corrupts edits.
const TIMEOUT = Symbol("worktree-resolve-timeout");

// Default worktree-resolve timeout. Raised well above the original 1000 ms — a
// busy/cold sidecar legitimately needs longer, and combined with the per-slug
// cache below the resolve only races on the FIRST target() call for a plan.
const DEFAULT_RESOLVE_TIMEOUT_MS = 8000;

// A loud, non-main sentinel: routing file ops to an unreachable OpenCode
// workspace URL fails visibly and can NEVER write to the local main checkout.
// Used when a spec worktree is ACTIVE but we cannot positively resolve it.
const UNRESOLVED_REMOTE_TARGET: WorkspaceTarget = {
  type: "remote",
  url: "http://sentinal.invalid/worktree-unresolved",
};

export interface SpecWorktreeAdaptorOptions {
  /** Resolve-race timeout in ms (default DEFAULT_RESOLVE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Loud-warning sink (default no-op). The plugin wires this to client.app.log. */
  logger?: (message: string) => void;
  /** Existence check for a resolved worktree dir (default node existsSync). */
  existsSync?: (path: string) => boolean;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the Sentinal Spec Worktree workspace adaptor.
 *
 * @param sidecar - Live SidecarClient, or null when unavailable.
 * @param executor - Injectable command executor (default: Node child_process.execSync).
 *   Tests inject a no-op to avoid spawning real git/sentinal processes.
 * @param opts - Timeout / logger / existsSync injection (tests + plugin wiring).
 */
export function createSpecWorktreeAdaptor(
  sidecar: SidecarClient | null,
  executor?: (cmd: string, args: string[]) => void,
  opts?: SpecWorktreeAdaptorOptions,
): WorkspaceAdaptor {
  const exec = executor ?? defaultExecutor;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  const logWarn = opts?.logger ?? (() => {});
  const pathExists = opts?.existsSync ?? existsSync;

  // Per-slug cache of a POSITIVELY resolved worktree path. Resolved once at the
  // first target() call for an active plan and reused, so subsequent file ops do
  // not re-race the sidecar. Invalidated in remove().
  const worktreeCache = new Map<string, string>();

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
    //
    // Resolves the workspace `directory` that OpenCode's file tools use. When a
    // spec worktree is ACTIVE (extra.planPath present) it MUST resolve to the
    // worktree or fail LOUD — it must NEVER silently return the main checkout,
    // which was the root cause of the edit-leak / false-GREEN bug (2026-07-24).
    async target(config: WorkspaceInfo): Promise<WorkspaceTarget> {
      const mainFallback: WorkspaceTarget = {
        type: "local",
        directory: config.directory ?? ".",
      };

      const extra = config.extra as { planPath?: string } | null;
      const planPath = extra?.planPath;
      // No active spec worktree → normal (non-worktree) flow; main is correct.
      if (!planPath) return mainFallback;

      const slug = slugFromPlanPath(planPath);
      if (!slug || !config.directory) return mainFallback;

      // A spec worktree IS active from here on. Any failure to positively
      // resolve it must be LOUD, never a silent fall-through to main.
      const loudUnresolved = (reason: string): WorkspaceTarget => {
        logWarn(
          `[sentinal] worktree "${slug}" is active but could not be resolved ` +
            `(${reason}); refusing to target the main checkout to avoid ` +
            `leaking edits. File operations will fail until the worktree ` +
            `resolves — re-run once the sidecar is responsive.`,
        );
        return UNRESOLVED_REMOTE_TARGET;
      };

      // Cache hit: reuse the once-resolved worktree path (no re-race), but
      // re-validate it still exists (abandon can leave a detached dir).
      const cached = worktreeCache.get(slug);
      if (cached) {
        if (pathExists(cached)) return { type: "local", directory: cached };
        worktreeCache.delete(slug);
        return loudUnresolved("cached worktree path no longer exists");
      }

      if (!sidecar) return loudUnresolved("sidecar unavailable");

      let resolved:
        | Awaited<ReturnType<SidecarClient["resolveWorktreeBySlug"]>>
        | typeof TIMEOUT;
      try {
        resolved = await Promise.race([
          sidecar.resolveWorktreeBySlug(slug, config.directory),
          new Promise<typeof TIMEOUT>((resolve) =>
            setTimeout(() => resolve(TIMEOUT), timeoutMs),
          ),
        ]);
      } catch {
        return loudUnresolved("sidecar resolve error");
      }

      // INDETERMINATE (timed out): we do NOT know whether a worktree exists →
      // must NOT fall back to main. This is the core fix.
      if (resolved === TIMEOUT)
        return loudUnresolved("sidecar resolve timed out");

      // Positive resolve: honor the worktree (validate it exists on disk).
      if (resolved?.worktreePath) {
        if (!pathExists(resolved.worktreePath)) {
          return loudUnresolved("resolved worktree path does not exist");
        }
        worktreeCache.set(slug, resolved.worktreePath);
        return { type: "local", directory: resolved.worktreePath };
      }

      // Sidecar POSITIVELY confirmed no worktree for this slug. Even though a
      // planPath is present, there is genuinely no worktree to target; falling
      // back to the project directory matches prior non-worktree behavior.
      return mainFallback;
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
        const extra = config.extra as { planPath?: string } | null;
        const planPath = extra?.planPath;
        if (!planPath) return;

        // Invalidate any cached worktree path for this plan so a later target()
        // re-resolves rather than reusing a now-abandoned worktree.
        worktreeCache.delete(slugFromPlanPath(planPath));

        if (!sidecar) return;

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
