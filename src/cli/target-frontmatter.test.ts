/**
 * Shipped-asset frontmatter guard.
 *
 * ⛔ Why this exists. `targets/claude-code/commands/spec.md` shipped with:
 *
 *     argument-hint: "<task description>" or "<path/to/plan.md>"
 *
 * which is not valid YAML — a quoted scalar followed by trailing content. It
 * reached users in both targets and was caught only by a manual
 * `claude plugin validate --strict`. None of the ~2390 tests noticed, because:
 *
 *   1. `package.json`'s `validate:plugin` ends in `|| true`, so it cannot fail.
 *   2. It is not in CI, and `claude` does not exist on every runner.
 *   3. The one frontmatter test that did exist (`target-assets.test.ts`) uses a
 *      naive `^key:\s*(.*)$` line scanner, which happily "parses" the broken
 *      line into a string and reports success.
 *
 * This guard is deliberately **`claude`-free**: it uses `Bun.YAML.parse`, the
 * same strict YAML the loaders use, so it runs anywhere `bun test` runs. Do not
 * try to make `validate:plugin` fail the build instead — the binary is not
 * available on every runner.
 *
 * Scope: every shipped command in BOTH targets, every OpenCode skill, and the
 * EMBEDDED copies of both (the embedded assets are what `sentinal install`
 * actually writes to disk — fixing `targets/` without re-running
 * `bun run embed-assets` leaves users on the broken copy).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const TARGETS = join(REPO_ROOT, "targets");

type Frontmatter = Record<string, unknown>;

interface ParseResult {
  ok: boolean;
  /** Populated when ok === false. */
  error?: string;
  data?: Frontmatter;
}

/**
 * Extract and STRICTLY parse the leading `---` fenced YAML block.
 *
 * Failure modes it reports, each of which has actually shipped or is one typo
 * away from shipping:
 *   - no frontmatter block at all
 *   - frontmatter that is not valid YAML  ← the spec.md regression
 *   - frontmatter that parses to something other than a key/value mapping
 */
