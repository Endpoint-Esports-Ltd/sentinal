/**
 * The `.sentinal/runtime.json` contract — schema, closed interpolation
 * namespace, and the `isolation` three-state map (Phase 3, D6 / D10 / D12).
 *
 * ## What this file is for
 *
 * `## Runtime Environment` in the plan template is one slash-separated prose
 * line that no code has ever parsed. This module turns it into something
 * executable: **if `.sentinal/runtime.json` exists, `spec-verify` runs
 * `up` → readiness → tests → `down`; if it is absent, nothing changes.**
 * That "if absent, nothing changes" is the whole master plan's backward
 * compatibility guarantee, so every default here is chosen to be inert.
 *
 * The file is **project-authored and committed by the project**. Sentinal can
 * DRAFT one (see `scaffold.ts`) but never owns it.
 *
 * ## Two things this file deliberately does NOT do
 *
 * 1. **It does not substitute anything.** The schema only *validates* token
 *    names. Substitution needs the worktree's slot, which comes from
 *    `readSlotFromWorktree` at load time and is simply not available at parse
 *    time. {@link interpolateStrict} is the separate, exported second half.
 * 2. **It does not expand shell syntax.** See the prefix rule below.
 *
 * The interpolation rule itself — Sentinal owns the `SENTINAL_` prefix and
 * **nothing else** — lives in `interpolate.ts` and is re-exported here.
 *
 * ## Field set provenance
 *
 * Lifted from **Playwright `webServer`** and **Testcontainers wait
 * strategies** rather than invented: `startupTimeoutMs: 60000` is both
 * projects' default; `pollIntervalMs: 250` is a gentler take on
 * Testcontainers' 100ms, chosen because an HTTP probe against a booting app is
 * more expensive than a socket poll. `graceMs: 10000` before SIGKILL.
 *
 * v1 ships `http` + `exec` probes only. `tcp` and `log` were cut because
 * `exec` subsumes both (`nc -z host port`, `grep -q … <logfile>`), and `log`
 * in particular would couple the readiness poller to the log-capture
 * destination. The enum stays extensible.
 */

import { z } from "zod";
import { unknownSentinalTokens, unknownTokenMessage } from "./interpolate.js";

// The closed namespace is re-exported so `schema.ts` stays the single import
// surface for the contract (the plan's artifact table names it as such).
export {
  SLOT_TOKEN,
  SENTINAL_TOKENS,
  INTERPOLATED_FIELDS,
  unknownSentinalTokens,
  unknownTokenMessage,
  interpolateStrict,
} from "./interpolate.js";
export type { SentinalToken } from "./interpolate.js";

// ─── Conventions ────────────────────────────────────────────────────────────

/** Where the contract lives, relative to a repo/worktree root. */
export const RUNTIME_CONFIG_RELATIVE_PATH = ".sentinal/runtime.json";

/**
 * Where `up`'s stdout+stderr is captured, relative to the worktree root.
 *
 * **Log capture is a safety feature, not a convenience.** An agent facing a
 * failed `up` with no logs is blind, and a blind agent improvises — which is
 * the exact behaviour that produced issue #2.
 *
 * ⛔ Hide this via {@link "../worktree/git-exclude.js".excludeFromGit}, **not**
 * via `.git/info/exclude`. The latter is disproven in both forms (master
 * D1/R8): it resolves to the common dir and leaks into the main checkout,
 * while the per-worktree copy is never read. Phase 4 owns the wiring.
 */
export const RUNTIME_LOG_RELATIVE_PATH = ".sentinal/runtime.log";

/**
 * Where the ownership record for a started runtime lives, relative to the
 * worktree root — beside Phase 2's `.sentinal/worktree.env` and the log above.
 *
 * **This file is D5's entire substitute for a process supervisor.** It records
 * the pid and pgid Sentinal started, so `runtime_stop` can terminate exactly
 * that group and nothing else. It is worktree-local on purpose: it dies with
 * the worktree, so there is no reconciliation sweep and no cross-project state
 * to go stale.
 *
 * ⛔ Written on SPAWN with `state="starting"`, **not** on readiness. Writing it
 * only on success leaves the whole startup window (up to 60s) with a detached
 * process group and no ownership record — precisely the orphan D5 exists to
 * prevent — and the next `runtime_up` would then hit "port occupied, no
 * pidfile → fail" and permanently wedge the worktree.
 *
 * ⛔ Hide via {@link "../worktree/git-exclude.js".excludeFromGit}, **not**
 * `.git/info/exclude` — same reasoning as the log path above.
 */
