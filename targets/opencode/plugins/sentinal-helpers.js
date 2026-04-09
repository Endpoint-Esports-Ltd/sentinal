// targets/opencode/plugins/sentinal-helpers.ts
import { existsSync, accessSync, constants } from "node:fs";
function resolveProjectRoot(worktree, directory, opts) {
  const getCwd = opts?.cwd ?? (() => process.cwd());
  const checkExists = opts?.exists ?? existsSync;
  const checkWritable = opts?.isWritable ?? ((p) => {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
  const candidates = [];
  for (const c of [worktree, directory, getCwd()]) {
    if (typeof c === "string" && c.length > 0 && !candidates.includes(c)) {
      candidates.push(c);
    }
  }
  for (const candidate of candidates) {
    if (candidate === "/" || candidate === "\\" || /^[A-Z]:[\\/]?$/i.test(candidate)) {
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
    reason: candidates.length === 0 ? "No project root candidates provided (worktree, directory, and cwd all empty)" : `No writable project root found. Tried: ${candidates.join(", ")}`
  };
}
var VAGUE_GREP_INDICATORS = [
  /^how\s/i,
  /^what\s/i,
  /^where\s/i,
  /^why\s/i,
  /^find\s.*that/i,
  /\bworks?\b/i,
  /\bhandles?\b/i,
  /\bimplements?\b/i
];
function getGrepHint(pattern) {
  if (VAGUE_GREP_INDICATORS.some((r) => r.test(pattern))) {
    return "[Hint] This grep pattern looks like a semantic query. Consider using a code search tool or reading relevant files directly.";
  }
  return null;
}
function getFetchHint() {
  return "[Hint] For full page rendering, consider using the MCP web-fetch tool if available.";
}
async function getPreEditGuide(sidecar, filePath, projectRoot) {
  try {
    const basename = filePath.split("/").pop() ?? filePath;
    const results = await sidecar.memorySearch({
      query: basename,
      project: projectRoot,
      limit: 10
    });
    const relevant = results.filter((r) => r.filePaths?.some((fp) => fp === filePath || filePath.endsWith(fp) || fp.endsWith(filePath)));
    if (relevant.length === 0)
      return null;
    const lines = [`[Sentinal] Context for ${basename}:`];
    for (const hit of relevant.slice(0, 5)) {
      const date = new Date(hit.timestamp).toISOString().split("T")[0];
      lines.push(`- [${hit.type}] ${date}: ${hit.title}`);
    }
    return lines.join(`
`);
  } catch {
    return null;
  }
}
async function checkSessionConflict(sidecar, currentSessionId, projectRoot) {
  try {
    const sessions = await sidecar.getActiveSessions();
    const others = sessions.filter((s) => s.id !== currentSessionId && s.projectPath === projectRoot);
    if (others.length === 0)
      return null;
    const descriptions = others.map((s) => `${s.id} (${s.assistant})`);
    return `[Sentinal] Warning: ${others.length} other active session(s) on this project:
${descriptions.map((d) => `  - ${d}`).join(`
`)}
Edits may conflict.`;
  } catch {
    return null;
  }
}
async function transitionTddState(sidecar, action, specId) {
  try {
    await sidecar.tddTransition(action, specId);
  } catch {}
}
export {
  transitionTddState,
  resolveProjectRoot,
  getPreEditGuide,
  getGrepHint,
  getFetchHint,
  checkSessionConflict
};
