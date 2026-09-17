/**
 * Tests for master-plan ↔ child-plan reconciliation.
 *
 * Fixtures are synthesised into a temp dir rather than pointed at the repo's
 * real `docs/plans/`, because those files legitimately change status over time
 * and would silently flip these assertions. Each fixture instead REPLICATES a
 * shape observed in the real tree, and says which one in a comment.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditMasterPlan,
  parsePhaseCheckboxes,
  resolveChildPlans,
} from "./master-audit.js";

let dir: string;
let plansDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinal-master-audit-"));
  plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeMaster(slug: string, progress: string, status = "IN_PROGRESS") {
  const p = join(plansDir, `${slug}.md`);
  writeFileSync(
    p,
    `# ${slug} Master Plan\n\n` +
      `Created: 2026-09-17\n` +
      `Status: ${status}\n` +
      `Approved: Yes\n` +
      `Type: Master\n\n` +
      `## Progress Tracking\n\n${progress}\n`,
  );
  return p;
}

function writeChild(
  slug: string,
  opts: { status: string; parent?: string | null; wave?: number },
) {
  const p = join(plansDir, `${slug}.md`);
  const parentLine =
    opts.parent === null ? "" : `Parent: ${opts.parent}\nWave: ${opts.wave ?? 1}\n`;
  writeFileSync(
    p,
    `# ${slug}\n\n` +
      `Created: 2026-09-17\n` +
      `Status: ${opts.status}\n` +
      `Approved: Yes\n` +
      `Type: Feature\n` +
      parentLine +
      `\n## Summary\n\nstub\n`,
  );
  return p;
}

const M = "2026-09-17-demo";

// ── parsePhaseCheckboxes ─────────────────────────────────────────────────────

describe("parsePhaseCheckboxes", () => {
  it("should parse a checked phase row with a declared status", () => {
    const rows = parsePhaseCheckboxes(
      "## Progress Tracking\n\n" +
        "- [x] Phase 1: Guidance + permission defaults (Wave 1) — **VERIFIED**\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe(1);
    expect(rows[0].checked).toBe(true);
    expect(rows[0].declaredStatus).toBe("VERIFIED");
  });

  it("should parse an unchecked phase row with no declared status", () => {
    // Shape of the live 2026-04-20-claude-opencode-changelog-audit master.
    const rows = parsePhaseCheckboxes(
      "## Progress Tracking\n\n- [ ] Phase 4: HTTP Hooks Architecture (Wave 2)\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe(4);
    expect(rows[0].checked).toBe(false);
    expect(rows[0].declaredStatus).toBeUndefined();
  });

  it("should ignore phase rows inside fenced code blocks", () => {
    const rows = parsePhaseCheckboxes(
      "## Progress Tracking\n\n" +
        "```markdown\n- [x] Phase 9: Example From Docs (Wave 1) — VERIFIED\n```\n" +
        "- [ ] Phase 1: Real Row (Wave 1)\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe(1);
  });
});

// ── resolveChildPlans ────────────────────────────────────────────────────────

describe("resolveChildPlans", () => {
  it("should resolve children by the Parent: back-link, not by filename", () => {
    const master = writeMaster(M, "- [ ] Phase 1: A (Wave 1)");
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });
    // Deliberately off-convention name, but correctly linked.
    writeChild(`${M}-extra-step`, { status: "VERIFIED", parent: M });

    const { children, orphans } = resolveChildPlans(master);

    expect(children.map((c) => c.slug).sort()).toEqual([
      `${M}-extra-step`,
      `${M}-phase-1`,
    ]);
    expect(orphans).toHaveLength(0);
  });

  it("should not claim children belonging to a different master", () => {
    const master = writeMaster(M, "- [ ] Phase 1: A (Wave 1)");
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });
    writeChild("2026-01-01-other-phase-1", {
      status: "PENDING",
      parent: "2026-01-01-other",
    });

    const { children } = resolveChildPlans(master);
    expect(children.map((c) => c.slug)).toEqual([`${M}-phase-1`]);
  });

  it("should report a phase-named file with no Parent: link as an orphan", () => {
    // Replicates 2026-08-07-worktree-runtime-isolation-phase-1-spike.md, whose
    // metadata line is prose: "Status: COMPLETE — all three questions answered".
    const master = writeMaster(M, "- [ ] Phase 1: A (Wave 1)");
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });
    writeChild(`${M}-phase-1-spike`, {
      status: "COMPLETE — all three questions answered with evidence.",
      parent: null,
    });

    const { children, orphans } = resolveChildPlans(master);

    expect(children.map((c) => c.slug)).toEqual([`${M}-phase-1`]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].slug).toBe(`${M}-phase-1-spike`);
  });
});

// ── auditMasterPlan ──────────────────────────────────────────────────────────

describe("auditMasterPlan — passing case", () => {
  it("should pass when every child is VERIFIED and every checkbox agrees", () => {
    // Replicates the consistent 2026-08-07-worktree-runtime-isolation tree.
    const master = writeMaster(
      M,
      "- [x] Phase 1: A (Wave 1) — **VERIFIED**\n" +
        "- [x] Phase 2: B (Wave 1) — **VERIFIED**",
      "VERIFIED",
    );
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M, wave: 1 });
    writeChild(`${M}-phase-2`, { status: "VERIFIED", parent: M, wave: 1 });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
    expect(r.verifiedCount).toBe(2);
    expect(r.totalCount).toBe(2);
  });
});

describe("auditMasterPlan — only VERIFIED passes", () => {
  // src/spec/types.ts:12-24 defines 11 statuses. COMPLETE means "implemented,
  // awaiting verification" and routes BACK into spec-verify, so it must fail.
  const mustFail = [
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "APPROVED",
    "DRAFT",
    "PLANNING",
    "IMPLEMENTING",
    "VERIFYING",
    "FAILED",
  ];

  it.each(mustFail)("should FAIL a child whose status is %s", (status) => {
    const master = writeMaster(M, `- [x] Phase 1: A (Wave 1) — **VERIFIED**`);
    writeChild(`${M}-phase-1`, { status, parent: M });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "not-verified")).toBe(true);
    expect(r.verifiedCount).toBe(0);
  });

  it("should FAIL a COMPLETE child even though the master checkbox is unchecked", () => {
    // The live 2026-04-20 master: checkbox [ ], child COMPLETE. Neither record
    // says VERIFIED, so there is no disagreement — but it still must not pass.
    const master = writeMaster(M, "- [ ] Phase 4: HTTP Hooks (Wave 2)");
    writeChild(`${M}-phase-4`, { status: "COMPLETE", parent: M, wave: 2 });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "not-verified")).toBe(true);
  });
});

describe("auditMasterPlan — disagreement in both directions", () => {
  it("should FAIL when the master claims VERIFIED but the child is PENDING", () => {
    const master = writeMaster(M, "- [x] Phase 1: A (Wave 1) — **VERIFIED**");
    writeChild(`${M}-phase-1`, { status: "PENDING", parent: M });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    const d = r.findings.find((f) => f.kind === "checkbox-disagrees");
    expect(d).toBeDefined();
    expect(d!.childStatus).toBe("PENDING");
    expect(d!.checkboxChecked).toBe(true);
  });

  it("should FAIL when the child is VERIFIED but the master checkbox is unchecked", () => {
    // This is the LIVE drift direction in this repo and the one a
    // master-ahead-of-child check cannot see.
    const master = writeMaster(M, "- [ ] Phase 1: A (Wave 1)");
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    const d = r.findings.find((f) => f.kind === "checkbox-disagrees");
    expect(d).toBeDefined();
    expect(d!.childStatus).toBe("VERIFIED");
    expect(d!.checkboxChecked).toBe(false);
  });
});

describe("auditMasterPlan — structural findings", () => {
  it("should FAIL when the master lists a phase that has no child file", () => {
    const master = writeMaster(
      M,
      "- [x] Phase 1: A (Wave 1) — **VERIFIED**\n- [x] Phase 2: B (Wave 1) — **VERIFIED**",
    );
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "missing-child")).toBe(true);
  });

  it("should FAIL on an orphan rather than silently skipping it", () => {
    const master = writeMaster(M, "- [x] Phase 1: A (Wave 1) — **VERIFIED**");
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });
    writeChild(`${M}-phase-2`, { status: "VERIFIED", parent: null });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "orphan")).toBe(true);
  });

  it("should FAIL when a master has no children at all", () => {
    const master = writeMaster(M, "- [ ] Phase 1: A (Wave 1)");

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "no-children")).toBe(true);
  });
});

describe("auditMasterPlan — CANCELLED is excluded, never silently passed", () => {
  it("should exclude a CANCELLED child from the ratio without failing", () => {
    const master = writeMaster(
      M,
      "- [x] Phase 1: A (Wave 1) — **VERIFIED**\n- [ ] Phase 2: B (Wave 1) — CANCELLED",
      "VERIFIED",
    );
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });
    writeChild(`${M}-phase-2`, { status: "CANCELLED", parent: M });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(true);
    expect(r.excluded.map((e) => e.slug)).toEqual([`${M}-phase-2`]);
    expect(r.verifiedCount).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it("should FAIL when a checkbox claims VERIFIED for a CANCELLED child", () => {
    const master = writeMaster(
      M,
      "- [x] Phase 1: A (Wave 1) — **VERIFIED**\n- [x] Phase 2: B (Wave 1) — **VERIFIED**",
    );
    writeChild(`${M}-phase-1`, { status: "VERIFIED", parent: M });
    writeChild(`${M}-phase-2`, { status: "CANCELLED", parent: M });

    const r = auditMasterPlan(master);

    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "checkbox-disagrees")).toBe(true);
  });
});

describe("auditMasterPlan — guards", () => {
  it("should throw for a plan that is not Type: Master", () => {
    const p = writeChild("2026-09-17-feature", { status: "PENDING", parent: null });
    expect(() => auditMasterPlan(p)).toThrow(/not a master plan/i);
  });

  it("should throw for a plan file that does not exist", () => {
    expect(() => auditMasterPlan(join(plansDir, "nope.md"))).toThrow(/not found/i);
  });
});
