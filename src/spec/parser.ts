/**
 * Spec Plan File Parser
 *
 * Parses markdown plan files into structured Spec objects.
 * Handles two metadata formats:
 *   - New format:  `Status: IN PROGRESS` (plain key-value lines after title)
 *   - Old format:  `**Status:** APPROVED` (bold markdown after title)
 * Extracts tasks from the Progress Tracking section (`- [x] Task N: Title`)
 * and falls back to Implementation Tasks (`### Task N: Title`) sections.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type {
  Spec,
  SpecStatus,
  SpecType,
  SpecTask,
  TaskStatus,
} from "./types.js";
import { SPEC_STATUSES } from "./types.js";

// --- Public API ---

/** Parse a plan file from disk into a Spec object. */
export function parsePlanFile(filePath: string): Spec {
  const content = readFileSync(filePath, "utf-8");
  return parsePlanContent(content, filePath);
}

/** Parse plan file content (for testing without disk access). */
export function parsePlanContent(content: string, filePath: string): Spec {
  const lines = content.split("\n");
  const id = slugFromFilename(filePath);
  const title = extractTitle(lines);
  const meta = extractMetadata(lines);
  const tasks = extractTasks(lines);

  const status = normalizeStatus(meta.status);
  const type = (
    meta.type?.toLowerCase() === "bugfix" ? "bugfix" : "feature"
  ) as SpecType;
  const approved =
    meta.approved?.toLowerCase() === "yes" || status === "APPROVED";

  return {
    id,
    title,
    status,
    type,
    approved,
    planFile: filePath,
    created: meta.created,
    tasks,
    metadata: {
      iterations: meta.iterations ? parseInt(meta.iterations, 10) : undefined,
      worktree: meta.worktree?.toLowerCase() === "yes" ? true : undefined,
    },
  };
}

/** Derive a slug from a plan filename (strips path and .md extension). */
export function slugFromFilename(filePath: string): string {
  return basename(filePath).replace(/\.md$/i, "");
}

// --- Metadata Extraction ---

interface RawMetadata {
  status?: string;
  type?: string;
  approved?: string;
  created?: string;
  iterations?: string;
  worktree?: string;
}

/** Extract metadata from either new-format or old-format plan files. */
function extractMetadata(lines: string[]): RawMetadata {
  const meta: RawMetadata = {};

  // Scan the first 20 lines for metadata (both formats)
  const scanLimit = Math.min(lines.length, 20);
  for (let i = 0; i < scanLimit; i++) {
    const line = lines[i].trim();

    // New format: `Key: Value`
    const plainMatch = line.match(
      /^(Status|Type|Approved|Created|Iterations|Worktree):\s*(.+)$/i,
    );
    if (plainMatch) {
      const key = plainMatch[1].toLowerCase() as keyof RawMetadata;
      meta[key] = plainMatch[2].trim();
      continue;
    }

    // Old format: `**Key:** Value`
    const boldMatch = line.match(
      /^\*\*(Status|Type|Approved|Date|Created|Iterations|Worktree):\*\*\s*(.+)$/i,
    );
    if (boldMatch) {
      let key = boldMatch[1].toLowerCase();
      if (key === "date") key = "created";
      meta[key as keyof RawMetadata] = boldMatch[2].trim();
      continue;
    }

    // Stop at first heading after title (## Summary, ## Overview, etc.)
    if (i > 1 && line.startsWith("## ")) break;
  }

  return meta;
}

// --- Title Extraction ---

/** Extract the title from the first `# heading` line. */
function extractTitle(lines: string[]): string {
  for (const line of lines.slice(0, 5)) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return "Untitled";
}

// --- Task Extraction ---

/**
 * Extract tasks from the Progress Tracking section first,
 * falling back to Implementation Tasks section headers.
 */
function extractTasks(lines: string[]): SpecTask[] {
  const progressTasks = extractProgressTasks(lines);
  if (progressTasks.length > 0) return progressTasks;
  return extractImplementationTasks(lines);
}

/**
 * Extract tasks from `## Progress Tracking` section.
 * Format: `- [x] Task N: Title` or `- [~] Task N: Title`
 */
function extractProgressTasks(lines: string[]): SpecTask[] {
  const tasks: SpecTask[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.trim().startsWith("## Progress Tracking")) {
      inSection = true;
      continue;
    }
    if (inSection && line.trim().startsWith("## ")) break;

    if (!inSection) continue;

    const match = line.match(/^-\s+\[([ x~])\]\s+Task\s+(\d+):\s*(.+)$/i);
    if (match) {
      const status = checkboxToStatus(match[1]);
      const position = parseInt(match[2], 10);
      // Strip trailing parenthetical notes like "(partial — ...)"
      const title = match[3].replace(/\s*\(partial\s*[—–-].*\)\s*$/, "").trim();
      tasks.push({ position, title, status });
    }
  }

  return tasks;
}

/**
 * Extract tasks from `### Task N: Title` headings or `### N. Title` headings.
 * First looks within a `## Implementation Tasks` section, then falls
 * back to scanning the entire document for bare `### Task N:` headings.
 * Status determined by counting [x] vs [ ] in Definition of Done,
 * or from an explicit `**Status:**` line within the task block.
 * Also extracts `**Test Strategy:**` and `**Definition of Done:**` text.
 */
function extractImplementationTasks(lines: string[]): SpecTask[] {
  // Try scoped extraction first
  const hasSection = lines.some((l) =>
    l.trim().startsWith("## Implementation Tasks"),
  );
  const tasks = scanTaskHeadings(lines, hasSection);
  return tasks;
}

interface RawTask {
  position: number;
  title: string;
  done: number;
  total: number;
  explicitStatus?: string;
  testStrategy?: string;
  definitionOfDone?: string;
}

