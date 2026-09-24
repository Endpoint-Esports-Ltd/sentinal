/**
 * Tool-Failure Classifier
 *
 * Decides whether a failed tool call (Claude Code `PostToolUseFailure`, or an
 * OpenCode bash call with a non-zero `metadata.exit`) is worth remembering as
 * an `error` observation, and if so builds its title, content, tags and a
 * de-duplication signature (D2/D3 of docs/plans/2026-09-24-orca-support-followups.md).
 *
 * ⛔ BUNDLE-SAFE: this module is bundled into the OpenCode plugin. It may import
 * only `node:*` builtins and modules that are themselves bundle-safe. The only
 * local import is `TEST_FAIL_INDICATORS` from `capture.ts`, whose sole import is
 * `import type` (erased at build). Never import anything that can reach
 * `bun:sqlite`, `sqlite-vec` or `@xenova/transformers`.
 *
 * ⛔ Tags are fixed strings. Redaction (`sanitize.ts`) covers only `title` and
 * `content`, so raw command or error text must never be put into `tags`.
 */

import { createHash } from "node:crypto";
import { TEST_FAIL_INDICATORS } from "./capture.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolFailureInput {
  /** Tool name as the host reports it (`Bash`, `bash`, `Edit`, an MCP name…). */
  toolName: string;
  /** Shell command, for Bash-like tools. */
  command?: string;
  /** Target file, for file tools (Edit/Write/Read…). */
  filePath?: string;
  /** Error text. Claude Code: first line `Exit code N`, then stdout/stderr. */
  error: string;
  /** Explicit exit code (OpenCode `metadata.exit`). Wins over a parsed one. */
  exitCode?: number;
  /** The user interrupted the call. */
  interrupted?: boolean;
}

export type ToolFailureSkipReason =
  | "interrupted"
  | "sentinal-guard"
  | "no-match-exit"
  | "empty-output"
  | "assertion-only-test-failure";

export interface ToolFailureClassification {
  capture: boolean;
  skipReason?: ToolFailureSkipReason;
  /** sha1 hex over tool | subject | normalized first meaningful error line. */
  signature: string;
  title: string;
  content: string;
  tags: string[];
  exitCode?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum characters of error text kept in `content` (head is kept). */
export const MAX_ERROR_CONTENT_CHARS = 1500;
const MAX_TITLE_CHARS = 120;
const MAX_COMMAND_CHARS = 500;

const EXIT_LINE_RE = /^Exit code (-?\d+)\s*$/;
const TIMEOUT_LINE_RE = /^Command timed out after\b/i;
const TRUNCATION_MARKER_RE = /\.\.\. \[\d+ characters truncated\] \.\.\./g;

/** Infrastructure failures are captured even inside a test run (D2). */
const INFRA_INDICATORS: RegExp[] = [
  /Cannot find module/i,
  /Cannot find package/i,
  /\bSyntaxError\b/,
  /\berror\s*TS\d+/i,
  /\bdlopen\b/,
  /Library not loaded/,
  /ERR_DLOPEN_FAILED/,
  /NODE_MODULE_VERSION/,
  /ModuleNotFoundError/,
  /\bImportError\b/,
  /no such module/i,
];

/** Lines that look like the actual error, preferred for title and signature. */
const STRONG_ERROR_RE =
  /\b[A-Z]\w*(?:Error|Exception)\b|\berror\b|\bfatal\b|\bpanic\b|\bERR!|Cannot find|command not found|No such file or directory|Permission denied|not found|timed out|Could not resolve/i;

/** Commands whose exit 1 just means "no match / false". */
const NO_MATCH_COMMANDS = new Set(
  "grep egrep fgrep rg diff cmp test [ [[ which pgrep".split(" "),
);

/** Segments that never identify what failed (setup, echo, output filters). */
const SUBJECT_SKIP_COMMANDS = new Set(
  "cd pushd popd export set source . echo printf head tail tee cat less sort uniq wc true sleep".split(
    " ",
  ),
);

const RUNNER_BINS = new Set(["jest", "vitest", "pytest", "mocha"]);
const WRAPPER_COMMANDS = new Set(["sudo", "time", "env", "nice", "exec"]);

// ─── Exit code ────────────────────────────────────────────────────────────────

/**
 * Parse a leading `Exit code N` line. Tolerates a preceding
 * `Command timed out after …` line that Claude Code may insert.
 */
export function parseExitCode(error: string): number | undefined {
  const lines = error.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = 0; i < Math.min(lines.length, 2); i++) {
    const line = lines[i].trim();
    const m = EXIT_LINE_RE.exec(line);
    if (m) return Number(m[1]);
    if (!TIMEOUT_LINE_RE.test(line)) return undefined;
  }
  return undefined;
}

