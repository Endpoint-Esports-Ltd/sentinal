/**
 * Orchestration mode resolution (D6/D9 of
 * docs/plans/2026-09-28-orca-orchestration.md): the ONE function that decides
 * whether a spec run dispatches through Orca or through sub-agents.
 *
 * Precedence: plan header `Orchestration: orca|subagents` → env
 * `SENTINAL_ORCHESTRATION=auto|orca|subagents` (default `auto`; invalid →
 * `auto`, said so in the reason). Orca is only ever chosen when the injected
 * `detect()` reports it available — a forced `orca` never pretends. Single
 * plans (`scope: "plan"`) are opt-in: only the plan header selects Orca (D9).
 *
 * Deliberately dependency-free (no zod, no bun:sqlite, no src/orca import):
 * the parser imports `parseOrchestrationHeader`, and the OpenCode plugin may
 * reach the parser transitively. `detect` is structurally compatible with
 * `detectOrca()` from src/orca/detect.ts, wired in by the caller.
 */

export const ORCHESTRATION_ENV = "SENTINAL_ORCHESTRATION";

export type OrchestrationMode = "orca" | "subagents";
export type OrchestrationSetting = "auto" | OrchestrationMode;
/** `master` = spec-master-execute (auto may pick Orca); `plan` = a single plan. */
export type OrchestrationScope = "master" | "plan";

export interface OrcaDetection {
  available: boolean;
  reason: string;
}
export type OrcaDetector = () => OrcaDetection | Promise<OrcaDetection>;

export interface ResolveOrchestrationInput {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** `spec.metadata.orchestration` — already normalized by the parser. */
  planHeader?: OrchestrationMode;
  /** Called at most once, and only when Orca was requested. */
  detect: OrcaDetector;
  scope: OrchestrationScope;
}

export interface OrchestrationDecision {
  mode: OrchestrationMode;
  /** One line saying why. */
  reason: string;
}

/** Normalize a plan header value; anything but orca/subagents → undefined. */
export function parseOrchestrationHeader(
  raw: string | undefined,
): OrchestrationMode | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "orca" || v === "subagents" ? v : undefined;
}

/** Parse the env setting; blank → auto, invalid → auto + `invalid`. */
export function parseOrchestrationSetting(raw: string | undefined): {
  setting: OrchestrationSetting;
  invalid?: string;
} {
  const v = raw?.trim().toLowerCase();
  if (!v) return { setting: "auto" };
  if (v === "auto" || v === "orca" || v === "subagents") return { setting: v };
  return { setting: "auto", invalid: raw };
}

/** `spec_config` / `spec_init` display for the env value. */
export function describeOrchestrationSetting(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "unset (default: auto)";
  const { invalid } = parseOrchestrationSetting(raw);
  return invalid === undefined
    ? raw
    : `${raw} (invalid — treated as auto; expected auto|orca|subagents)`;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

async function runDetect(detect: OrcaDetector): Promise<OrcaDetection> {
  try {
    const d = await detect();
    return { available: d.available === true, reason: oneLine(d.reason) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, reason: oneLine(`detection failed: ${msg}`) };
  }
}

/** Orca was requested by `source`: use it iff detection says so. */
async function requestOrca(
  source: string,
  detect: OrcaDetector,
): Promise<OrchestrationDecision> {
  const d = await runDetect(detect);
  return d.available
    ? { mode: "orca", reason: `${source}; ${d.reason}` }
    : {
        mode: "subagents",
        reason: `${source}, but Orca is unavailable: ${d.reason}`,
      };
}

export async function resolveOrchestrationMode(
  input: ResolveOrchestrationInput,
): Promise<OrchestrationDecision> {
  const { planHeader, detect, scope } = input;

  if (planHeader === "subagents") {
    return {
      mode: "subagents",
      reason: "plan header `Orchestration: subagents`",
    };
  }
  if (planHeader === "orca") {
    return requestOrca("plan header `Orchestration: orca`", detect);
  }

  const env = input.env ?? process.env;
  const { setting, invalid } = parseOrchestrationSetting(
    env[ORCHESTRATION_ENV],
  );
  const note =
    invalid === undefined
      ? ""
      : `${ORCHESTRATION_ENV}=${JSON.stringify(oneLine(invalid))} is not auto|orca|subagents — treated as auto; `;

  if (setting === "subagents") {
    return { mode: "subagents", reason: `${ORCHESTRATION_ENV}=subagents` };
  }
  if (scope === "plan") {
    const source =
      setting === "orca" ? `${ORCHESTRATION_ENV}=orca, but ` : note;
    return {
      mode: "subagents",
      reason: `${source}single plans use Orca only with the plan header \`Orchestration: orca\` (opt-in)`,
    };
  }
  if (setting === "orca") {
    return requestOrca(`${ORCHESTRATION_ENV}=orca`, detect);
  }
  return requestOrca(`${note}auto`, detect);
}
