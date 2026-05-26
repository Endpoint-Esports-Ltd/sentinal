/**
 * Target Asset Structural Tests — cross-target namespace leakage guard.
 *
 * Sentinal ships as extensions for two AI assistants (Claude Code and
 * OpenCode) with DIFFERENT agent-resolution conventions:
 *
 *   - **Claude Code** installs as a plugin via the `sentinal-marketplace`,
 *     and its plugin system namespaces everything as `sentinal:<name>`.
 *     Skills, commands, and sub-agents are all referenced as
 *     `sentinal:plan-reviewer`, `Skill(skill="sentinal:spec-implement")`,
 *     `/sentinal:spec`, etc.
 *
 *   - **OpenCode** installs as a flat directory under
 *     `~/.config/opencode/{agents,skills,commands,rules}` with NO
 *     namespacing. Agents are resolved by the bare filename of files in
 *     `targets/opencode/agents/*.md` — e.g., `plan-reviewer.md` is
 *     invoked as `Task(subagent_type="plan-reviewer")`.
 *
 * Because the two targets are mirrored via mass copy (see commit
 * `999cc5f`), it's easy for Claude-specific namespace prefixes to leak
 * into OpenCode files. This test walks every `.md` under
 * `targets/opencode/` and fails if any reference the `sentinal:`-
 * prefixed reviewer agents. If a future refactor reintroduces the leak,
 * this test catches it immediately.
 *
 * The preservation assertions at the bottom check the opposite
 * direction: Claude Code files MUST retain the `sentinal:` prefix.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OPENCODE_DIR = join(REPO_ROOT, "targets", "opencode");
const CLAUDE_DIR = join(REPO_ROOT, "targets", "claude-code");

function walkMarkdown(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry.endsWith(".md")) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

describe("target asset namespace parity", () => {
  describe("targets/opencode/ — must NOT contain Claude Code namespace prefixes", () => {
    it("no .md file under targets/opencode/ references 'sentinal:plan-reviewer'", () => {
      const offenders: Array<{ file: string; lines: number[] }> = [];
      for (const file of walkMarkdown(OPENCODE_DIR)) {
        const content = readFileSync(file, "utf-8");
        if (!content.includes("sentinal:plan-reviewer")) continue;
        const lines: number[] = [];
        content.split("\n").forEach((line, idx) => {
          if (line.includes("sentinal:plan-reviewer")) lines.push(idx + 1);
        });
        offenders.push({
          file: file.replace(REPO_ROOT + "/", ""),
          lines,
        });
      }
      if (offenders.length > 0) {
        const report = offenders
          .map((o) => `  ${o.file}: lines ${o.lines.join(", ")}`)
          .join("\n");
        throw new Error(
          `OpenCode files must not reference 'sentinal:plan-reviewer' — ` +
            `that prefix is a Claude Code plugin namespace. OpenCode resolves ` +
            `agents by bare filename (see targets/opencode/agents/plan-reviewer.md). ` +
            `Use bare 'plan-reviewer' instead.\n\nOffenders:\n${report}`,
        );
      }
      expect(offenders).toEqual([]);
    });

    it("no .md file under targets/opencode/ references 'sentinal:spec-reviewer'", () => {
      const offenders: Array<{ file: string; lines: number[] }> = [];
      for (const file of walkMarkdown(OPENCODE_DIR)) {
        const content = readFileSync(file, "utf-8");
        if (!content.includes("sentinal:spec-reviewer")) continue;
        const lines: number[] = [];
        content.split("\n").forEach((line, idx) => {
          if (line.includes("sentinal:spec-reviewer")) lines.push(idx + 1);
        });
        offenders.push({
          file: file.replace(REPO_ROOT + "/", ""),
          lines,
        });
      }
      if (offenders.length > 0) {
        const report = offenders
          .map((o) => `  ${o.file}: lines ${o.lines.join(", ")}`)
          .join("\n");
        throw new Error(
          `OpenCode files must not reference 'sentinal:spec-reviewer' — ` +
            `that prefix is a Claude Code plugin namespace. OpenCode resolves ` +
            `agents by bare filename (see targets/opencode/agents/spec-reviewer.md). ` +
            `Use bare 'spec-reviewer' instead.\n\nOffenders:\n${report}`,
        );
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("targets/claude-code/settings.json — required config keys", () => {
    const settingsPath = join(CLAUDE_DIR, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

    it("statusLine.refreshInterval === 30", () => {
      expect(settings.statusLine?.refreshInterval).toBe(30);
    });

    it("plansDirectory === 'docs/plans'", () => {
      expect(settings.plansDirectory).toBe("docs/plans");
    });

    it("env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS === '10000'", () => {
      expect(settings.env?.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS).toBe(
        "10000",
      );
    });
  });

  describe("targets/claude-code/hooks/hooks.json — once:true on session-init hooks", () => {
    const hooksPath = join(CLAUDE_DIR, "hooks", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const sessionStartHooks = hooks.hooks?.SessionStart ?? [];

    it("memory-restore SessionStart entry has once: true", () => {
      const entry = sessionStartHooks.find((h: Record<string, unknown>) =>
        (h.hooks as Array<Record<string, unknown>>)?.some((i) =>
          (i.command as string)?.includes("memory-restore"),
        ),
      );
      expect(entry?.once).toBe(true);
    });

    it("session-start SessionStart entry has once: true", () => {
      const entry = sessionStartHooks.find((h: Record<string, unknown>) =>
        (h.hooks as Array<Record<string, unknown>>)?.some((i) =>
          (i.command as string)?.includes("session-start"),
        ),
      );
      expect(entry?.once).toBe(true);
    });

    it("post-compact-restore SessionStart entry does NOT have once: true", () => {
      const entry = sessionStartHooks.find((h: Record<string, unknown>) =>
        (h.hooks as Array<Record<string, unknown>>)?.some((i) =>
          (i.command as string)?.includes("post-compact-restore"),
        ),
      );
      expect(entry?.once).toBeUndefined();
    });
  });

  describe("targets/claude-code/ — must KEEP Claude Code namespace prefixes (preservation guard)", () => {
    it("Claude Code rules/task-and-workflow.md still references 'sentinal:plan-reviewer' and 'sentinal:spec-reviewer'", () => {
      const file = join(CLAUDE_DIR, "rules", "task-and-workflow.md");
      const content = readFileSync(file, "utf-8");
      // These are correct under Claude Code — the plugin system namespaces
      // all plugin-supplied sub-agents as `sentinal:<name>`. If either of
      // these assertions fails, someone over-corrected the OpenCode fix and
      // accidentally stripped the prefix from Claude Code.
      expect(content).toContain("sentinal:plan-reviewer");
      expect(content).toContain("sentinal:spec-reviewer");
    });

    it("Claude Code commands/spec-plan.md still references 'sentinal:plan-reviewer' for the Step 1.7 Task() launch", () => {
      const file = join(CLAUDE_DIR, "commands", "spec-plan.md");
      const content = readFileSync(file, "utf-8");
      expect(content).toContain('subagent_type="sentinal:plan-reviewer"');
    });

    it("Claude Code commands/spec-verify.md still references 'sentinal:spec-reviewer' for the Step 3.1 Task() launch", () => {
      const file = join(CLAUDE_DIR, "commands", "spec-verify.md");
      const content = readFileSync(file, "utf-8");
      expect(content).toContain('subagent_type="sentinal:spec-reviewer"');
    });
  });
});
