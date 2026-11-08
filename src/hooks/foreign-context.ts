/**
 * Claude Code — foreign rules injection, once per session per project
 * (docs/plans/2026-11-05-cross-project-scope-phase-2.md, Task 3).
 *
 * The first time a session edits a file in ANOTHER project, that project's
 * `.sentinal/rules` (filtered by `paths:`, capped) are returned for the
 * PreToolUse hint. A marker records which projects were already injected:
 *
 *   - `<session workspace>/.sentinal/injected-rules.json` when the session
 *     workspace is a git working tree: `{ "<session_id>": ["<rule file>", …] }`
 *     (absolute rule-file paths, so a `paths:`-scoped rule still arrives on
 *     the first edit it matches)
 *   - else `<Sentinal home>/injected-rules/<session_id>.json` (same shape) —
 *     a session started in `$HOME` must not write into Sentinal's runtime dir
 *     root, where `.sentinal/` is the global runtime directory.
 *
 * `clearInjectedRules` removes this session's entry — on SessionStart
 * (compact), so rules come back after compaction, and on SessionEnd.
 *
 * Writes are atomic (temp + rename); a corrupt marker counts as empty. Racing
 * hooks at worst inject twice. Never throws.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getSentinalHome } from "../memory/db-path.js";
import {
  resolveFileProject,
  sessionRootsFromCwd,
} from "../project/file-project.js";
import {
  FOREIGN_RULES_MAX_CHARS,
  formatForeignRules,
  readProjectRules,
  rulesForFile,
} from "../project/foreign-rules.js";

export interface ForeignContextDeps {
  /** Sentinal home (default `getSentinalHome()`, i.e. `~/.sentinal`). */
  home?: string;
  /** Directory → storage key (session cwd and foreign repo tops). */
  identity?: (path: string) => string;
}

type Marker = Record<string, string[]>;

/** Where this session's marker lives (see the module header). */
export function injectedRulesMarkerPath(
  sessionWorkspace: string,
  sessionId: string,
  home: string = getSentinalHome(),
): string {
  if (existsSync(join(sessionWorkspace, ".git")))
    return join(sessionWorkspace, ".sentinal", "injected-rules.json");
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
  return join(home, "injected-rules", `${safe}.json`);
}

function readMarker(path: string): Marker {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Marker = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v))
        out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function writeMarker(path: string, marker: Marker): void {
  try {
    if (Object.keys(marker).length === 0) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker, null, 2));
    renameSync(tmp, path);
  } catch {
    /* non-fatal: worst case the rules are injected again */
  }
}

export interface ForeignRulesHintInput {
  filePath: string;
  cwd: string;
  sessionId: string;
}

/** The rules block to add to the PreToolUse hint, or null. */
export function foreignRulesHint(
  input: ForeignRulesHintInput,
  deps: ForeignContextDeps = {},
): string | null {
  try {
    const { filePath, cwd, sessionId } = input;
    if (!filePath || !cwd) return null;
    const session = sessionRootsFromCwd(
      cwd,
      deps.identity ? { identity: deps.identity } : {},
    );
    const abs = resolve(cwd, filePath);
    const file = resolveFileProject(
      abs,
      session,
      deps.identity ? { identity: deps.identity } : {},
    );
    if (!file.foreign) return null;
    const all = readProjectRules(file.workspace);
    if (all.length === 0) return null;

    const markerPath = injectedRulesMarkerPath(
      session.workspace,
      sessionId,
      deps.home,
    );
    const marker = readMarker(markerPath);
    const key = sessionId || "unknown";
    const done = marker[key] ?? [];

    // ⛔ Globs match relative to the FOREIGN checkout, not the session's.
    // Tracked per RULE FILE, so a later edit matching another rule's `paths:`
    // still gets that rule (and only that rule).
    const rules = rulesForFile(all, relative(file.workspace, abs)).filter(
      (r) => !done.includes(r.path),
    );
    if (rules.length === 0) return null;
    const text = formatForeignRules({
      projectName: basename(file.workspace),
      workspace: file.workspace,
      rules,
      maxChars: FOREIGN_RULES_MAX_CHARS,
    });
    if (text === "") return null;

    marker[key] = [...done, ...rules.map((r) => r.path)];
    writeMarker(markerPath, marker);
    return text;
  } catch {
    return null;
  }
}

/** Forget what this session was shown (compaction, session end). */
export function clearInjectedRules(
  input: { cwd: string; sessionId: string },
  deps: ForeignContextDeps = {},
): void {
  try {
    if (!input.cwd || !input.sessionId) return;
    const session = sessionRootsFromCwd(
      input.cwd,
      deps.identity ? { identity: deps.identity } : {},
    );
    const path = injectedRulesMarkerPath(
      session.workspace,
      input.sessionId,
      deps.home,
    );
    if (!existsSync(path)) return;
    const marker = readMarker(path);
    delete marker[input.sessionId];
    writeMarker(path, marker);
  } catch {
    /* non-fatal */
  }
}