/** The error text without its `Exit code N` line. */
function stripExitLine(error: string): string {
  return error
    .split(/\r?\n/)
    .filter((l) => !EXIT_LINE_RE.test(l.trim()))
    .join("\n");
}

// ─── Lines & normalization ────────────────────────────────────────────────────

function cleanLine(line: string): string {
  return line.replace(TRUNCATION_MARKER_RE, " ").trim();
}

function isNoiseLine(line: string): boolean {
  if (line === "") return true;
  if (EXIT_LINE_RE.test(line)) return true;
  if (!/[A-Za-z0-9]/.test(line)) return true;
  if (/^Traceback \(most recent call last\):$/.test(line)) return true;
  if (/^bun (?:test )?v\d/.test(line)) return true;
  return false;
}

/**
 * First line that looks like the actual error; otherwise the first non-noise
 * line; otherwise "".
 */
export function firstMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((l) => !isNoiseLine(l));
  return lines.find((l) => STRONG_ERROR_RE.test(l)) ?? lines[0] ?? "";
}

/**
 * Normalize an error line for signatures: URLs, timestamps, paths, hex,
 * durations and standalone numbers (incl. line:col) are replaced with
 * placeholders; whitespace collapsed; lower-cased. Quoted identifiers
 * (`'x'`), scoped packages (`@a/b`) and codes like `TS2307` are preserved,
 * so different root errors stay distinct.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "<ts>",
    )
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>")
    .replace(/(?<![\w@])(?:~|\.{1,2})?\/[^\s'"`()[\]{}<>:,;]+/g, "<path>")
    .replace(/(?<![\w@/.\-<])[\w.-]+(?:\/[\w.@+-]+)+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?(ms|µs|ns|s|m|h)\b/g, "N$1")
    .replace(/\b\d+(?:\.\d+)*\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ─── Command parsing ──────────────────────────────────────────────────────────

/** Quote-aware split on `&&`, `||`, `|`, `;` and newlines. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s !== "");
}

/** Whitespace tokens (quotes stripped), minus env assignments and wrappers. */
function tokenize(segment: string): string[] {
  const tokens = (segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) =>
    t.replace(/^(['"])(.*)\1$/, "$2"),
  );
  while (
    tokens.length > 0 &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) ||
      WRAPPER_COMMANDS.has(tokens[0]))
  ) {
    tokens.shift();
  }
  return tokens;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== "");
  return parts[parts.length - 1] ?? p;
}

const commandName = (tokens: string[]): string =>
  tokens[0] ? basename(tokens[0]) : "";

function isNoMatchCommand(tokens: string[]): boolean {
  const name = commandName(tokens);
  if (NO_MATCH_COMMANDS.has(name)) return true;
  if (name === "command" && tokens.includes("-v")) return true;
  if (name === "git" && tokens.includes("diff")) {
    return tokens.includes("--exit-code") || tokens.includes("--quiet");
  }
  return false;
}

function isTestRunner(tokens: string[]): boolean {
  const name = commandName(tokens);
  if (RUNNER_BINS.has(name)) return true;
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const [a0, a1] = args;
  if (["npx", "bunx", "pnpx", "yarn", "pnpm"].includes(name)) {
    if (a0 && RUNNER_BINS.has(basename(a0))) return true;
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    if (a0 === "test" || a0 === "t") return true;
    if (
      (a0 === "run" || a0 === "exec") &&
      a1 &&
      (/^test\b/.test(a1) || RUNNER_BINS.has(a1))
    ) {
      return true;
    }
  }
  if (name === "go" && a0 === "test") return true;
  if (/^python[\d.]*$/.test(name)) {
    const m = tokens.indexOf("-m");
    if (m >= 0 && tokens[m + 1] === "pytest") return true;
  }
  return false;
}

