/**
 * No-Leak Tests — Path Reference Regression Guards
 *
 * Ensures that shipped command files, skills, AGENTS templates, and team-sharing
 * docs never instruct agents to write rules or skills into `.opencode/` or `.claude/`
 * directly. The canonical destination is always `.sentinal/rules/` and `.sentinal/skills/`.
 *
 * Also asserts that `templates/commands/` does not exist (the stale generator has been
 * deleted; target files are the canonical source).
 *
 * FORBIDDEN list is narrow by design — it skips the legitimate legacy-migration shell
 * blocks in sync.md (Phase 0.5) which use `.claude/rules` and `.opencode/rules` as
 * *detection* probes, not as write destinations. Those blocks use bare path strings
 * (`.opencode/rules`) without the `/{` or `/<name>` or `/standards-` suffixes that
 * appear in write-destination instructions.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

// Substrings that must NOT appear in any scanned file.
// Each entry represents a write-destination pattern for rules or skills.
const FORBIDDEN = [
  // Templates / commands telling agent WHERE to create new skills
  ".opencode/skills/{",
  ".opencode/skills/<name>",
  // Shipped standards path in AGENTS templates
  ".opencode/rules/standards-",
  // Template-style write destinations
  ".opencode/rules/{",
  ".claude/skills/{",
  ".claude/skills/<name>",
  ".claude/rules/{",
  ".claude/rules/<name>",
];

/** Recursively collect .md files from a directory. */
function collectMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMd(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function checkFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  return FORBIDDEN.filter((forbidden) => content.includes(forbidden)).map(
    (match) => `  Found "${match}" in ${filePath.replace(ROOT + "/", "")}`,
  );
}

// ─── Generator deleted ───────────────────────────────────────────────────────

describe("generator cleanup", () => {
  it("templates/commands/ directory does not exist (generator deleted)", () => {
    const templatesDir = join(ROOT, "templates", "commands");
    expect(existsSync(templatesDir)).toBe(false);
  });

  it("scripts/generate-commands.js does not exist", () => {
    const generatorScript = join(ROOT, "scripts", "generate-commands.js");
    expect(existsSync(generatorScript)).toBe(false);
  });
});

// ─── Command files ────────────────────────────────────────────────────────────

describe("targets/claude-code/commands — no forbidden path leaks", () => {
  const dir = join(ROOT, "targets", "claude-code", "commands");
  const files = collectMd(dir);

  it("has at least one command file to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(ROOT + "/", "")}`, () => {
      const violations = checkFile(file);
      expect(violations).toEqual([]);
    });
  }
});

describe("targets/opencode/commands — no forbidden path leaks", () => {
  const dir = join(ROOT, "targets", "opencode", "commands");
  const files = collectMd(dir);

  it("has at least one command file to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(ROOT + "/", "")}`, () => {
      const violations = checkFile(file);
      expect(violations).toEqual([]);
    });
  }
});

// ─── OpenCode skill files ─────────────────────────────────────────────────────

describe("targets/opencode/skills — no forbidden path leaks", () => {
  const dir = join(ROOT, "targets", "opencode", "skills");
  const files = collectMd(dir);

  it("has at least one skill file to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(ROOT + "/", "")}`, () => {
      const violations = checkFile(file);
      expect(violations).toEqual([]);
    });
  }
});

// ─── AGENTS.md templates ──────────────────────────────────────────────────────

describe("targets/opencode/AGENTS.md — no forbidden path leaks", () => {
  const filePath = join(ROOT, "targets", "opencode", "AGENTS.md");

  it("file exists", () => {
    expect(existsSync(filePath)).toBe(true);
  });

  it("contains no forbidden path references", () => {
    if (!existsSync(filePath)) return;
    expect(checkFile(filePath)).toEqual([]);
  });
});

// ─── Shipped rules: team-sharing ─────────────────────────────────────────────

describe("targets/claude-code/rules/team-sharing.md — no forbidden path leaks", () => {
  const filePath = join(
    ROOT,
    "targets",
    "claude-code",
    "rules",
    "team-sharing.md",
  );

  it("file exists", () => {
    expect(existsSync(filePath)).toBe(true);
  });

  it("contains no forbidden path references", () => {
    if (!existsSync(filePath)) return;
    expect(checkFile(filePath)).toEqual([]);
  });
});

describe("targets/opencode/rules/team-sharing.md — no forbidden path leaks", () => {
  const filePath = join(
    ROOT,
    "targets",
    "opencode",
    "rules",
    "team-sharing.md",
  );

  it("file exists", () => {
    expect(existsSync(filePath)).toBe(true);
  });

  it("contains no forbidden path references", () => {
    if (!existsSync(filePath)) return;
    expect(checkFile(filePath)).toEqual([]);
  });
});
