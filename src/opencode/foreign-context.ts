/**
 * OpenCode — foreign rules and pre-edit hints for the system prompt
 * (docs/plans/2026-11-05-cross-project-scope-phase-2.md, Task 4).
 *
 * OpenCode rebuilds the system prompt every turn
 * (`experimental.chat.system.transform`), so "inject once" there means "keep
 * present for the rest of the session": every foreign project the session
 * EDITED contributes its rules block on every turn, under a total cap
 * (`FOREIGN_RULES_TOTAL_CHARS`; later projects degrade to pointer lists).
 * This is the OpenCode equivalent of Claude Code's once-per-session
 * `additionalContext`, which stays in the transcript.
 *
 * Path-scoped rules (`paths:`) join a project's block once a matching file is
 * edited. Pre-edit memory hints are queued and pushed ONCE on the next turn
 * (at most three, newest first) — before this they were only written to the
 * TUI log, which never reaches the model.
 *
 * Never throws. ⛔ Free of `bun:sqlite` — bundled into the plugin.
 */

import { basename, relative } from "node:path";
import type { FileProject } from "../project/file-project.js";
import {
  FOREIGN_RULES_MAX_CHARS,
  FOREIGN_RULES_TOTAL_CHARS,
  formatForeignRules,
  readProjectRules,
  rulesForFile,
  type RuleFile,
} from "../project/foreign-rules.js";

const MAX_QUEUED_HINTS = 3;

export interface ForeignProjectBlock {
  name: string;
  workspace: string;
  /** Rules that applied to at least one edited file, in rule-file order. */
  rules: RuleFile[];
}

/** One markdown block per project, within the total cap. */
export function buildForeignContext(
  projects: ForeignProjectBlock[],
  totalChars: number = FOREIGN_RULES_TOTAL_CHARS,
): string[] {
  const out: string[] = [];
  let remaining = totalChars;
  for (const p of projects) {
    if (p.rules.length === 0) continue;
    const text = formatForeignRules({
      projectName: p.name,
      workspace: p.workspace,
      rules: p.rules,
      maxChars: Math.max(0, Math.min(FOREIGN_RULES_MAX_CHARS, remaining)),
    });
    if (text === "") continue;
    out.push(text);
    remaining = Math.max(0, remaining - text.length);
  }
  return out;
}

interface ProjectState {
  name: string;
  workspace: string;
  all: RuleFile[];
  applied: Set<string>;
}

export interface ForeignContextDeps {
  readRules?: (workspace: string) => RuleFile[];
}

export interface ForeignContext {
  /** Record an edit of `absPath` (owned by `file`). */
  noteEdit(file: FileProject, absPath: string): void;
  /** Queue a model-visible hint for the next turn only. */
  queueHint(text: string | null | undefined): void;
  /** This turn's system-prompt blocks: foreign rules, then queued hints (drained). */
  systemBlocks(): string[];
  /** Foreign projects edited this session: identity → workspace. */
  touched(): Map<string, string>;
}

export function createForeignContext(
  deps: ForeignContextDeps = {},
): ForeignContext {
  const readRules = deps.readRules ?? readProjectRules;
  const projects = new Map<string, ProjectState>();
  let hints: string[] = [];

  return {
    noteEdit(file, absPath) {
      try {
        if (!file.foreign) return;
        let state = projects.get(file.identity);
        if (!state) {
          state = {
            name: basename(file.workspace),
            workspace: file.workspace,
            all: readRules(file.workspace),
            applied: new Set(),
          };
          projects.set(file.identity, state);
        }
        const rel = relative(state.workspace, absPath);
        for (const r of rulesForFile(state.all, rel)) state.applied.add(r.path);
      } catch {
        /* never block an edit */
      }
    },

    queueHint(text) {
      if (typeof text !== "string" || text.trim() === "") return;
      hints = [text, ...hints.filter((h) => h !== text)].slice(
        0,
        MAX_QUEUED_HINTS,
      );
    },

    systemBlocks() {
      try {
        const blocks = buildForeignContext(
          [...projects.values()].map((p) => ({
            name: p.name,
            workspace: p.workspace,
            rules: p.all.filter((r) => p.applied.has(r.path)),
          })),
        );
        const drained = hints;
        hints = [];
        return [...blocks, ...drained];
      } catch {
        return [];
      }
    },

    touched() {
      return new Map([...projects].map(([id, p]) => [id, p.workspace]));
    },
  };
}
