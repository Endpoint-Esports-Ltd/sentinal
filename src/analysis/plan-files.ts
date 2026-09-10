/**
 * Per-task plan file parser.
 *
 * Produces the structured per-task view of a plan that nothing else provides:
 * which files each task claims, with what verb, whether they exist on disk,
 * and which execution wave the task belongs to.
 *
 * ## Why this is a standalone module
 *
 * - `extractSpecFiles` (`./helpers.ts`) returns a flat `Set<string>` for the
 *   whole plan. Its regex is a `gim` scan with no task-heading state machine,
 *   so it cannot attribute a path to a task, and it discards the verb.
 * - `spec_plan_parse` / `src/spec/parser.ts` expose neither per-task `Files:`
 *   nor the per-task `**Wave:**`. `parser.ts`'s `wave` is *plan-level*
 *   front-matter for master-plan children — a different field entirely.
 * - Extending `SpecTask` with `files` would ripple into `SpecTaskSchema`,
 *   `src/spec/store.ts` and a SQLite migration for no gain: the plan file is
 *   read directly here, exactly as `extractSpecFiles` already does.
 *
 * Path normalisation is deliberately **shared** with `extractSpecFiles` via the
 * exported `normalizeSpecFilePath`, so backtick / `./` / trailing-punctuation
 * handling cannot silently diverge into two copies.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { normalizeSpecFilePath } from "./helpers.js";

// --- Types ---

/**
 * The four-value verb union. The shipped template emits seven verbs
 * (`spec-plan.md:190-192` plus historical usage); they collapse onto these
 * four because only the create/modify/test/delete distinction changes how a
 * consumer treats the path. See `VERB_MAP`.
 */
export type PlanFileVerb = "create" | "modify" | "test" | "delete";

export interface PlanTaskFile {
  /** Repo-relative path, backticks and a leading `./` stripped. */
  path: string;
  verb: PlanFileVerb;
  /** Real filesystem check against `projectRoot`. `Create:` targets are `false`. */
  exists: boolean;
}

export interface PlanTaskFiles {
  /**
   * The leading integer of the heading label. `### Task 1a:` and
   * `### Task 1b:` both yield `1`; `### Task 8.2:` yields `8`. Use `id` when
   * you need to tell them apart.
   */
  task: number;
  /**
   * The raw heading label, verbatim: `"1"`, `"1a"`, `"8.2"`. Real plans in
   * this repo use all three forms. Kept as a string so no information is lost
   * to the numeric `task` field, and so the two halves of a split task remain
   * distinct entries.
   */
  id: string;
  /** Heading text after the colon. */
  title: string;
  /**
   * The per-task `**Wave:**` value, or `null` when absent or unparseable —
   * including the shipped template's literal `[1 | 2 | ...]` placeholder,
   * which must never become `NaN` or a throw.
   */
  wave: number | null;
  files: PlanTaskFile[];
}

// --- Patterns ---

/**
 * `### Task <label>: <title>`. The colon is **required**: real plans carry
 * appendix headings like `### Task 3 Evidence` and `### Task 0 Outcome (…)`
 * that are prose, not tasks. Those still terminate the preceding task section
 * (see `isSectionBreak`) so their content is never misattributed.
 */
const TASK_HEADING = /^###\s+Task\s+([0-9][0-9a-zA-Z.]*)\s*:\s*(.*)$/;

/**
 * `**Files:**`, `**Files to change:**`, … — the start of a file region.
 *
 * Capture group 1 is whatever follows on the *same line*. The corpus uses two
 * shapes and both are common: the shipped template's `**Files:**` followed by
 * a verb-prefixed bullet list, and a compact inline form used throughout the
 * bugfix plans — `**Files:** \`a.ts\`, new \`b.ts\`` — which states no verb.
 * Handling only the first shape silently returns zero files for whole plans.
 */
const FILES_MARKER = /^\s*\*\*Files?\b[^*]*\*\*\s*(.*)$/i;

/** Any other `**Bold:**` field label ends the file region. */
const FIELD_MARKER = /^\s*\*\*[A-Z]/;

/** `**Wave:** 2`, `**Wave:** 2 (moved from Wave 1)`, `**Wave:** [1 | 2 | ...]`. */
const WAVE_FIELD = /^\s*\*\*Wave:\*\*\s*(.*)$/i;

/**
 * Verb alternation kept **identical to `extractSpecFiles`** so the two agree
 * on which lines are file entries at all.
 */
const FILE_ENTRY =
  /^\s*[-*]\s+(Modify|Create|Delete|Rename|Add|Update|Test)\s*:\s*(.+)$/i;

const VERB_MAP: Record<string, PlanFileVerb> = {
  create: "create",
  test: "test",
  delete: "delete",
  modify: "modify",
  rename: "modify",
  add: "modify",
  update: "modify",
};

