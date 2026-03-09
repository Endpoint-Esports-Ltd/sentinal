import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findActivePlan, detectSpecType } from "./detect.js";

// --- findActivePlan ---

describe("findActivePlan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sentinal-detect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return null when no plans directory exists", () => {
    const emptyDir = join(tmpdir(), `sentinal-detect-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    expect(findActivePlan(emptyDir)).toBeNull();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("should return null when all plans are terminal", () => {
    writeFileSync(
      join(tmpDir, "docs", "plans", "2026-01-01-done.md"),
      "# Done Plan\n\nStatus: VERIFIED\n",
    );
    expect(findActivePlan(tmpDir)).toBeNull();
  });

  it("should find an active PENDING plan", () => {
    writeFileSync(
      join(tmpDir, "docs", "plans", "2026-03-01-feature.md"),
      "# Feature Plan\n\nStatus: PENDING\nType: Feature\n",
    );
    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.status).toBe("PENDING");
    expect(result!.spec.id).toBe("2026-03-01-feature");
  });

  it("should prefer the most recent plan (reverse alpha sort)", () => {
    writeFileSync(
      join(tmpDir, "docs", "plans", "2026-01-01-old.md"),
      "# Old Plan\n\nStatus: PENDING\n",
    );
    writeFileSync(
      join(tmpDir, "docs", "plans", "2026-03-01-new.md"),
      "# New Plan\n\nStatus: IN PROGRESS\n",
    );
    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.id).toBe("2026-03-01-new");
  });

  it("should skip VERIFIED plans and find active one", () => {
    writeFileSync(
      join(tmpDir, "docs", "plans", "2026-03-02-verified.md"),
      "# Verified Plan\n\nStatus: VERIFIED\n",
    );
    writeFileSync(
      join(tmpDir, "docs", "plans", "2026-03-01-active.md"),
      "# Active Plan\n\nStatus: COMPLETE\n",
    );
    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.id).toBe("2026-03-01-active");
    expect(result!.spec.status).toBe("COMPLETE");
  });
});

// --- detectSpecType ---

describe("detectSpecType", () => {
  it("should detect bugfix from title keywords", () => {
    expect(detectSpecType("Fix login bug", "")).toBe("bugfix");
  });

  it("should detect bugfix from content keywords", () => {
    expect(detectSpecType("Authentication issue", "This patch resolves a regression")).toBe("bugfix");
  });

  it("should detect feature when no bugfix keywords", () => {
    expect(detectSpecType("Add user profiles", "New feature for user management")).toBe("feature");
  });

  it("should detect feature with only one bugfix keyword", () => {
    expect(detectSpecType("Fix styling", "Updated CSS layout")).toBe("feature");
  });

  it("should detect bugfix with multiple keywords", () => {
    expect(detectSpecType("Hotfix for defect", "Critical production issue")).toBe("bugfix");
  });
});