export const RUNTIME_PIDFILE_RELATIVE_PATH = ".sentinal/runtime.pid";

/**
 * How many trailing log lines a failure message must carry.
 *
 * Fixed, not configurable: the point is that the agent *always* gets context
 * without having to know to ask for it, and a tunable would just be another
 * thing left at a useless default.
 */
export const RUNTIME_LOG_TAIL_LINES = 50;

// ─── Isolation (D10) ────────────────────────────────────────────────────────

/**
 * ⛔ `unknown` is deliberately NOT a member. Unknown is the **absence of a
 * key** — see {@link isolationOf}. Making it a writable value would invite
 * exactly the "declare it unknown to be safe" ritual that turns a high-signal
 * declaration into noise.
 */
export const ISOLATION_STATES = ["isolated", "shared", "none"] as const;
export type IsolationState = (typeof ISOLATION_STATES)[number];

/** What {@link isolationOf} reports, including the absence case. */
export type IsolationVerdict = IsolationState | "unknown";

/**
 * The closed resource vocabulary, so an agent reasons over an enum instead of
 * guessing whether the author wrote `db` or `database`.
 *
 * `browser` (D11) is the odd one out and needs its own sentence: the E2E
 * browser is shared runtime state, but it is isolated by a per-session flag in
 * the shipped rules (`verification.md`, `testing.md`), **not** by `up`.
 * Declare it `isolated` when the run uses per-session isolation
 * (`-s=$SENTINAL_SESSION_ID`, or a dedicated Chrome); `shared` when a single
 * long-lived browser is reused across worktrees.
 */
export const RESOURCE_CLASSES = [
  "ports",
  "database",
  "cache",
  "queue",
  "filesystem",
  "objectStorage",
  "searchIndex",
  "outboundEmail",
  "browser",
] as const;
export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

const IsolationStateSchema = z.enum(ISOLATION_STATES);

/** Escape hatch for classes the enum does not cover. Free-form `name`. */
const OtherResourceSchema = z
  .object({
    name: z.string().min(1, "an `other` isolation entry needs a name"),
    state: IsolationStateSchema,
  })
  .strict();

/**
 * ⛔ `.strict()` is load-bearing. A misspelled class (`db`) would otherwise be
 * dropped silently: the author believes they declared the database, Sentinal
 * sees nothing, and the resulting `unknown` never prompts. A declaration that
 * can be typo'd into invisibility is not a declaration.
 */
const IsolationSchema = z
  .object({
    ports: IsolationStateSchema.optional(),
    database: IsolationStateSchema.optional(),
    cache: IsolationStateSchema.optional(),
    queue: IsolationStateSchema.optional(),
    filesystem: IsolationStateSchema.optional(),
    objectStorage: IsolationStateSchema.optional(),
    searchIndex: IsolationStateSchema.optional(),
    outboundEmail: IsolationStateSchema.optional(),
    browser: IsolationStateSchema.optional(),
    other: z.array(OtherResourceSchema).optional(),
  })
  .strict();

// ─── Readiness / shutdown ───────────────────────────────────────────────────

const ReadinessObjectSchema = z
  .object({
    type: z.enum(["http", "exec"]),
    target: z
      .string()
      .min(1)
      .describe("URL for `http`, shell command for `exec`"),
    expectStatus: z.array(z.number().int()).optional(),
    startupTimeoutMs: z.number().int().positive().default(60000),
    pollIntervalMs: z.number().int().positive().default(250),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type !== "http" && v.expectStatus !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectStatus"],
        message:
          '`expectStatus` is only valid when `readiness.type` is "http". ' +
          "An `exec` probe passes on exit code 0.",
      });
    }
  });

