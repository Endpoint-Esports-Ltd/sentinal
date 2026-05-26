/**
 * Spec-Verify Full TSC Guard — ensures verification skills mandate a full,
 * non-incremental `tsc --noEmit` run before a plan can transition to VERIFIED.
 *
 * Why this test exists:
 *
 * `quality_report` and `check_diagnostics` MCP tools use:
 *   1. An LSP client limited to opening ~10 .ts files (`lsp-client.ts:196`),
 *      which misses diagnostics in files 11+.
 *   2. Incremental tsc with a persistent `.tsbuildinfo` cache
 *      (`quality-routes.ts:184-193`) that can miss cross-file type errors.
 *
 * Both are fine for fast inner-loop feedback during implementation. They
 * are NOT sufficient as the pre-commit gate in the verify phase. This test
 * enforces that the four verification skill files (Claude Code + OpenCode,
 * each × spec-verify + spec-bugfix-verify) explicitly mandate a full
 * `tsc --noEmit` run.
 *
 * If a future refactor accidentally downgrades the verify-phase tsc check
 * to the cached MCP tool as the primary check, this test fails.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const VERIFY_SKILL_FILES = [
  join(REPO_ROOT, "targets", "claude-code", "commands", "spec-verify.md"),
  join(REPO_ROOT, "targets", "opencode", "skills", "spec-verify", "SKILL.md"),
  join(
    REPO_ROOT,
    "targets",
    "claude-code",
    "commands",
    "spec-bugfix-verify.md",
  ),
  join(
    REPO_ROOT,
    "targets",
    "opencode",
    "skills",
    "spec-bugfix-verify",
    "SKILL.md",
  ),
];

describe("Spec-Verify Full TSC Requirement", () => {
  describe.each(VERIFY_SKILL_FILES)("%s", (filePath) => {
    const content = readFileSync(filePath, "utf-8");

    it("mandates a full non-incremental tsc --noEmit run in the verification phase", () => {
      // The phrase "full project tsc" (or close variant) must appear as the
      // instruction to the agent. This ensures the verify-phase agent runs
      // tsc without the LSP/incremental cache, catching errors in files
      // not directly touched.
      const hasFullTscInstruction = /full\s+(project\s+)?tsc/i.test(content);
      expect(hasFullTscInstruction).toBe(true);
    });

    it("does NOT describe `tsc --noEmit` as merely a fallback", () => {
      // The bug pattern: "check_diagnostics MCP tool (or npx tsc --noEmit
      // as fallback)". When tsc is the fallback, the agent follows the
      // cached path first and commits broken types.
      const badPattern =
        /(tsc\s+--noEmit|bunx\s+tsc|npx\s+tsc)[^\n]{0,50}as\s+fallback/i;
      expect(badPattern.test(content)).toBe(false);
    });

    it("explicitly references the caching limitation to warn the agent", () => {
      // Must mention incremental / cache / LSP / 10 files limitation so
      // the agent understands why it can't rely on the fast MCP tool alone.
      const mentionsLimitation = /incremental|cache|LSP/i.test(content);
      expect(mentionsLimitation).toBe(true);
    });
  });
});
