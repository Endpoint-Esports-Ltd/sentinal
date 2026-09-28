/**
 * Which TDD rows a test run covers (D1/D2 of
 * docs/plans/2026-09-28-deferred-items.md).
 *
 * The bulk TDD transitions (`confirm_red` / `confirm_green`) used to apply to
 * EVERY row of a project, so a parallel agent's passing `bun test b.test.ts`
 * deleted another agent's RED row. `testRunScope` derives the test files a
 * run covered from the COMMAND only — output headers are unreliable (absent,
 * truncated, and a full run prints every file) — and `rowMatchesTestScope`
 * decides whether a row belongs to that run.
 *
 * ⛔ Pure and free of `bun:sqlite`: the OpenCode plugin bundle imports it.
 *
 * `files === null` means "unknown / full suite" → project-wide (today's
 * behaviour; a passing full suite means every RED test passed). The scope is
 * never empty: when nothing resolves, `files` is `null`.
 */

import { basename, isAbsolute, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { getExpectedTestPaths, getImplPathForTest, isTestFile } from "./tdd.js";

export interface TestRunScope {
  /** Absolute test files named by the command; `null` = project-wide. */
  files: string[] | null;
  /** Absolute existing directories named by the command. */
  dirs: string[];
  /** `-t` / `--test-name-pattern` / `--grep`: only SOME tests of the files ran. */
  nameFiltered: boolean;
}

const PROJECT_WIDE: TestRunScope = {
  files: null,
  dirs: [],
  nameFiltered: false,
};

/** Flags that filter by test name — a passing run proves only some tests. */
const NAME_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--testNamePattern",
  "--grep",
]);

/** Flags whose value is the NEXT token (so it is not read as a positional). */
const VALUE_FLAGS = new Set([
  "--timeout",
  "--rerun-each",
  "--preload",
  "-r",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "-c",
  "--config",
  "--project",
  "--testTimeout",
  "--root",
  "--dir",
  "--seed",
  "--max-concurrency",
  "--shard",
  "--environment",
  "--pool",
  "--outputFile",
]);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^\d*(>>?|<)(&\d+)?$/;
const REDIRECT_ATTACHED = /^\d*(>>?|<)/;
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn"];
const PACKAGE_RUNNERS = ["npx", "bunx", "pnpx"];

interface Word {
  v: string;
  quoted: boolean;
}
type Token = Word | { op: string };

/** Minimal shell tokenizer: quotes, backslashes, `&& || | ; & ( )`. */
function tokenize(cmd: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let quoted = false;
  let inWord = false;
  const flush = (): void => {
    if (inWord) out.push({ v: cur, quoted });
    cur = "";
    quoted = false;
    inWord = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1);
      const stop = end === -1 ? cmd.length : end;
      cur += cmd.slice(i + 1, stop);
      quoted = inWord = true;
      i = stop;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      flush();
    } else if ("&|;()".includes(c)) {
      // `2>&1` keeps its `&` inside the word
      if (c === "&" && cur.endsWith(">")) {
        cur += c;
        continue;
      }
      flush();
      const two = cmd.slice(i, i + 2);
      const op = two === "&&" || two === "||" ? two : c;
      i += op.length - 1;
      out.push({ op });
    } else {
      cur += c;
      inWord = true;
    }
  }
  flush();
  return out;
}

/**
 * Split into simple commands (on `&& || | ; & ( )`), dropping redirections.
 * Pipe consumers need no special case: `tail -20` is never a runner, and
 * `echo | bun test x` is still a test run.
 */
function segments(tokens: Token[]): string[][] {
  const segs: string[][] = [];
  let words: string[] = [];
  let skipNext = false;
  for (const t of tokens) {
    if ("op" in t) {
      if (words.length > 0) segs.push(words);
      words = [];
      skipNext = false;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!t.quoted && REDIRECT.test(t.v)) {
      // `>` alone takes the next word as its target; `2>&1` is complete
      skipNext = !t.v.includes("&");
      continue;
    }
    if (!t.quoted && REDIRECT_ATTACHED.test(t.v)) continue;
    words.push(t.v);
  }
  if (words.length > 0) segs.push(words);
  return segs;
}

