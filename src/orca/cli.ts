/**
 * The one module that talks to the `orca` CLI. Everything else sees a typed
 * `OrcaResult<T>` and never an exception.
 *
 * Output facts (Orca 1.4.215, see `__fixtures__/`): results are a JSON envelope
 * `{id, ok, result | error:{code, message, data?}, _meta}` on stdout, usually
 * pretty-printed; error envelopes exit 1. `check --wait` also emits NDJSON
 * keepalive lines (`{"_keepalive":true,...}`) — on stderr per `--help`, merged
 * into stdout when streams are joined — so the parser takes the LAST JSON
 * document that is not a keepalive, from stdout first, then stderr.
 *
 * Kept free of `bun:sqlite`/zod: it may become reachable from the plugin.
 */

export interface OrcaRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set by a runner that killed the process at its deadline. */
  timedOut?: boolean;
}

export interface OrcaRunnerOptions {
  timeoutMs?: number;
  /** Merged over `process.env` by the default runner. */
  env?: Record<string, string | undefined>;
}

/** Runs `orca <args>`. May throw (e.g. ENOENT); `runOrca` converts that. */
export type OrcaRunner = (
  args: string[],
  opts?: OrcaRunnerOptions,
) => Promise<OrcaRunOutput>;

export type OrcaAdapterErrorCode =
  "orca_unavailable" | "orca_timeout" | "orca_bad_output" | "orca_error";

export interface OrcaError {
  /** Orca's own code (e.g. `task_not_startable`) or an `OrcaAdapterErrorCode`. */
  code: OrcaAdapterErrorCode | (string & {});
  message: string;
  data?: Record<string, unknown>;
}

export type OrcaResult<T> =
  { ok: true; result: T } | { ok: false; error: OrcaError };

export interface RunOrcaOptions extends OrcaRunnerOptions {
  runner?: OrcaRunner;
  /** Extra slack past `timeoutMs` before the backstop gives up on a runner. */
  graceMs?: number;
}

export const DEFAULT_ORCA_TIMEOUT_MS = 30_000;
const DEFAULT_GRACE_MS = 2_000;
const TAIL_CHARS = 400;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isKeepalive(v: unknown): boolean {
  return isRecord(v) && (v._keepalive === true || v._heartbeat === true);
}

/** Index just past the JSON value that opens at `start`, or -1. */
function matchingClose(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The last top-level JSON object/array in `text` that is not a keepalive, or
 * `undefined`. Tolerates pretty JSON, NDJSON and surrounding non-JSON text.
 */
export function parseLastJsonDocument(text: string): unknown {
  let last: unknown = undefined;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }
    const end = matchingClose(text, i);
    if (end === -1) {
      i++;
      continue;
    }
    let doc: unknown;
    let parsed = false;
    try {
      doc = JSON.parse(text.slice(i, end));
      parsed = true;
    } catch {
      /* not JSON — rescan from the next character */
    }
    if (!parsed) {
      i++;
      continue;
    }
    if (!isKeepalive(doc)) last = doc;
    i = end;
  }
  return last;
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t;
}

function toEnvelope<T>(doc: unknown): OrcaResult<T> | undefined {
  if (!isRecord(doc) || typeof doc.ok !== "boolean") return undefined;
  if (doc.ok) return { ok: true, result: doc.result as T };
  const e = doc.error;
  if (!isRecord(e)) {
    return {
      ok: false,
      error: {
        code: "orca_error",
        message: typeof e === "string" ? e : "Orca reported an error",
      },
    };
  }
  const error: OrcaError = {
    code: typeof e.code === "string" && e.code ? e.code : "orca_error",
    message:
      typeof e.message === "string" ? e.message : "Orca reported an error",
  };
  if (isRecord(e.data)) error.data = e.data;
  return { ok: false, error };
}

/** Turn one captured `orca` invocation into a typed result. Never throws. */
export function parseOrcaOutput<T = unknown>(
  out: OrcaRunOutput,
): OrcaResult<T> {
  for (const stream of [out.stdout, out.stderr]) {
    const env = toEnvelope<T>(parseLastJsonDocument(stream ?? ""));
    if (env) return env;
  }
  const printed = tail(`${out.stdout ?? ""}\n${out.stderr ?? ""}`);
  if (out.timedOut) {
    return {
      ok: false,
      error: {
        code: "orca_timeout",
        message: `orca timed out. ${printed}`.trim(),
      },
    };
  }
  if (out.exitCode === 127) {
    return {
      ok: false,
      error: {
        code: "orca_unavailable",
        message: `orca not runnable: ${printed}`,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "orca_bad_output",
      message: `orca exited ${out.exitCode} without a JSON envelope: ${printed}`,
    },
  };
}

export interface OrcaRunnerConfig {
  /** Executable to spawn; defaults to `orca` resolved from PATH. */
  binary?: string;
}

/** How long a killed process's pipes may keep draining (a grandchild can hold them). */
const DRAIN_AFTER_KILL_MS = 250;

/** A runner that spawns the Orca CLI, killing it at `timeoutMs`. Throws if it cannot spawn. */
export function createOrcaRunner(config: OrcaRunnerConfig = {}): OrcaRunner {
  const binary = config.binary ?? "orca";
  return async (args, opts) => {
    const proc = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, ...(opts?.env ?? {}) },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts?.timeoutMs ?? DEFAULT_ORCA_TIMEOUT_MS);
    const streams = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    try {
      const exitCode = await proc.exited;
      if (!timedOut) {
        const [stdout, stderr] = await streams;
        return { exitCode, stdout, stderr };
      }
      const drained = await Promise.race([
        streams,
        new Promise<null>((r) =>
          setTimeout(() => r(null), DRAIN_AFTER_KILL_MS),
        ),
      ]);
      return {
        exitCode,
        stdout: drained?.[0] ?? "",
        stderr: drained?.[1] ?? "",
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Spawns `orca` from PATH. */
export const defaultOrcaRunner: OrcaRunner = createOrcaRunner();

/**
 * Run `orca <args> --json` (appended when absent) and parse its envelope.
 * Never throws: spawn failure → `orca_unavailable`, deadline → `orca_timeout`,
 * no envelope → `orca_bad_output`; Orca's own errors keep their code.
 */
export async function runOrca<T = unknown>(
  args: string[],
  opts: RunOrcaOptions = {},
): Promise<OrcaResult<T>> {
  const runner = opts.runner ?? defaultOrcaRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ORCA_TIMEOUT_MS;
  const fullArgs = args.includes("--json") ? [...args] : [...args, "--json"];
  let backstop: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    backstop = setTimeout(
      () => resolve("expired"),
      timeoutMs + (opts.graceMs ?? DEFAULT_GRACE_MS),
    );
  });
  try {
    const out = await Promise.race([
      runner(fullArgs, { timeoutMs, env: opts.env }),
      expired,
    ]);
    if (out === "expired") {
      return {
        ok: false,
        error: {
          code: "orca_timeout",
          message: `orca ${args.join(" ")} did not finish within ${timeoutMs} ms`,
        },
      };
    }
    return parseOrcaOutput<T>(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: "orca_unavailable",
        message: `could not run orca: ${message}`,
      },
    };
  } finally {
    clearTimeout(backstop);
  }
}
