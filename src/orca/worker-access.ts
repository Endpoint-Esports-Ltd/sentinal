/**
 * Prompt-free, read-only directory access for pre-warmed OpenCode workers
 * (docs/plans/2026-10-01-orca-worker-access.md).
 *
 * OpenCode asks "Access external directory" for any path outside the
 * worker's worktree (`external_directory` defaults to `ask`), and "Allow
 * always" lasts only for that session. Sentinal launches pre-warmed workers
 * itself, so it passes an inline config for THAT process only:
 * `env OPENCODE_CONFIG_CONTENT='<json>' opencode` (`env` so fish, csh and
 * nushell accept it). Nothing is written to the user's config files.
 *
 * Verified live (OpenCode 1.18.34): `external_directory` takes ABSOLUTE
 * globs; edit/write rules match `path.relative(worktree, file)`, so the
 * read-only denies are RELATIVE (`../../../*`). Agent-level rules come last
 * and the last match wins, so the deny is repeated for every built-in agent.
 * Bash is not covered by edit rules.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const WORKER_AGENTS = [
  "build",
  "plan",
  "general",
  "explore",
  "spec-task",
] as const;
const GLOB = /[*?[\]{}]/;

/**
 * Directories a worker may read without a prompt: `defaults` (coordinator
 * and main checkouts) plus absolute paths in `SENTINAL_ORCA_WORKER_ALLOW_DIRS`
 * (comma list, `~` expanded; relative or empty entries ignored). `null` when
 * set to `none`.
 */
export function workerAllowDirs(
  env: Record<string, string | undefined>,
  defaults: readonly string[],
  home: string,
): string[] | null {
  const raw = env.SENTINAL_ORCA_WORKER_ALLOW_DIRS?.trim();
  if (raw?.toLowerCase() === "none") return null;
  const extra = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === "~" || s.startsWith("~/") ? home + s.slice(1) : s));
  const out: string[] = [];
  for (const d of [...defaults, ...extra]) {
    if (!isAbsolute(d)) continue;
    const clean = d.length > 1 ? d.replace(/\/+$/, "") : d;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

export interface OpencodeLaunch {
  /** The `--command` for `orca terminal create`. */
  command: string;
  access?: { dirs: string[]; readOnly: true };
  /** Directories left out because their name contains glob characters. */
  skippedDirs?: string[];
  /** Why the inline config was not used. */
  skipped?: string;
}

const realOrRaw = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A permission block as a map; a bare string action becomes the `*` rule. */
const asRuleMap = (v: unknown): Json =>
  isObject(v) ? { ...v } : typeof v === "string" ? { "*": v } : {};

/** Add `rules` to `obj[key]` (a rule map), wrapping a bare string action. */
function addRules(obj: Json, key: string, rules: Json): void {
  const cur = obj[key];
  const base: Json = isObject(cur)
    ? cur
    : typeof cur === "string"
      ? { "*": cur }
      : {};
  obj[key] = { ...base, ...rules };
}

export function opencodeLaunch(o: {
  agent: string;
  /** The worker's own worktree (its OpenCode `instance.worktree`). */
  worktree: string;
  dirs: readonly string[] | null;
  env: Record<string, string | undefined>;
  platform?: string;
  /** Tests: identity instead of realpath. */
  realpath?: (p: string) => string;
}): OpencodeLaunch {
  const plain = (skipped?: string): OpencodeLaunch => ({
    command: o.agent,
    ...(skipped ? { skipped } : {}),
  });
  if (o.agent !== "opencode") return plain();
  if ((o.platform ?? process.platform) === "win32") {
    return plain("inline config is not passed on Windows");
  }
  if (!o.dirs) return plain("SENTINAL_ORCA_WORKER_ALLOW_DIRS=none");

  const real = o.realpath ?? realOrRaw;
  const wt = resolve(real(o.worktree));
  const dirs: string[] = [];
  const skippedDirs: string[] = [];
  const allow: Json = {};
  const deny: Json = {};
  for (const d of o.dirs) {
    const abs = resolve(real(d));
    if (GLOB.test(d) || GLOB.test(abs)) {
      skippedDirs.push(d);
      continue;
    }
    const rel = relative(wt, abs);
    // The worktree itself, or a directory inside it: the worker owns it.
    if (rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`))) continue;
    dirs.push(d);
    allow[`${abs}/**`] = "allow";
    deny[`${rel}/*`] = "deny";
  }
  if (dirs.length === 0) {
    return { ...plain(), ...(skippedDirs.length ? { skippedDirs } : {}) };
  }

  let config: Json = {};
  const existing = o.env.OPENCODE_CONFIG_CONTENT;
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!isObject(parsed)) throw new Error("not an object");
      config = parsed;
    } catch {
      return plain(
        "the existing OPENCODE_CONFIG_CONTENT is not a JSON object; left untouched",
      );
    }
  }
  const permission = asRuleMap(config.permission);
  addRules(permission, "external_directory", allow);
  addRules(permission, "edit", deny);
  const agents: Json = isObject(config.agent) ? { ...config.agent } : {};
  for (const name of WORKER_AGENTS) {
    const a: Json = isObject(agents[name]) ? { ...agents[name] } : {};
    const p = asRuleMap(a.permission);
    addRules(p, "edit", deny);
    agents[name] = { ...a, permission: p };
  }
  const json = JSON.stringify({ ...config, permission, agent: agents });
  return {
    command: `env OPENCODE_CONFIG_CONTENT=${shellQuote(json)} ${o.agent}`,
    access: { dirs, readOnly: true },
    ...(skippedDirs.length ? { skippedDirs } : {}),
  };
}
