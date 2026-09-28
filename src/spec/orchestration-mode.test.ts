import { describe, it, expect } from "bun:test";
import {
  resolveOrchestrationMode,
  parseOrchestrationHeader,
  parseOrchestrationSetting,
  describeOrchestrationSetting,
  ORCHESTRATION_ENV,
  type OrcaDetection,
  type OrchestrationScope,
} from "./orchestration-mode.js";

const READY: OrcaDetection = { available: true, reason: "orca runtime ready" };
const DOWN: OrcaDetection = {
  available: false,
  reason: "ORCA_TERMINAL_HANDLE is not set",
};

/** A detector that records how often it was consulted. */
function detector(result: OrcaDetection) {
  const calls = { n: 0 };
  const fn = () => {
    calls.n++;
    return result;
  };
  return { fn, calls };
}

describe("parseOrchestrationHeader", () => {
  it("accepts orca/subagents case-insensitively, trimmed", () => {
    expect(parseOrchestrationHeader("orca")).toBe("orca");
    expect(parseOrchestrationHeader(" ORCA ")).toBe("orca");
    expect(parseOrchestrationHeader("SubAgents")).toBe("subagents");
  });

  it("ignores anything else without throwing", () => {
    expect(parseOrchestrationHeader(undefined)).toBeUndefined();
    expect(parseOrchestrationHeader("")).toBeUndefined();
    expect(parseOrchestrationHeader("auto")).toBeUndefined();
    expect(parseOrchestrationHeader("orca please")).toBeUndefined();
    expect(parseOrchestrationHeader("sub-agents")).toBeUndefined();
  });
});

describe("parseOrchestrationSetting", () => {
  it("defaults to auto when unset or blank", () => {
    expect(parseOrchestrationSetting(undefined)).toEqual({ setting: "auto" });
    expect(parseOrchestrationSetting("  ")).toEqual({ setting: "auto" });
  });

  it("accepts auto/orca/subagents case-insensitively", () => {
    expect(parseOrchestrationSetting("AUTO").setting).toBe("auto");
    expect(parseOrchestrationSetting("Orca").setting).toBe("orca");
    expect(parseOrchestrationSetting("subagents").setting).toBe("subagents");
    expect(parseOrchestrationSetting("orca").invalid).toBeUndefined();
  });

  it("falls back to auto on an invalid value and remembers it", () => {
    expect(parseOrchestrationSetting("yes")).toEqual({
      setting: "auto",
      invalid: "yes",
    });
  });
});

describe("describeOrchestrationSetting", () => {
  it("renders unset, valid and invalid values", () => {
    expect(describeOrchestrationSetting(undefined)).toBe(
      "unset (default: auto)",
    );
    expect(describeOrchestrationSetting("orca")).toBe("orca");
    expect(describeOrchestrationSetting("bogus")).toContain("invalid");
    expect(describeOrchestrationSetting("bogus")).toContain("auto");
  });
});