const isRunner = (w: string | undefined): boolean =>
  w !== undefined && ["vitest", "jest"].includes(basename(w));

/** Strip `vitest run` and npm's `--` separators. */
function cleanRest(rest: string[], viaRunner: boolean): string[] {
  const r = viaRunner && rest[0] === "run" ? rest.slice(1) : rest;
  return r.filter((x) => x !== "--");
}

/** The runner's own arguments, or `null` if the command is not a test run. */
function runnerArgs(input: string[]): string[] | null {
  let w = [...input];
  while (w[0] === "env" || w[0] === "time" || ENV_ASSIGN.test(w[0] ?? "")) {
    w = w.slice(1);
  }
  const [a = "", b, c] = w;
  if (a === "bun" && b === "test") return cleanRest(w.slice(2), false);
  if (a === "bun" && b === "run" && c === "test")
    return cleanRest(w.slice(3), false);
  if (PACKAGE_MANAGERS.includes(a) && b === "test")
    return cleanRest(w.slice(2), false);
  if (PACKAGE_MANAGERS.includes(a) && b === "run" && c === "test")
    return cleanRest(w.slice(3), false);
  if (PACKAGE_RUNNERS.includes(a)) {
    const i = w.findIndex((x, k) => k > 0 && !x.startsWith("-"));
    return i > 0 && isRunner(w[i]) ? cleanRest(w.slice(i + 1), true) : null;
  }
  if ((a === "pnpm" || a === "yarn") && (b === "exec" || b === "dlx"))
    return isRunner(c) ? cleanRest(w.slice(3), true) : null;
  if (a === "yarn" && isRunner(b)) return cleanRest(w.slice(2), true);
  if (isRunner(a)) return cleanRest(w.slice(1), true);
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function scopeFromArgs(args: string[], cwd: string): TestRunScope {
  const files: string[] = [];
  const dirs: string[] = [];
  let nameFiltered = false;
  let unknown = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      const name = a.split("=")[0];
      if (NAME_FLAGS.has(name)) nameFiltered = true;
      if (!a.includes("=") && (VALUE_FLAGS.has(name) || NAME_FLAGS.has(name)))
        i++;
      continue;
    }
    // Only an EXISTING path narrows the run. Runners treat a bare argument as
    // a substring filter (`bun test tdd-routes.test.ts` runs
    // src/sidecar/tdd-routes.test.ts), so a non-existent path would scope the
    // run to nothing and match no row — worse than project-wide.
    const abs = resolve(cwd, a);
    if (isTestFile(abs) && existsSync(abs)) files.push(abs);
    else if (isDirectory(abs)) dirs.push(abs);
    else unknown = true;
  }
  if (unknown || files.length + dirs.length === 0) {
    return { ...PROJECT_WIDE, nameFiltered };
  }
  return { files, dirs, nameFiltered };
}

/**
 * Derive the scope of a test run from its command (D2). Wrappers
 * (`bunx`/`npx`/`pnpm exec`/`yarn`, `npm|pnpm|yarn [run] test [--]`,
 * `bun [run] test`, `vitest [run]`, `jest`), env prefixes and redirections
 * are stripped; `cd x &&` moves the cwd. Anything not
 * recognised is project-wide.
 */