function scanTaskHeadings(
  lines: string[],
  scopedToSection: boolean,
): SpecTask[] {
  const tasks: SpecTask[] = [];
  let inSection = !scopedToSection; // If no section wrapper, start scanning immediately
  let currentTask: RawTask | null = null;
  let inDefinitionOfDone = false;
  let inTestStrategy = false;

  for (const line of lines) {
    if (scopedToSection && line.trim().startsWith("## Implementation Tasks")) {
      inSection = true;
      continue;
    }
    // Stop at next top-level section (only when scoped)
    if (scopedToSection && inSection && /^## [^#]/.test(line.trim())) {
      if (currentTask) {
        tasks.push(taskFromRaw(currentTask));
        currentTask = null;
      }
      break;
    }

    if (!inSection) continue;

    // New task heading — supports both `### Task N: Title` and `### N. Title`
    const taskMatch =
      line.match(/^###\s+Task\s+(\d+):\s*(.+)$/i) ??
      line.match(/^###\s+(\d+)\.\s+(.+)$/);
    if (taskMatch) {
      if (currentTask) {
        tasks.push(taskFromRaw(currentTask));
      }
      currentTask = {
        position: parseInt(taskMatch[1], 10),
        title: taskMatch[2].trim(),
        done: 0,
        total: 0,
      };
      inDefinitionOfDone = false;
      inTestStrategy = false;
      continue;
    }

    if (!currentTask) continue;

    // Explicit status line: `- **Status:** in-progress`
    const statusMatch = line.match(/^-\s+\*\*Status:\*\*\s*(.+)$/i);
    if (statusMatch) {
      currentTask.explicitStatus = statusMatch[1].trim().toLowerCase();
      inDefinitionOfDone = false;
      inTestStrategy = false;
      continue;
    }

    // Test Strategy line: `- **Test Strategy:** description`
    const testStrategyMatch = line.match(
      /^-\s+\*\*Test Strategy:\*\*\s*(.+)$/i,
    );
    if (testStrategyMatch) {
      currentTask.testStrategy = testStrategyMatch[1].trim();
      inDefinitionOfDone = false;
      inTestStrategy = false;
      continue;
    }

    // Definition of Done line: `- **Definition of Done:** description`
    const dodMatch = line.match(/^-\s+\*\*Definition of Done:\*\*\s*(.+)$/i);
    if (dodMatch) {
      currentTask.definitionOfDone = dodMatch[1].trim();
      inDefinitionOfDone = false;
      inTestStrategy = false;
      continue;
    }

    // Block-style **Test Strategy:** or **Definition of Done:** heading
    if (line.trim().startsWith("**Test Strategy:**")) {
      inTestStrategy = true;
      inDefinitionOfDone = false;
      const inline = line
        .trim()
        .replace(/^\*\*Test Strategy:\*\*\s*/, "")
        .trim();
      if (inline) currentTask.testStrategy = inline;
      continue;
    }
    if (line.trim().startsWith("**Definition of Done:**")) {
      inDefinitionOfDone = true;
      inTestStrategy = false;
      const inline = line
        .trim()
        .replace(/^\*\*Definition of Done:\*\*\s*/, "")
        .trim();
      if (inline) currentTask.definitionOfDone = inline;
      continue;
    }

    // End block sections at next bold heading or subsection
    if (
      (inDefinitionOfDone || inTestStrategy) &&
      ((line.trim().startsWith("**") &&
        !line.trim().startsWith("**Definition") &&
        !line.trim().startsWith("**Test Strategy")) ||
        line.trim().startsWith("### "))
    ) {
      inDefinitionOfDone = false;
      inTestStrategy = false;
    }

    // Count checkboxes in Definition of Done
    if (inDefinitionOfDone) {
      const cbMatch = line.match(/^-\s+\[([ x~])\]/i);
      if (cbMatch) {
        currentTask.total++;
        if (cbMatch[1] === "x" || cbMatch[1] === "X") currentTask.done++;
      }
    }
  }

  // Flush last task
  if (currentTask) {
    tasks.push(taskFromRaw(currentTask));
  }

  return tasks;
}

// --- Helpers ---

function checkboxToStatus(marker: string): TaskStatus {
  if (marker === "x" || marker === "X") return "complete";
  if (marker === "~") return "in-progress";
  return "pending";
}

function taskFromRaw(task: RawTask): SpecTask {
  let status: TaskStatus;

  if (task.explicitStatus) {
    // Normalize explicit status values
    const s = task.explicitStatus;
    if (s === "complete" || s === "done" || s === "finished")
      status = "complete";
    else if (
      s === "in-progress" ||
      s === "in progress" ||
      s === "inprogress" ||
      s === "active"
    )
      status = "in-progress";
    else if (s === "failed") status = "failed";
    else status = "pending";
  } else if (task.total > 0) {
    if (task.done >= task.total) status = "complete";
    else if (task.done > 0) status = "in-progress";
    else status = "pending";
  } else {
    status = "pending";
  }

  return {
    position: task.position,
    title: task.title,
    status,
    ...(task.testStrategy && { testStrategy: task.testStrategy }),
    ...(task.definitionOfDone && { definitionOfDone: task.definitionOfDone }),
  };
}

function normalizeStatus(raw: string | undefined): SpecStatus {
  if (!raw) return "PENDING";

  const upper = raw.toUpperCase().replace(/\s+/g, "_");

  // Direct match
  if (SPEC_STATUSES.includes(upper as SpecStatus)) return upper as SpecStatus;

  // Common aliases
  if (upper === "IN_PROGRESS") return "IN_PROGRESS";
  if (upper === "DONE" || upper === "FINISHED") return "VERIFIED";

  return "PENDING";
}
