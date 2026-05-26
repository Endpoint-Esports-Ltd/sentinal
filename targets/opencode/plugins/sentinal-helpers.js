/**
 * Sentinal Plugin Helpers
 *
 * Extracted helper functions for the OpenCode plugin to keep the
 * main plugin file under the 600-line limit.
 */
import { existsSync, accessSync, constants } from "node:fs";
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
export function resolveProjectRoot(worktree, directory, opts) {
    const getCwd = opts?.cwd ?? (() => process.cwd());
    const checkExists = opts?.exists ?? existsSync;
    const checkWritable = opts?.isWritable ??
        ((p) => {
            try {
                accessSync(p, constants.W_OK);
                return true;
            }
            catch {
                return false;
            }
        });
    // Build deduplicated candidate list in priority order
    const candidates = [];
    for (const c of [worktree, directory, getCwd()]) {
        if (typeof c === "string" && c.length > 0 && !candidates.includes(c)) {
            candidates.push(c);
        }
    }
    for (const candidate of candidates) {
        // Reject filesystem root — can't safely create .sentinal there
        if (candidate === "/" ||
            candidate === "\\" ||
            /^[A-Z]:[\\/]?$/i.test(candidate)) {
            continue;
        }
        if (!checkExists(candidate))
            continue;
        if (!checkWritable(candidate))
            continue;
        return { root: candidate };
    }
    return {
        root: null,
        reason: candidates.length === 0
            ? "No project root candidates provided (worktree, directory, and cwd all empty)"
            : `No writable project root found. Tried: ${candidates.join(", ")}`,
    };
}
// ─── Tool Redirect Hints ──────────────────────────────────────────────────────
const VAGUE_GREP_INDICATORS = [
    /^how\s/i,
    /^what\s/i,
    /^where\s/i,
    /^why\s/i,
    /^find\s.*that/i,
    /\bworks?\b/i,
    /\bhandles?\b/i,
    /\bimplements?\b/i,
];
export function getGrepHint(pattern) {
    if (VAGUE_GREP_INDICATORS.some((r) => r.test(pattern))) {
        return "[Hint] This grep pattern looks like a semantic query. Consider using a code search tool or reading relevant files directly.";
    }
    return null;
}
export function getFetchHint() {
    return "[Hint] For full page rendering, consider using the MCP web-fetch tool if available.";
}
/**
 * Query sidecar for file-specific observations and return a guidance hint.
 * Returns null if no relevant observations exist.
 */
export async function getPreEditGuide(sidecar, filePath, projectRoot) {
    try {
        const basename = filePath.split("/").pop() ?? filePath;
        const results = await sidecar.memorySearch({
            query: basename,
            project: projectRoot,
            limit: 10,
        });
        const relevant = results.filter((r) => r.filePaths?.some((fp) => fp === filePath || filePath.endsWith(fp) || fp.endsWith(filePath)));
        if (relevant.length === 0)
            return null;
        const lines = [`[Sentinal] Context for ${basename}:`];
        for (const hit of relevant.slice(0, 5)) {
            const date = new Date(hit.timestamp).toISOString().split("T")[0];
            lines.push(`- [${hit.type}] ${date}: ${hit.title}`);
        }
        return lines.join("\n");
    }
    catch {
        return null;
    }
}
/**
 * Check for concurrent sessions on the same project via sidecar.
 * Returns a warning message or null if no conflicts.
 */
export async function checkSessionConflict(sidecar, currentSessionId, projectRoot) {
    try {
        const sessions = await sidecar.getActiveSessions();
        const others = sessions.filter((s) => s.id !== currentSessionId && s.projectPath === projectRoot);
        if (others.length === 0)
            return null;
        const descriptions = others.map((s) => `${s.id} (${s.assistant})`);
        return `[Sentinal] Warning: ${others.length} other active session(s) on this project:\n${descriptions.map((d) => `  - ${d}`).join("\n")}\nEdits may conflict.`;
    }
    catch {
        return null;
    }
}
/**
 * Trigger bulk TDD state transitions via sidecar.
 * Fire-and-forget — errors are silently swallowed.
 */
export async function transitionTddState(sidecar, action, specId) {
    try {
        await sidecar.tddTransition(action, specId);
    }
    catch {
        /* non-fatal */
    }
}
//# sourceMappingURL=sentinal-helpers.js.map