// ─── Classification ───────────────────────────────────────────────────────────

interface CommandInfo {
  last: string[];
  subject: string[];
  isTestRun: boolean;
}

function analyzeCommand(command: string): CommandInfo {
  const segs = splitSegments(command)
    .map(tokenize)
    .filter((t) => t.length > 0);
  const last = segs[segs.length - 1] ?? [];
  const subject =
    [...segs]
      .reverse()
      .find((t) => !SUBJECT_SKIP_COMMANDS.has(commandName(t))) ?? last;
  return { last, subject, isTestRun: segs.some(isTestRunner) };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function skipReasonFor(
  input: ToolFailureInput,
  body: string,
  exitCode: number | undefined,
  info: CommandInfo | null,
): ToolFailureSkipReason | undefined {
  if (input.interrupted) return "interrupted";
  if (
    input.error.trimStart().startsWith("[Sentinal") ||
    body.trimStart().startsWith("[Sentinal")
  ) {
    return "sentinal-guard";
  }
  if (exitCode === 1 && info && isNoMatchCommand(info.last))
    return "no-match-exit";
  if (exitCode === 1 && body.replace(TRUNCATION_MARKER_RE, "").trim() === "") {
    return "empty-output";
  }
  if (
    info?.isTestRun &&
    TEST_FAIL_INDICATORS.some((re) => re.test(body)) &&
    !INFRA_INDICATORS.some((re) => re.test(body))
  ) {
    return "assertion-only-test-failure";
  }
  return undefined;
}

export function classifyToolFailure(
  input: ToolFailureInput,
): ToolFailureClassification {
  const error = input.error ?? "";
  const exitCode = input.exitCode ?? parseExitCode(error);
  const body = stripExitLine(error);
  const command = input.command?.trim() || undefined;
  const info = command ? analyzeCommand(command) : null;

  const firstLine = firstMeaningfulLine(body);

  // Subject: what failed — first two command tokens, or the file basename.
  let titleSubject = input.toolName;
  let signatureSubject = "";
  if (info && info.subject.length > 0) {
    const two = info.subject.slice(0, 2);
    titleSubject = two.map((t) => truncate(t, 40)).join(" ");
    signatureSubject = normalizeErrorLine(
      [basename(two[0]), ...two.slice(1)].join(" "),
    );
  } else if (input.filePath) {
    titleSubject = `${input.toolName} ${basename(input.filePath)}`;
    signatureSubject = basename(input.filePath).toLowerCase();
  }

  const errorKey = firstLine
    ? normalizeErrorLine(firstLine)
    : `exit ${exitCode ?? "?"}`;
  const signature = createHash("sha1")
    .update(`${input.toolName.toLowerCase()}|${signatureSubject}|${errorKey}`)
    .digest("hex");

  const titleDetail = firstLine.replace(/^error(?:\[\w+\])?:\s*/i, "");
  const title = truncate(
    titleDetail
      ? `${titleSubject} failed: ${titleDetail}`
      : `${titleSubject} failed${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`,
    MAX_TITLE_CHARS,
  );

  const trimmedBody = body.trim();
  const errorPart =
    trimmedBody.length > MAX_ERROR_CONTENT_CHARS
      ? `${trimmedBody.slice(0, MAX_ERROR_CONTENT_CHARS)}\n… [error truncated by Sentinal]`
      : trimmedBody;
  const contentLines = [`Tool: ${input.toolName}`];
  if (command)
    contentLines.push(`Command: ${truncate(command, MAX_COMMAND_CHARS)}`);
  if (input.filePath) contentLines.push(`File: ${input.filePath}`);
  if (exitCode !== undefined) contentLines.push(`Exit code: ${exitCode}`);
  if (firstLine) contentLines.push(`Summary: ${truncate(firstLine, 300)}`);
  contentLines.push("Error:", errorPart);

  const skipReason = skipReasonFor(input, body, exitCode, info);
  return {
    capture: skipReason === undefined,
    ...(skipReason ? { skipReason } : {}),
    signature,
    title,
    content: contentLines.join("\n"),
    tags: ["tool-failure", input.toolName, "auto-captured"],
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}