describe("resolveOrchestrationMode — matrix", () => {
  type Row = {
    scope: OrchestrationScope;
    env: string | undefined;
    header: "orca" | "subagents" | undefined;
    detect: OrcaDetection;
    mode: "orca" | "subagents";
    detects: boolean;
    reason: RegExp;
  };

  const rows: Row[] = [];
  const scopes: OrchestrationScope[] = ["master", "plan"];
  const envs = [undefined, "auto", "orca", "subagents", "bogus"];
  const headers = [undefined, "orca", "subagents"] as const;

  for (const scope of scopes)
    for (const env of envs)
      for (const header of headers)
        for (const detect of [READY, DOWN]) {
          const setting =
            env === "orca" || env === "subagents" ? env : ("auto" as const);
          // What was requested, before availability.
          let wantsOrca: boolean;
          if (header) wantsOrca = header === "orca";
          else if (setting === "subagents") wantsOrca = false;
          else if (scope === "plan")
            wantsOrca = false; // D9: header opt-in only
          else wantsOrca = true; // master: auto and orca both consult detect
          const mode = wantsOrca && detect.available ? "orca" : "subagents";
          let reason: RegExp;
          if (!wantsOrca) reason = /./;
          else if (!detect.available)
            reason = /ORCA_TERMINAL_HANDLE is not set/;
          else reason = /orca runtime ready/;
          rows.push({
            scope,
            env,
            header,
            detect,
            mode,
            detects: wantsOrca,
            reason,
          });
        }

  for (const r of rows) {
    const name = `scope=${r.scope} env=${r.env ?? "unset"} header=${r.header ?? "none"} detect=${r.detect.available ? "ready" : "down"} → ${r.mode}`;
    it(name, async () => {
      const d = detector(r.detect);
      const env: Record<string, string | undefined> = {};
      if (r.env !== undefined) env[ORCHESTRATION_ENV] = r.env;
      const out = await resolveOrchestrationMode({
        env,
        planHeader: r.header,
        detect: d.fn,
        scope: r.scope,
      });
      expect(out.mode).toBe(r.mode);
      expect(out.reason).toMatch(r.reason);
      expect(out.reason).not.toContain("\n");
      // Detection (which spawns `orca`) runs only when Orca was requested.
      expect(d.calls.n).toBe(r.detects ? 1 : 0);
    });
  }

  it("covers every combination", () => {
    expect(rows.length).toBe(2 * 5 * 3 * 2);
  });
});

describe("resolveOrchestrationMode — reasons and edge cases", () => {
  it("header wins over the env var", async () => {
    const out = await resolveOrchestrationMode({
      env: { [ORCHESTRATION_ENV]: "subagents" },
      planHeader: "orca",
      detect: () => READY,
      scope: "master",
    });
    expect(out.mode).toBe("orca");
    expect(out.reason).toContain("Orchestration:");
  });

  it("an invalid env value is named in the reason", async () => {
    const out = await resolveOrchestrationMode({
      env: { [ORCHESTRATION_ENV]: "bogus" },
      detect: () => DOWN,
      scope: "master",
    });
    expect(out.mode).toBe("subagents");
    expect(out.reason).toContain("bogus");
    expect(out.reason).toContain(ORCHESTRATION_ENV);
  });

  it("forced orca never pretends when Orca is unavailable", async () => {
    const out = await resolveOrchestrationMode({
      env: { [ORCHESTRATION_ENV]: "orca" },
      detect: () => DOWN,
      scope: "master",
    });
    expect(out.mode).toBe("subagents");
    expect(out.reason).toContain(DOWN.reason);
  });

  it("single plans stay on subagents under auto and say why", async () => {
    const out = await resolveOrchestrationMode({
      env: {},
      detect: () => READY,
      scope: "plan",
    });
    expect(out.mode).toBe("subagents");
    expect(out.reason).toContain("Orchestration: orca");
  });

  it("accepts an async detector", async () => {
    const out = await resolveOrchestrationMode({
      env: {},
      detect: async () => READY,
      scope: "master",
    });
    expect(out.mode).toBe("orca");
  });

  it("a throwing detector degrades to subagents with the error", async () => {
    const out = await resolveOrchestrationMode({
      env: {},
      detect: () => {
        throw new Error("spawn orca ENOENT");
      },
      scope: "master",
    });
    expect(out.mode).toBe("subagents");
    expect(out.reason).toContain("spawn orca ENOENT");
  });

  it("a multi-line detect reason is flattened to one line", async () => {
    const out = await resolveOrchestrationMode({
      env: {},
      detect: () => ({ available: false, reason: "line one\nline two" }),
      scope: "master",
    });
    expect(out.reason).not.toContain("\n");
    expect(out.reason).toContain("line one line two");
  });

  it("defaults env to process.env", async () => {
    const saved = process.env[ORCHESTRATION_ENV];
    process.env[ORCHESTRATION_ENV] = "subagents";
    try {
      const out = await resolveOrchestrationMode({
        detect: () => READY,
        scope: "master",
      });
      expect(out.mode).toBe("subagents");
    } finally {
      if (saved === undefined) delete process.env[ORCHESTRATION_ENV];
      else process.env[ORCHESTRATION_ENV] = saved;
    }
  });
});
