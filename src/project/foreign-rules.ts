/**
 * Foreign rules — read, filter and format another project's `.sentinal/rules`
 * for injection when a session first edits a file in that project
 * (docs/plans/2026-11-05-cross-project-scope-phase-2.md, Task 1).
 *
 * Only the `paths:` frontmatter key is parsed. A rule with `paths` applies
 * only to files matching one of its globs (relative to the project's
 * workspace) — consistent with Claude Code's own rule loading; OpenCode
 * ignores `paths:` natively, applying it here is deliberate.
 *
 * Never throws. ⛔ Free of `bun:sqlite` — bundled into the OpenCode plugin.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Per-project cap on injected rule text. */
export const FOREIGN_RULES_MAX_CHARS = 12_000;
/** OpenCode: total cap across every foreign project in one system prompt. */
export const FOREIGN_RULES_TOTAL_CHARS = 24_000;
/** A rule file larger than this is truncated on read. */
const MAX_RULE_FILE_CHARS = 200_000;

export interface RuleFile {
  /** Absolute path of the rule file. */
  path: string;
  /** File name (`foo.md`). */
  name: string;
  /** `paths:` globs; absent → the rule always applies. */
  paths?: string[];
  /** Content without the frontmatter. */
  body: string;
}

/** `**` any depth, `*` within a segment, `?` one non-slash char. Anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  )
    return t.slice(1, -1);
  return t;
}

/** Parse one rule file's text: the `paths:` list and the body. */
export function parseRuleFile(path: string, text: string): RuleFile {
  const name = path.split(/[\\/]/).pop() ?? path;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { path, name, body: text };
  const body = text.slice(m[0].length);
  const lines = m[1]!.split(/\r?\n/);
  let paths: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const key = /^paths:\s*(.*)$/.exec(lines[i]!);
    if (!key) continue;
    const inline = key[1]!.trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      paths = inline
        .slice(1, -1)
        .split(",")
        .map(unquote)
        .filter((s) => s !== "");
      break;
    }
    paths = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s+(.+)$/.exec(lines[j]!);
      if (!item) break;
      const g = unquote(item[1]!);
      if (g !== "") paths.push(g);
    }
    break;
  }
  return paths && paths.length > 0
    ? { path, name, paths, body }
    : { path, name, body };
}

/** `*.md` files in `<workspace>/.sentinal/rules`, sorted by name. */
export function readProjectRules(workspace: string): RuleFile[] {
  try {
    if (typeof workspace !== "string" || workspace.trim() === "") return [];
    const dir = join(workspace, ".sentinal", "rules");
    const names = readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    const out: RuleFile[] = [];
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (!statSync(p).isFile()) continue;
        let text = readFileSync(p, "utf-8");
        if (text.length > MAX_RULE_FILE_CHARS)
          text = text.slice(0, MAX_RULE_FILE_CHARS);
        out.push(parseRuleFile(p, text));
      } catch {
        /* unreadable — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Rules that apply to `fileRelPath` (relative to the rule's workspace). */
export function rulesForFile(
  rules: RuleFile[],
  fileRelPath: string,
): RuleFile[] {
  const rel = fileRelPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return rules.filter(
    (r) => !r.paths || r.paths.some((g) => globToRegExp(g).test(rel)),
  );
}

function firstHeading(rule: RuleFile): string {
  const m = /^#{1,6}\s+(.+)$/m.exec(rule.body);
  return m ? m[1]!.trim() : rule.name;
}

export interface FormatForeignRulesInput {
  projectName: string;
  workspace: string;
  rules: RuleFile[];
  /** Cap on the rule bodies; what does not fit becomes a pointer list. */
  maxChars: number;
}

/** A markdown block with the rules that fit and pointers to the rest. "" when no rules. */
export function formatForeignRules(input: FormatForeignRulesInput): string {
  const { projectName, workspace, rules, maxChars } = input;
  if (rules.length === 0) return "";
  const parts = [
    `[Sentinal] Rules for ${projectName} (${workspace}) — you are editing files in this project:`,
  ];
  let used = 0;
  let i = 0;
  for (; i < rules.length; i++) {
    const block = `\n<!-- ${rules[i]!.path} -->\n${rules[i]!.body.trim()}\n`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  const rest = rules.slice(i);
  if (rest.length > 0) {
    parts.push(
      `\nMore rules for ${projectName} — Read these files before editing further:`,
    );
    for (const r of rest) parts.push(`- ${r.path} — ${firstHeading(r)}`);
  }
  return parts.join("\n");
}