/** Bare-string shorthand: `"readiness": "http://…"` → an http probe. */
const ReadinessSchema = z.preprocess(
  (v) => (typeof v === "string" ? { type: "http", target: v } : v),
  ReadinessObjectSchema,
);

const ShutdownSchema = z
  .object({
    signal: z.enum(["SIGTERM", "SIGINT"]).default("SIGTERM"),
    graceMs: z
      .number()
      .int()
      .positive()
      .default(10000)
      .describe("grace period before SIGKILL to the process group"),
  })
  .strict();

// ─── The contract ───────────────────────────────────────────────────────────

function checkTokens(
  value: string | undefined,
  field: string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (!value) return;
  const unknown = unknownSentinalTokens(value);
  if (unknown.length > 0) {
    ctx.addIssue({
      code: "custom",
      path,
      message: unknownTokenMessage(unknown, field),
    });
  }
}

export const RuntimeConfigSchema = z
  .object({
    isolation: IsolationSchema.optional(),
    up: z.string().min(1).optional(),
    down: z.string().min(1).optional(),
    /**
     * ⛔ A **declared** field, not an inferred one. Phase 4 has a second
     * detection path (a zero-exit `up`), but a zod refinement cannot infer
     * this and a wrong guess means Sentinal either orphans a process or waits
     * forever on one that already finished.
     */
    detached: z.boolean().default(false),
    readiness: ReadinessSchema.optional(),
    shutdown: ShutdownSchema.default({ signal: "SIGTERM", graceMs: 10000 }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.up && !v.readiness) {
      ctx.addIssue({
        code: "custom",
        path: ["readiness"],
        message:
          "`up` requires `readiness`. Starting something with no way to know it " +
          "started is the exact failure this contract exists to prevent — the " +
          "run proceeds against a stack that is not up yet and fails somewhere " +
          'unrelated. Add a probe, e.g. "readiness": "http://localhost:3000/health" ' +
          'or { "type": "exec", "target": "nc -z localhost 3000" }.',
      });
    }
    if (v.detached && !v.down) {
      ctx.addIssue({
        code: "custom",
        path: ["down"],
        message:
          "`detached: true` requires `down`. A detaching starter returns " +
          "immediately and its process group owns nothing, so signal escalation " +
          "has no target and the stack would be left running.",
      });
    }
    checkTokens(v.up, "up", ctx, ["up"]);
    checkTokens(v.down, "down", ctx, ["down"]);
    checkTokens(v.readiness?.target, "readiness.target", ctx, [
      "readiness",
      "target",
    ]);
  });

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// ─── Isolation readers ──────────────────────────────────────────────────────

/**
 * The verdict for one resource class.
 *
 * ⛔ **Absence is `unknown`, NOT `shared`.** Defaulting absence to `shared`
 * while making `shared` blocking — composed with a scaffolder that omits the
 * map — would prompt on every run of every project. A prompt that always fires
 * carries no information, and a reflexively-accepted one actively teaches the
 * user to wave through "not isolated".
 */
export function isolationOf(
  config: RuntimeConfig | undefined,
  resource: ResourceClass,
): IsolationVerdict {
  return config?.isolation?.[resource] ?? "unknown";
}

/**
 * The resources the project has **explicitly** declared `"shared"`.
 *
 * Only these gate anything. `unknown` is reported non-blockingly elsewhere;
 * `isolated` and `none` say nothing at all.
 *
 * Also the R11 enrichment source: Phase 2's `notIsolatedWarning` can only emit
 * a blanket "may not be isolated" today; fed this list it names the resources.
 * ⚠️ It lives here, in `src/runtime/`, so that `src/worktree/` never has to
 * import from `src/runtime/` — see `loader.ts` for the cycle argument.
 */
export function sharedResourceNames(
  config: RuntimeConfig | undefined,
): string[] {
  const iso = config?.isolation;
  if (!iso) return [];

  const names: string[] = [];
  for (const cls of RESOURCE_CLASSES) {
    if (iso[cls] === "shared") names.push(cls);
  }
  for (const entry of iso.other ?? []) {
    if (entry.state === "shared") names.push(entry.name);
  }
  return names;
}
