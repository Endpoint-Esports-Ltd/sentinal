/**
 * Related projects — `<workspace>/.sentinal/related.json`
 * (docs/plans/2026-11-05-cross-project-scope-phase-2.md, Task 1).
 *
 *   { "projects": [ { "name": "api", "path": "../api" }, { "path": "/abs/web" } ] }
 *
 * `path` is relative to the declaring WORKSPACE (the checkout holding the
 * file) or absolute; `name` defaults to the path's basename. Each entry's
 * identity costs one git spawn (`resolveProjectIdentity`) — callers are the
 * MCP server and the sidecar, never hot hooks.
 *
 * A project that finds a `related.json` also gets its `.sentinal/.gitignore`
 * upgraded (`ensureSentinalGitignore`): the file is committed, and an
 * un-upgraded project would silently ignore it. If it is still ignored after
 * that (a user-customised `.gitignore`), `gitignored: true` plus a warning.
 *
 * Never throws. ⛔ Free of `bun:sqlite`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ensureSentinalGitignore } from "../memory/shared.js";
import { resolveProjectIdentity } from "./identity.js";

export interface RelatedProject {
  name: string;
  /** Realpath when the directory exists, else the resolved path. */
  path: string;
  /** Storage key; the resolved path when the directory does not exist. */
  identity: string;
  exists: boolean;
  /** `<path>/.sentinal/rules` exists. */
  hasRules: boolean;
}

export interface RelatedProjectsResult {
  projects: RelatedProject[];
  warnings: string[];
  /** Present only when `related.json` exists: is it still gitignored? */
  gitignored?: boolean;
}

export interface RelatedDeps {
  /** Directory → storage key. Default `resolveProjectIdentity`. */
  identity?: (path: string) => string;
}

const RelatedSchema = z.object({
  projects: z.array(
    z.object({
      name: z.string().min(1).optional(),
      path: z.string().min(1),
    }),
  ),
});

export const RELATED_GITIGNORED_WARNING =
  "`.sentinal/related.json` is gitignored — add `!related.json` to `.sentinal/.gitignore`";

export function relatedJsonPath(workspace: string): string {
  return join(workspace, ".sentinal", "related.json");
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `git check-ignore` — true when git would ignore the file. */
function isGitIgnored(workspace: string): boolean {
  try {
    if (!existsSync(join(workspace, ".git"))) return false;
    const r = spawnSync(
      "git",
      ["check-ignore", "-q", join(".sentinal", "related.json")],
      { cwd: workspace, stdio: "ignore", timeout: 5_000 },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

function safeIdentity(fn: (p: string) => string, p: string): string {
  try {
    const k = fn(p);
    return typeof k === "string" && k.trim() !== "" ? k : p;
  } catch {
    return p;
  }
}

/** The related projects a workspace declares. Missing file → empty, no warning. */
export function loadRelatedProjects(
  workspace: string,
  deps: RelatedDeps = {},
): RelatedProjectsResult {
  const toIdentity = deps.identity ?? resolveProjectIdentity;
  try {
    if (typeof workspace !== "string" || workspace.trim() === "")
      return { projects: [], warnings: [] };
    const file = relatedJsonPath(workspace);
    if (!existsSync(file)) return { projects: [], warnings: [] };

    const warnings: string[] = [];
    ensureSentinalGitignore(workspace);
    const gitignored = isGitIgnored(workspace);
    if (gitignored) warnings.push(RELATED_GITIGNORED_WARNING);

    let parsed: z.infer<typeof RelatedSchema>;
    try {
      const result = RelatedSchema.safeParse(
        JSON.parse(readFileSync(file, "utf-8")),
      );
      if (!result.success) {
        warnings.push(
          `${file}: invalid related.json — ${result.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
        return { projects: [], warnings, gitignored };
      }
      parsed = result.data;
    } catch (err) {
      warnings.push(
        `${file}: invalid related.json — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { projects: [], warnings, gitignored };
    }

    const self = safeIdentity(toIdentity, workspace);
    const projects: RelatedProject[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.projects) {
      try {
        const abs = isAbsolute(entry.path)
          ? resolve(entry.path)
          : resolve(workspace, entry.path);
        const exists = isDir(abs);
        const path = exists ? realOr(abs) : abs;
        const identity = exists ? safeIdentity(toIdentity, path) : path;
        if (identity === self || seen.has(identity)) continue;
        seen.add(identity);
        projects.push({
          name: entry.name ?? basename(path),
          path,
          identity,
          exists,
          hasRules: exists && isDir(join(path, ".sentinal", "rules")),
        });
      } catch {
        /* skip a pathological entry */
      }
    }
    return { projects, warnings, gitignored };
  } catch {
    return { projects: [], warnings: [] };
  }
}
