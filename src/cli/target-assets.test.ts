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

    // After the Phase 4 args-exec-form migration, command is "sentinal" and the
    // hook name appears in the args array — match on args instead of command.
    function matchesHookName(
      name: string,
      item: Record<string, unknown>,
    ): boolean {
      const args = item.args as string[] | undefined;
      if (args) return args.some((a) => a.includes(name));
      return (item.command as string | undefined)?.includes(name) ?? false;
    }

    it("memory-restore SessionStart entry has once: true", () => {
      const entry = sessionStartHooks.find((h: Record<string, unknown>) =>
        (h.hooks as Array<Record<string, unknown>>)?.some((i) =>
          matchesHookName("memory-restore", i),
        ),
      );
      expect(entry?.once).toBe(true);
    });

    it("session-start SessionStart entry has once: true", () => {
      const entry = sessionStartHooks.find((h: Record<string, unknown>) =>
        (h.hooks as Array<Record<string, unknown>>)?.some((i) =>
          matchesHookName("session-start", i),
        ),
      );
      expect(entry?.once).toBe(true);
    });

    it("post-compact-restore SessionStart entry does NOT have once: true", () => {
      const entry = sessionStartHooks.find((h: Record<string, unknown>) =>
        (h.hooks as Array<Record<string, unknown>>)?.some((i) =>
          matchesHookName("post-compact-restore", i),
        ),
      );
      expect(entry?.once).toBeUndefined();
    });
  });

  describe("embedded OpenCode plugin — must be self-contained (no bare external imports)", () => {
    // Root cause guard for the 2026-06-10 Linux startup failure: the plugin
    // bundle shipped with `--external zod`, leaving bare `from "zod"` imports
    // in sentinal.mjs. Bun only auto-installs such imports when the loading
    // directory has NO node_modules/lockfile; machines with deps in
    // ~/.config/opencode/ (e.g. other plugins) get `Cannot find package 'zod'`
    // at import time, which kills OpenCode with "Unexpected server error"
    // BEFORE any logging. The shipped plugin must never bare-import anything
    // except node: builtins. (bun:sqlite / sqlite-vec / @xenova/transformers
    // stay external in build flags but must not be reachable from the
    // plugin's import graph either.)
    const FORBIDDEN_SPECIFIERS = [
      "zod",
      "bun:sqlite",
      "sqlite-vec",
      "@xenova/transformers",
    ];

    it("EMBEDDED_OPENCODE_PLUGIN contains no bare imports of zod or native externals", async () => {
      const { EMBEDDED_OPENCODE_PLUGIN } = await import("./embedded-assets.js");
      const offenders: string[] = [];
      for (const spec of FORBIDDEN_SPECIFIERS) {
        const escaped = spec.replace(/[/@:]/g, (c) => `\\${c}`);
        const patterns = [
          new RegExp(`from\\s*["']${escaped}["']`),
          new RegExp(`require\\(\\s*["']${escaped}["']\\s*\\)`),
          new RegExp(`import\\(\\s*["']${escaped}["']\\s*\\)`),
        ];
        for (const re of patterns) {
          const m = EMBEDDED_OPENCODE_PLUGIN.match(re);
          if (m) offenders.push(`${spec} (${m[0]})`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(
          `Embedded OpenCode plugin bundle has bare external imports that ` +
            `crash OpenCode at plugin load on machines where the import ` +
            `cannot resolve from ~/.config/opencode/ (no Bun auto-install ` +
            `when node_modules/lockfile present):\n  ${offenders.join("\n  ")}\n` +
            `Fix: ensure these are bundled (remove from --external in ` +
            `package.json build:opencode) or unreachable from the plugin graph, ` +
            `then run 'bun run embed-assets'.`,
        );
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("targets/opencode/skills/ — every SKILL.md must have valid OpenCode skill frontmatter", () => {
    // Root cause guard for the 2026-07-18 master-workflow failure: OpenCode's
    // skill schema (@opencode-ai/sdk v2 AppSkillsResponses = { name, description,
    // location, content }) REQUIRES `name`, and `name` must match the skill's
    // folder name. Skills failing validation are filtered out and never shown to
    // the model, so `Skill(skill='spec-master-plan')` silently fails to resolve.
    // The spec-master-plan / spec-master-execute skills shipped with only
    // `description:` + `argument-hint:` (the latter copied from a Claude Code
    // COMMAND template — argument-hint is not a valid skill field; OpenCode's
    // SkillTool.Parameters is Schema.Struct({ name }), so skills take no args).
    const SKILLS_DIR = join(OPENCODE_DIR, "skills");

    function parseFrontmatter(content: string): Record<string, string> {
      const m = content.match(/^---\n([\s\S]*?)\n---/);
      if (!m) return {};
      const fields: Record<string, string> = {};
      for (const line of m[1].split("\n")) {
        const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (kv) fields[kv[1]] = kv[2].trim();
      }
      return fields;
    }

    const skillFolders = readdirSync(SKILLS_DIR).filter((entry) =>
      statSync(join(SKILLS_DIR, entry)).isDirectory(),
    );

    for (const folder of skillFolders) {
      const skillPath = join(SKILLS_DIR, folder, "SKILL.md");
      const content = readFileSync(skillPath, "utf-8");
      const fm = parseFrontmatter(content);

      it(`${folder}/SKILL.md declares a non-empty name matching its folder`, () => {
        expect(fm.name, `${folder}/SKILL.md is missing 'name:' frontmatter`).toBe(
          folder,
        );
      });

      it(`${folder}/SKILL.md declares a non-empty description`, () => {
        expect(
          (fm.description ?? "").length,
          `${folder}/SKILL.md has empty 'description:'`,
        ).toBeGreaterThan(0);
      });

      it(`${folder}/SKILL.md does NOT declare 'argument-hint' (invalid on skills)`, () => {
        expect(
          fm["argument-hint"],
          `${folder}/SKILL.md declares 'argument-hint' — invalid on OpenCode ` +
            `skills (valid only on commands). OpenCode skills take no arguments.`,
        ).toBeUndefined();
      });
    }

    it("targets/opencode/commands/spec.md STILL declares argument-hint (valid on commands — preservation)", () => {
      const specCmd = readFileSync(
        join(OPENCODE_DIR, "commands", "spec.md"),
        "utf-8",
      );
      expect(parseFrontmatter(specCmd)["argument-hint"]).toBeDefined();
    });

    it("embedded EMBEDDED_OC_SKILLS copy is in sync — master skills carry name (actual user delivery path)", async () => {
      // `sentinal install` ships skills from EMBEDDED_OC_SKILLS in
      // embedded-assets.ts, NOT the live targets/ tree. If embed-assets wasn't
      // re-run after fixing targets/, the installed copy stays broken.
      const { EMBEDDED_OC_SKILLS } = await import("./embedded-assets.js");
      for (const folder of ["spec-master-plan", "spec-master-execute"]) {
        const key = `${folder}/SKILL.md`;
        const embedded = (EMBEDDED_OC_SKILLS as Record<string, string>)[key];
        expect(embedded, `embedded skill missing: ${key}`).toBeDefined();
        expect(
          parseFrontmatter(embedded)["name"],
          `embedded ${key} missing 'name:' — run 'bun run embed-assets' after ` +
            `editing targets/`,
        ).toBe(folder);
      }
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