function parseFrontmatter(content: string): ParseResult {
  // The opening fence must be the very first thing in the file. A leading blank
  // line or BOM means neither loader sees frontmatter at all.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) {
    return { ok: false, error: "no `---` frontmatter block at the start" };
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1]);
  } catch (e) {
    return { ok: false, error: `invalid YAML: ${(e as Error).message}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `frontmatter is ${Array.isArray(parsed) ? "a list" : typeof parsed}, expected a key/value mapping`,
    };
  }

  return { ok: true, data: parsed as Frontmatter };
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function markdownFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

// ─── The guard proves itself before it guards anything ──────────────────────

describe("frontmatter validator (self-test)", () => {
  it("REJECTS the exact line that shipped broken in spec.md", () => {
    const shipped =
      '---\ndescription: Spec-driven development\nargument-hint: "<task description>" or "<path/to/plan.md>"\n---\n\n# body\n';
    const result = parseFrontmatter(shipped);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid YAML");
  });

  it("rejects a file with no frontmatter block", () => {
    expect(parseFrontmatter("# just a heading\n").ok).toBe(false);
  });

  it("rejects frontmatter that is not a mapping", () => {
    expect(parseFrontmatter("---\n- a\n- b\n---\n").ok).toBe(false);
  });

  it("accepts the corrected form", () => {
    const fixed =
      '---\ndescription: Spec-driven development\nargument-hint: "<task description> or <path/to/plan.md>"\n---\n\n# body\n';
    const result = parseFrontmatter(fixed);
    expect(result.ok).toBe(true);
    expect(result.data?.["argument-hint"]).toBe(
      "<task description> or <path/to/plan.md>",
    );
  });
});

// ─── targets/*/commands/*.md ────────────────────────────────────────────────

describe("shipped command frontmatter", () => {
  const commandDirs = [
    ["claude-code", join(TARGETS, "claude-code", "commands")],
    ["opencode", join(TARGETS, "opencode", "commands")],
  ] as const;

  for (const [target, dir] of commandDirs) {
    const files = markdownFilesIn(dir);

    it(`${target}: has commands to validate (guard against an empty glob passing vacuously)`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      const rel = `targets/${target}/commands/${file}`;

      it(`${rel} — frontmatter is valid YAML`, () => {
        const result = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
        expect(
          result.ok ? null : `${rel}: ${result.error}`,
          `${rel} has malformed frontmatter. Both loaders parse this block as ` +
            `strict YAML; a bad value silently drops the command (Claude Code) ` +
            `or fails 'claude plugin validate --strict'. Quote the WHOLE value: ` +
            `argument-hint: "<a> or <b>", not "<a>" or "<b>".`,
        ).toBeNull();
      });

      it(`${rel} — declares a non-empty description`, () => {
        const { data } = parseFrontmatter(
          readFileSync(join(dir, file), "utf-8"),
        );
        expect(
          nonEmptyString(data?.description),
          `${rel} is missing a non-empty 'description:'. Both Claude Code and ` +
            `OpenCode surface commands by their description; without one the ` +
            `command is unusable even though it loads.`,
        ).toBe(true);
      });

      it(`${rel} — every declared key has a scalar value`, () => {
        const { data } = parseFrontmatter(
          readFileSync(join(dir, file), "utf-8"),
        );
        const bad = Object.entries(data ?? {})
          .filter(([, v]) => v !== null && typeof v === "object")
          .map(([k]) => k);
        expect(
          bad,
          `${rel} declares non-scalar frontmatter value(s): ${bad.join(", ")}. ` +
            `Command frontmatter fields (description, argument-hint, model, ` +
            `user-invocable, effort, allowed-tools) are all scalars — an object ` +
            `or list here means the YAML nested in a way that was not intended.`,
        ).toEqual([]);
      });
    }
  }
});

// ─── targets/opencode/skills/<name>/SKILL.md ────────────────────────────────

describe("shipped OpenCode skill frontmatter", () => {
  const skillsDir = join(TARGETS, "opencode", "skills");
  const folders = readdirSync(skillsDir)
    .filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
    .sort();

  it("has skills to validate (guard against an empty glob passing vacuously)", () => {
    expect(folders.length).toBeGreaterThan(0);
  });

  for (const folder of folders) {
    const rel = `targets/opencode/skills/${folder}/SKILL.md`;
    const path = join(skillsDir, folder, "SKILL.md");

    it(`${rel} — frontmatter is valid YAML`, () => {
      const result = parseFrontmatter(readFileSync(path, "utf-8"));
      expect(result.ok ? null : `${rel}: ${result.error}`).toBeNull();
    });

    it(`${rel} — name matches the folder and description is non-empty`, () => {
      const { data } = parseFrontmatter(readFileSync(path, "utf-8"));
      // OpenCode's skill schema REQUIRES `name`, and `name` must equal the
      // folder name — a skill failing validation is filtered out and never
      // shown to the model, so Skill(skill='<folder>') silently fails.
      expect(data?.name, `${rel} 'name:' must equal '${folder}'`).toBe(folder);
      expect(
        nonEmptyString(data?.description),
        `${rel} is missing a non-empty 'description:'`,
      ).toBe(true);
    });
  }
});

// ─── The copies users actually receive ──────────────────────────────────────

describe("embedded asset frontmatter (the real user delivery path)", () => {
  // `sentinal install` writes these constants, NOT the live targets/ tree. A
  // fix to targets/ that skips `bun run embed-assets` never reaches anyone.
  it("every embedded command and skill carries valid YAML frontmatter", async () => {
    const { EMBEDDED_CC_COMMANDS, EMBEDDED_COMMANDS, EMBEDDED_OC_SKILLS } =
      await import("./embedded-assets.js");

    const groups: Array<[string, Record<string, string>]> = [
      ["EMBEDDED_CC_COMMANDS", EMBEDDED_CC_COMMANDS as Record<string, string>],
      ["EMBEDDED_COMMANDS", EMBEDDED_COMMANDS as Record<string, string>],
      ["EMBEDDED_OC_SKILLS", EMBEDDED_OC_SKILLS as Record<string, string>],
    ];

    const offenders: string[] = [];
    let checked = 0;
    for (const [label, group] of groups) {
      for (const [name, content] of Object.entries(group)) {
        checked++;
        const result = parseFrontmatter(content);
        if (!result.ok) offenders.push(`${label}[${name}]: ${result.error}`);
        else if (!nonEmptyString(result.data?.description))
          offenders.push(`${label}[${name}]: missing/empty description`);
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(
      offenders,
      `Embedded assets have malformed frontmatter:\n  ${offenders.join("\n  ")}\n` +
        `If targets/ is already correct, run 'bun run embed-assets'.`,
    ).toEqual([]);
  });
});
