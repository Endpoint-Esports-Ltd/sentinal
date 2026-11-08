/**
 * The files an OpenCode `apply_patch` call touches (cross-project scope,
 * Phase 1). Its only argument is `patchText`, so without this the per-file
 * guard and checks never saw patch edits at all.
 *
 * Recognised headers (one per line, leading whitespace allowed):
 * `*** Add File: `, `*** Update File: `, `*** Delete File: `, `*** Move to: `.
 * Anything else is ignored; a patch with no recognised header yields `[]`.
 *
 * ⛔ Pure, no `bun:sqlite` — bundled into the OpenCode plugin.
 */

import { resolve } from "node:path";

const HEADER = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):(.*)$/;

/** Absolute, de-duplicated target paths (relative ones resolve against `base`). */
export function patchFilePaths(
  patchText: string | undefined | null,
  base: string,
): string[] {
  if (typeof patchText !== "string") return [];
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = HEADER.exec(line);
    const path = m?.[1]?.trim();
    if (!path) continue;
    const abs = resolve(base, path);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** OpenCode tools whose only file argument is `patchText`. */
export const PATCH_TOOLS: readonly string[] = ["apply_patch", "patch"];

/**
 * The files a tool call names: a patch tool's targets (resolved against
 * `base`), else the first string of `filePath` / `file_path` / `path` (raw,
 * as before). `[]` when it names none.
 */
export function toolFilePaths(
  tool: string,
  args: Record<string, unknown>,
  base: string,
): string[] {
  if (
    PATCH_TOOLS.includes(tool.toLowerCase()) &&
    typeof args.patchText === "string"
  )
    return patchFilePaths(args.patchText, base);
  for (const key of ["filePath", "file_path", "path"]) {
    const v = args[key];
    if (typeof v === "string" && v !== "") return [v];
  }
  return [];
}
