/**
 * Spec Skill Memory-Integration Tests.
 *
 * Guards that the spec skills explicitly use Sentinal memory at the points where
 * recall pays off — planning (recall before exploration + save at finalize) and
 * runtime PIVOT moments (fix-attempt limit, library/architecture pivot, surprise
 * discovery, bugfix escalation, master phase-fail). Before this integration the
 * spec skills made ZERO use of memory_search/memory_save, relying only on a
 * passive rule + ambient session-start injection.
 *
 * Coverage spans BOTH targets (OpenCode skills + Claude Code commands) AND the
 * generated embedded copy (the actual `sentinal install` delivery path).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OC = join(REPO_ROOT, "targets", "opencode", "skills");
const CC = join(REPO_ROOT, "targets", "claude-code", "commands");

function ocSkill(name: string): string {
  return readFileSync(join(OC, name, "SKILL.md"), "utf-8");
}
function ccCmd(name: string): string {
  return readFileSync(join(CC, `${name}.md`), "utf-8");
}

// Planning skills: memory_search must appear BEFORE the given anchor step.
// Heading depth varies (## vs ###) and anchor name varies across skills, so we
// match with a depth-agnostic regex and FAIL LOUD if the anchor is absent.
const PLANNING = [
  { name: "spec-plan", anchor: /^#{2,3}\s+Step 1\.2: Task Understanding/m },
  {
    name: "spec-bugfix-plan",
    anchor: /^#{2,3}\s+Step 1\.2: Root Cause Investigation/m,
  },
  {
    name: "spec-master-plan",
    anchor: /^#{2,3}\s+Step 1\.2: Task Understanding/m,
  },
] as const;

function assertSearchBeforeAnchor(
  label: string,
  content: string,
  anchor: RegExp,
): void {
  const searchIdx = content.indexOf("memory_search");
  const anchorMatch = anchor.exec(content);
  if (!anchorMatch) {
    throw new Error(
      `${label}: anchor heading not found (${anchor}). The step may have been ` +
        `renamed — update the anchor map in spec-memory-integration.test.ts.`,
    );
  }
  expect(searchIdx, `${label}: missing memory_search`).toBeGreaterThan(-1);
  expect(
    searchIdx,
    `${label}: memory_search must appear BEFORE the anchor step`,
  ).toBeLessThan(anchorMatch.index);
}

// The finalize save must fire on BOTH the interactive approve AND the
// auto-approve path (SENTINAL_PLAN_APPROVAL_ENABLED="false", e.g. /quick).
// Assert the save instruction references that auto-approve path so a future
// edit can't silently regress it to human-approval-only.
function assertSaveFiresOnAutoApprove(label: string, content: string): void {
  const saveIdx = content.indexOf("memory_save");
  expect(saveIdx, `${label}: missing memory_save`).toBeGreaterThan(-1);
  // The finalize-save paragraph must mention the auto-approve toggle so the
  // recall loop works for approval-skipped runs (/quick).
  expect(
    content.includes("SENTINAL_PLAN_APPROVAL_ENABLED"),
    `${label}: finalize memory_save must also fire on the auto-approve path ` +
      `(reference SENTINAL_PLAN_APPROVAL_ENABLED) so /quick still persists`,
  ).toBe(true);
}

describe("spec planning skills — recall before exploration + save at finalize", () => {
  for (const { name, anchor } of PLANNING) {
    it(`${name} (OpenCode) recalls before anchor and saves on both approve paths`, () => {
      const c = ocSkill(name);
      assertSearchBeforeAnchor(`${name} OC`, c, anchor);
      assertSaveFiresOnAutoApprove(`${name} OC`, c);
    });
    it(`${name} (Claude Code) recalls before anchor and saves on both approve paths`, () => {
      const c = ccCmd(name);
      assertSearchBeforeAnchor(`${name} CC`, c, anchor);
      assertSaveFiresOnAutoApprove(`${name} CC`, c);
    });
  }
});

describe("spec-implement — pivot recall + save (fix-limit, deviation pivot, surprise)", () => {
  it("OpenCode contains memory_search and memory_save", () => {
    const c = ocSkill("spec-implement");
    expect(c).toContain("memory_search");
    expect(c).toContain("memory_save");
  });
  it("Claude Code contains memory_search and memory_save", () => {
    const c = ccCmd("spec-implement");
    expect(c).toContain("memory_search");
    expect(c).toContain("memory_save");
  });
});

describe("spec-master-execute — phase-fail recall", () => {
  it("OpenCode contains memory_search at failure handling", () => {
    expect(ocSkill("spec-master-execute")).toContain("memory_search");
  });
  it("Claude Code contains memory_search at failure handling", () => {
    expect(ccCmd("spec-master-execute")).toContain("memory_search");
  });
});

describe("delivery path — embedded copy stays in sync", () => {
  it("EMBEDDED_OC_SKILLS contains memory_search for all 5 spec skills", async () => {
    const { EMBEDDED_OC_SKILLS } = await import("./embedded-assets.js");
    const skills = EMBEDDED_OC_SKILLS as Record<string, string>;
    for (const name of [
      "spec-plan",
      "spec-bugfix-plan",
      "spec-master-plan",
      "spec-implement",
      "spec-master-execute",
    ]) {
      const content = skills[`${name}/SKILL.md`];
      expect(content, `embedded skill missing: ${name}`).toBeDefined();
      expect(
        content.includes("memory_search"),
        `embedded ${name} missing memory_search — run 'bun run embed-assets'`,
      ).toBe(true);
    }
  });
});