/** A fence opener/closer, ignoring indentation (list-nested fences are indented). */
const FENCE = /^\s*(?:```|~~~)/;

// --- Helpers ---

/**
 * Does this token look like a path at all?
 *
 * Files blocks occasionally carry prose (`- Create: sibling(s)`,
 * `- Test: existing tests in each module`). Requiring either a directory
 * separator or a file extension drops those without dropping bare filenames
 * (`README.md`) or directory targets (`src/cli/__fixtures__/`).
 */
function looksLikePath(value: string): boolean {
  return value.includes("/") || /\.[A-Za-z0-9]+$/.test(value);
}

/**
 * Split the right-hand side of a file entry into path tokens.
 *
 * Mirrors `extractSpecFiles`: backticks delimit paths unambiguously, so when
 * they are present take every one of them — real plans write
 * `- Modify: \`a.ts\`, \`b.ts\`` and taking only the first token drops
 * everything after the comma. Un-backticked lines keep the first-token
 * behaviour, which discards trailing prose and inline comments.
 */
function splitPathTokens(value: string): string[] {
  const ticked = value.match(/`[^`]+`/g);
  return ticked ?? [value.split(" ")[0]];
}

/**
 * The verb assigned to the inline `**Files:** …` form, which states none.
 *
 * `modify` is the neutral default and the corpus's dominant verb. It is not a
 * claim that the file exists — `exists` is the load-bearing signal for that,
 * and a consumer that must not score reach for not-yet-created files should
 * gate on `exists`, never on `verb` alone.
 */
const INLINE_VERB: PlanFileVerb = "modify";

/**
 * Parse a `**Wave:**` value.
 *
 * Returns the leading integer, so `2 (moved from Wave 1 — now gated by Task 1)`
 * — a real form in this repo's corpus — yields `2`. Returns `null` for the
 * shipped `[1 | 2 | ...]` placeholder, for `N/A`, and for anything else that
 * does not begin with a digit. Never `NaN`, never a throw.
 */
export function parseWaveValue(raw: string): number | null {
  const match = /^\s*(\d+)\b/.exec(raw.replace(/`/g, ""));
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Any `###`-or-shallower heading terminates the current task section.
 * `####` and deeper are treated as sub-structure *within* a task.
 */
function isSectionBreak(line: string): boolean {
  return /^#{1,3}\s/.test(line);
}

interface TaskAccumulator extends PlanTaskFiles {
  seen: Set<string>;
}

function startTask(id: string, title: string): TaskAccumulator {
  // A leading digit is guaranteed by TASK_HEADING, so parseInt always succeeds.
  return {
    task: Number.parseInt(id, 10),
    id,
    title: title.trim(),
    wave: null,
    files: [],
    seen: new Set(),
  };
}

function addFile(
  acc: TaskAccumulator,
  path: string,
  verb: PlanFileVerb,
  projectRoot: string,
): void {
  const key = `${verb}:${path}`;
  if (acc.seen.has(key)) return;
  acc.seen.add(key);
  acc.files.push({
    path,
    verb,
    exists: existsSync(isAbsolute(path) ? path : join(projectRoot, path)),
  });
}

/** Tokenize, normalize, filter and record every path on one file-entry value. */
function collect(
  acc: TaskAccumulator,
  value: string,
  verb: PlanFileVerb,
  projectRoot: string,
): void {
  if (value.length === 0) return;
  for (const token of splitPathTokens(value)) {
    const path = normalizeSpecFilePath(token);
    if (path.length > 0 && looksLikePath(path)) {
      addFile(acc, path, verb, projectRoot);
    }
  }
}

// --- Parser ---

/**
 * Parse a plan file into a per-task view of the files it claims.
 *
 * Line-oriented state machine with three pieces of state:
 *   1. **fence** — content inside ``` / ~~~ is documentation (plans embed
 *      example task templates verbatim) and is skipped wholesale.
 *   2. **current task** — opened by `### Task N:`, closed by any `#`/`##`/`###`
 *      heading. Verb lines outside a task are ignored entirely.
 *   3. **file region** — opened by `**Files:**`, closed by the next `**Bold`
 *      field label or heading. Scoping to this region is what keeps prose
 *      bullets in `**Key Decisions / Notes:**` out of the result.
 *
 * @param planFilePath Absolute path to the plan `.md`.
 * @param projectRoot  Root the `exists` check resolves relative paths against.
 * @returns Tasks in document order. `[]` if the file is missing or unreadable.
 */
export function parsePlanFiles(
  planFilePath: string,
  projectRoot: string,
): PlanTaskFiles[] {
  let content: string;
  try {
    if (!existsSync(planFilePath)) return [];
    content = readFileSync(planFilePath, "utf-8");
  } catch {
    return [];
  }

  const tasks: PlanTaskFiles[] = [];
  let current: TaskAccumulator | null = null;
  let inFiles = false;
  let inFence = false;

  const close = (): void => {
    if (!current) return;
    const { seen: _seen, ...rest } = current;
    tasks.push(rest);
    current = null;
    inFiles = false;
  };

  for (const line of content.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = TASK_HEADING.exec(line);
    if (heading) {
      close();
      current = startTask(heading[1], heading[2]);
      continue;
    }
    if (isSectionBreak(line)) {
      close();
      continue;
    }
    if (!current) continue;

    const wave = WAVE_FIELD.exec(line);
    if (wave) {
      current.wave = parseWaveValue(wave[1]);
      inFiles = false;
      continue;
    }
    const filesMarker = FILES_MARKER.exec(line);
    if (filesMarker) {
      inFiles = true;
      collect(current, filesMarker[1].trim(), INLINE_VERB, projectRoot);
      continue;
    }
    if (FIELD_MARKER.test(line)) {
      inFiles = false;
      continue;
    }
    if (!inFiles) continue;

    const entry = FILE_ENTRY.exec(line);
    if (!entry) continue;
    const verb = VERB_MAP[entry[1].toLowerCase()];
    if (verb) collect(current, entry[2].trim(), verb, projectRoot);
  }

  close();
  return tasks;
}
