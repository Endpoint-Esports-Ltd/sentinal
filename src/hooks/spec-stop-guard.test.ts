import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { shouldBlockStop, findActivePlan } from "../spec/detect";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";

describe("spec-stop-guard", () => {
  it("should block PENDING", () => {
    const r = shouldBlockStop("PENDING");
    expect(r).not.toBeNull();
    expect(r).toContain("PENDING");
  });
  it("should block COMPLETE", () => {
    const r = shouldBlockStop("COMPLETE");
    expect(r).not.toBeNull();
    expect(r).toContain("COMPLETE");
  });
  it("should not block IN_PROGRESS", () => {
    expect(shouldBlockStop("IN_PROGRESS")).toBeNull();
  });
  it("should not block VERIFIED", () => {
    expect(shouldBlockStop("VERIFIED")).toBeNull();
  });
  it("should not block null", () => {
    expect(shouldBlockStop(null)).toBeNull();
  });
});

describe("findActivePlan — master priority", () => {
  let tmpDir: string;

  function writePlan(filename: string, content: string): void {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, filename), content);
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should return master plan when both master and child are active", () => {
    writePlan("2026-03-18-big-feature.md", `# Big Feature
Status: IN_PROGRESS
Type: Master
Approved: Yes
`);
    writePlan("2026-03-18-big-feature-phase-1.md", `# Phase 1
Status: IN_PROGRESS
Type: Feature
Parent: big-feature
Wave: 1
Approved: Yes
`);

    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.type).toBe("master");
    expect(result!.filePath).toContain("big-feature.md");
  });

  it("should return child plan when no master is active", () => {
    writePlan("2026-03-18-big-feature.md", `# Big Feature
Status: VERIFIED
Type: Master
`);
    writePlan("2026-03-18-big-feature-phase-1.md", `# Phase 1
Status: IN_PROGRESS
Type: Feature
Parent: big-feature
Wave: 1
`);

    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.type).toBe("feature");
  });

  it("should return null when no plans exist", () => {
    expect(findActivePlan(tmpDir)).toBeNull();
  });
});