export function testRunScope(input: {
  command: string | undefined | null;
  cwd: string;
}): TestRunScope {
  if (typeof input.command !== "string" || input.command.trim() === "")
    return { ...PROJECT_WIDE };
  let cwd = input.cwd;
  const runs: TestRunScope[] = [];
  for (const words of segments(tokenize(input.command))) {
    if (words[0] === "cd") {
      const target = words[1];
      // `cd -`, `cd ~/x`, `cd $DIR`: the shell resolves these, we cannot.
      if (!target || /^[-~$]/.test(target) || target.includes("$"))
        return { ...PROJECT_WIDE };
      cwd = resolve(cwd, target);
      continue;
    }
    const args = runnerArgs(words);
    if (args) runs.push(scopeFromArgs(args, cwd));
  }
  if (runs.length === 0) return { ...PROJECT_WIDE };
  const nameFiltered = runs.some((r) => r.nameFiltered);
  if (runs.some((r) => r.files === null))
    return { ...PROJECT_WIDE, nameFiltered };
  return {
    files: runs.flatMap((r) => r.files ?? []),
    dirs: runs.flatMap((r) => r.dirs),
    nameFiltered,
  };
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** The scope as carried over the wire (`[]` / absent = project-wide). */
export interface TestScopeInput {
  testFiles?: readonly string[] | null;
  testDirs?: readonly string[] | null;
}

export interface ScopableRow {
  filePath: string;
  testFilePath?: string | null;
}

/** True when the scope narrows anything; empty/absent means project-wide. */
export function isScoped(scope: TestScopeInput): boolean {
  return (scope.testFiles?.length ?? 0) + (scope.testDirs?.length ?? 0) > 0;
}

/** Wire form of a parsed scope: `{}` when project-wide. */
export function toTestScopeInput(scope: TestRunScope): TestScopeInput {
  if (scope.files === null) return {};
  return { testFiles: scope.files, testDirs: scope.dirs };
}

function isInside(p: string, dir: string): boolean {
  const d = dir.endsWith(sep) ? dir : dir + sep;
  return p === dir || p.startsWith(d);
}

/**
 * Impl files a test may cover: the direct companion, plus the `__tests__/`,
 * `tests/` and `test/` layouts (`src/__tests__/x.test.ts` → `src/x.ts`;
 * `tests/x.test.ts` → `x.ts` or `src/x.ts`), which the forward mapping misses.
 */
function implCandidates(testPath: string): string[] {
  const direct = getImplPathForTest(testPath);
  if (!direct) return [];
  if (!isAbsolute(direct)) return [direct];
  const out = [direct];
  for (const seg of ["__tests__", "tests", "test"]) {
    const marker = `${sep}${seg}${sep}`;
    const i = direct.lastIndexOf(marker);
    if (i < 0) continue;
    const before = direct.slice(0, i);
    const after = direct.slice(i + marker.length);
    out.push(`${before}${sep}${after}`, `${before}${sep}src${sep}${after}`);
  }
  return out;
}

/**
 * Does a TDD row belong to the run? (D1) Its `test_file_path`, or an expected
 * companion test, is one of `testFiles` or under a `testDirs` entry; or the
 * reverse mapping of a run test file is the row's impl path; or the impl
 * itself lies under a run directory. An unscoped run matches every row.
 */
export function rowMatchesTestScope(
  row: ScopableRow,
  scope: TestScopeInput,
): boolean {
  if (!isScoped(scope)) return true;
  const files = new Set(scope.testFiles ?? []);
  const dirs = scope.testDirs ?? [];
  const tests = getExpectedTestPaths(row.filePath);
  if (row.testFilePath) tests.push(row.testFilePath);
  for (const t of tests) {
    if (files.has(t) || dirs.some((d) => isInside(t, d))) return true;
  }
  if (dirs.some((d) => isInside(row.filePath, d))) return true;
  for (const t of files) {
    if (implCandidates(t).includes(row.filePath)) return true;
  }
  return false;
}

/** The rows a run covers (all of them when unscoped). */
export function filterRowsByTestScope<T extends ScopableRow>(
  rows: T[],
  scope: TestScopeInput,
): T[] {
  if (!isScoped(scope)) return rows;
  return rows.filter((r) => rowMatchesTestScope(r, scope));
}
