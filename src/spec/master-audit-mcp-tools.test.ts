/**
 * Tests for the `spec_master_audit` MCP tool.
 *
 * ⛔ The production deps are `{ client, store: null }` — MCP tools receive a
 * null store whenever the sidecar is running. Every test here registers with
 * `store: null` on purpose, because a tool that derives its answer from `store`
 * passes a test that supplies one and then does nothing in the field.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerSpecTools } from "./mcp-tools.js";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";
import type { SidecarClient } from "../sidecar/client.js";

const M = "2026-09-17-demo";

let tmpDir: string;
let plansDir: string;
let tools: Map<string, ToolHandler>;

beforeEach(() => {
  tmpDir = makeTmpDir("sentinal-master-audit-mcp");
  plansDir = join(tmpDir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  tools = captureTools(registerSpecTools, {
    client: {} as SidecarClient,
    store: null,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeMaster(progress: string, status = "IN_PROGRESS"): string {
  const p = join(plansDir, `${M}.md`);
  writeFileSync(
    p,
    `# Demo Master Plan\n\nCreated: 2026-09-17\nStatus: ${status}\n` +
      `Approved: Yes\nType: Master\n\n## Progress Tracking\n\n${progress}\n`,
  );
  return p;
}

function writeChild(slug: string, status: string, parent: string | null = M) {
  writeFileSync(
    join(plansDir, `${slug}.md`),
    `# ${slug}\n\nCreated: 2026-09-17\nStatus: ${status}\nApproved: Yes\n` +
      `Type: Feature\n${parent ? `Parent: ${parent}\nWave: 1\n` : ""}\n## Summary\n\nstub\n`,
  );
}

async function run(plan_path: string): Promise<string> {
  const handler = tools.get("spec_master_audit");
  if (!handler) throw new Error("spec_master_audit is not registered");
  const res = await handler({ plan_path });
  return res.content.map((c) => c.text).join("\n");
}

describe("spec_master_audit — registration", () => {
  it("should be registered with a null store, as in production", () => {
    expect(tools.has("spec_master_audit")).toBe(true);
  });
});

describe("spec_master_audit — reporting", () => {
  it("should report PASS when every child is VERIFIED and checkboxes agree", async () => {
    const p = writeMaster(
      "- [x] Phase 1: A (Wave 1) — **VERIFIED**\n- [x] Phase 2: B (Wave 1) — **VERIFIED**",
      "VERIFIED",
    );
    writeChild(`${M}-phase-1`, "VERIFIED");
    writeChild(`${M}-phase-2`, "VERIFIED");

    const out = await run(p);

    expect(out).toContain("PASS");
    expect(out).toContain("2/2");
    expect(out).not.toContain("must_fix");
  });

  it("should report FAIL and name the offending child when one is COMPLETE", async () => {
    const p = writeMaster("- [x] Phase 1: A (Wave 1) — **VERIFIED**");
    writeChild(`${M}-phase-1`, "COMPLETE");

    const out = await run(p);

    expect(out).toContain("FAIL");
    expect(out).toContain("must_fix");
    expect(out).toContain(`${M}-phase-1`);
    expect(out).toContain("COMPLETE");
  });

  it("should render a child/checkbox table showing both records", async () => {
    const p = writeMaster("- [ ] Phase 1: A (Wave 1)");
    writeChild(`${M}-phase-1`, "VERIFIED");

    const out = await run(p);

    expect(out).toContain("| Child | Status | Master checkbox |");
    expect(out).toContain("DISAGREES");
  });

  it("should surface an orphan rather than omitting it", async () => {
    const p = writeMaster("- [x] Phase 1: A (Wave 1) — **VERIFIED**");
    writeChild(`${M}-phase-1`, "VERIFIED");
    writeChild(`${M}-phase-2`, "COMPLETE — answered with evidence.", null);

    const out = await run(p);

    expect(out).toContain("FAIL");
    expect(out).toContain(`${M}-phase-2`);
    expect(out.toLowerCase()).toContain("orphan");
  });

  it("should list a CANCELLED child as excluded without failing", async () => {
    const p = writeMaster(
      "- [x] Phase 1: A (Wave 1) — **VERIFIED**\n- [ ] Phase 2: B (Wave 1) — CANCELLED",
      "VERIFIED",
    );
    writeChild(`${M}-phase-1`, "VERIFIED");
    writeChild(`${M}-phase-2`, "CANCELLED");

    const out = await run(p);

    expect(out).toContain("PASS");
    expect(out.toLowerCase()).toContain("excluded");
    expect(out).toContain(`${M}-phase-2`);
  });
});

// ── Master awareness in spec_status / spec_init ──────────────────────────────
//
// A master's own task list is empty, and detect.ts:44 makes an active master
// short-circuit findActivePlan — so both tools reported "0/0 tasks (0%)" and
// MASKED every child's progress. That reporting blind spot is why the drift
// could sit unobserved between runs.

describe("spec_status / spec_init — master awareness", () => {
  it("spec_status should report the child aggregate for a master plan", async () => {
    const planFile = writeMaster(
      "- [ ] Phase 1: A (Wave 1)\n- [ ] Phase 2: B (Wave 1)",
    );
    writeChild(`${M}-phase-1`, "VERIFIED");
    writeChild(`${M}-phase-2`, "COMPLETE");

    const sidecarTools = captureTools(registerSpecTools, {
      client: {
        getCurrentSpec: async () => ({
          id: M,
          title: "Demo Master Plan",
          status: "IN_PROGRESS" as const,
          type: "master" as const,
          approved: true,
          planFile,
          tasks: [],
          metadata: {},
        }),
      } as unknown as SidecarClient,
      store: null,
    });

    const res = await sidecarTools.get("spec_status")!({ project: tmpDir });
    const text = res.content.map((c) => c.text).join("\n");

    expect(text).toContain("Child Plans");
    expect(text).toContain("1/2");
    expect(text).toContain(`${M}-phase-2`);
    expect(text).toContain("DRIFT");
  });

  it("spec_status should be unchanged for a non-master plan", async () => {
    const sidecarTools = captureTools(registerSpecTools, {
      client: {
        getCurrentSpec: async () => ({
          id: "feat",
          title: "Feature",
          status: "IN_PROGRESS" as const,
          type: "feature" as const,
          approved: true,
          planFile: join(plansDir, "feat.md"),
          tasks: [{ position: 1, title: "T1", status: "complete" as const }],
          metadata: {},
        }),
      } as unknown as SidecarClient,
      store: null,
    });

    const res = await sidecarTools.get("spec_status")!({ project: tmpDir });
    const text = res.content.map((c) => c.text).join("\n");

    expect(text).not.toContain("Child Plans");
    expect(text).toContain("1/1 tasks (100%)");
  });

  it("spec_init should report the child aggregate instead of the master's empty 0/0", async () => {
    writeMaster("- [ ] Phase 1: A (Wave 1)\n- [ ] Phase 2: B (Wave 1)");
    writeChild(`${M}-phase-1`, "VERIFIED");
    writeChild(`${M}-phase-2`, "COMPLETE");

    const res = await tools.get("spec_init")!({ project: tmpDir });
    const text = res.content.map((c) => c.text).join("\n");

    expect(text).toContain("Child Plans");
    expect(text).toContain("1/2");
    expect(text).toContain("DRIFT");
  });

  it("spec_init should stay silent about children for a non-master plan", async () => {
    writeChild("2026-09-17-plain-feature", "IN_PROGRESS", null);

    const res = await tools.get("spec_init")!({ project: tmpDir });
    const text = res.content.map((c) => c.text).join("\n");

    expect(text).not.toContain("Child Plans");
  });
});

describe("spec_master_audit — errors", () => {
  it("should return a clear error for a non-master plan instead of throwing", async () => {
    writeChild("2026-09-17-feature", "PENDING", null);
    const out = await run(join(plansDir, "2026-09-17-feature.md"));
    expect(out.toLowerCase()).toContain("not a master plan");
  });

  it("should return a clear error for a missing file", async () => {
    const out = await run(join(plansDir, "nope.md"));
    expect(out.toLowerCase()).toContain("not found");
  });
});
