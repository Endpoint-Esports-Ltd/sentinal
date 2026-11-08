import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearInjectedRules,
  foreignRulesHint,
  injectedRulesMarkerPath,
} from "./foreign-context.js";

let root: string;
let a: string; // session repo
let b: string; // foreign repo with rules
let home: string; // Sentinal home (stands in for ~/.sentinal)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-fc-")));
  a = join(root, "a");
  b = join(root, "b");
  home = join(root, "home", ".sentinal");
  mkdirSync(join(a, ".git"), { recursive: true });
  mkdirSync(join(b, ".git"), { recursive: true });
  mkdirSync(join(b, ".sentinal", "rules"), { recursive: true });
  mkdirSync(join(b, "src"), { recursive: true });
  writeFileSync(
    join(b, ".sentinal", "rules", "b-rules.md"),
    "# B rules\nUse tabs in B.\n",
  );
  writeFileSync(
    join(b, ".sentinal", "rules", "ng.md"),
    '---\npaths:\n  - "**/*.component.ts"\n---\n# Angular in B\nSignals only.\n',
  );
  writeFileSync(join(b, "src", "x.ts"), "export {};\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deps = () => ({ home, identity: (p: string) => p });

describe("foreignRulesHint", () => {
  it("should inject a foreign project's rules on the first edit only", () => {
    const first = foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(first).toContain("[Sentinal] Rules for b");
    expect(first).toContain("Use tabs in B.");
    // `paths:` filter — x.ts is not a component.
    expect(first).not.toContain("Signals only.");

    const second = foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(second).toBeNull();

    // Another session injects again.
    const other = foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s2" },
      deps(),
    );
    expect(other).toContain("Use tabs in B.");
  });

  it("should match paths globs relative to the foreign workspace", () => {
    const out = foreignRulesHint(
      { filePath: join(b, "src", "y.component.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(out).toContain("Signals only.");
  });

  it("should resolve a relative file path against the session cwd", () => {
    const out = foreignRulesHint(
      { filePath: "../b/src/x.ts", cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(out).toContain("Use tabs in B.");
  });

  it("should skip files in the session's own project and projects without rules", () => {
    writeFileSync(join(a, "own.ts"), "");
    expect(
      foreignRulesHint(
        { filePath: join(a, "own.ts"), cwd: a, sessionId: "s1" },
        deps(),
      ),
    ).toBeNull();
    const c = join(root, "c");
    mkdirSync(join(c, ".git"), { recursive: true });
    writeFileSync(join(c, "f.ts"), "");
    expect(
      foreignRulesHint(
        { filePath: join(c, "f.ts"), cwd: a, sessionId: "s1" },
        deps(),
      ),
    ).toBeNull();
    expect(existsSync(join(a, ".sentinal", "injected-rules.json"))).toBe(false);
  });

  it("should write the marker in the session repo's .sentinal", () => {
    foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    const marker = JSON.parse(
      readFileSync(join(a, ".sentinal", "injected-rules.json"), "utf-8"),
    );
    expect(marker).toEqual({
      s1: [join(b, ".sentinal", "rules", "b-rules.md")],
    });
  });

  it("should inject a path-scoped rule on a later matching edit, without repeating the rest", () => {
    const first = foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(first).toContain("Use tabs in B.");
    const comp = foreignRulesHint(
      { filePath: join(b, "src", "y.component.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(comp).toContain("Signals only.");
    expect(comp).not.toContain("Use tabs in B.");
    expect(
      foreignRulesHint(
        { filePath: join(b, "src", "z.component.ts"), cwd: a, sessionId: "s1" },
        deps(),
      ),
    ).toBeNull();
  });

  it("should treat a corrupt marker as empty and overwrite it", () => {
    mkdirSync(join(a, ".sentinal"), { recursive: true });
    writeFileSync(join(a, ".sentinal", "injected-rules.json"), "{corrupt");
    const out = foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    expect(out).toContain("Use tabs in B.");
    expect(
      JSON.parse(
        readFileSync(join(a, ".sentinal", "injected-rules.json"), "utf-8"),
      ),
    ).toEqual({ s1: [join(b, ".sentinal", "rules", "b-rules.md")] });
  });

  it("should keep the marker under <home>/injected-rules/ for a non-repo session cwd", () => {
    const nonRepo = join(root, "home");
    mkdirSync(nonRepo, { recursive: true });
    const out = foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: nonRepo, sessionId: "s9" },
      deps(),
    );
    expect(out).toContain("Use tabs in B.");
    expect(existsSync(join(home, "injected-rules", "s9.json"))).toBe(true);
    expect(existsSync(join(home, "injected-rules.json"))).toBe(false);
    expect(existsSync(join(nonRepo, ".sentinal", "injected-rules.json"))).toBe(
      false,
    );
    expect(injectedRulesMarkerPath(nonRepo, "s9", home)).toBe(
      join(home, "injected-rules", "s9.json"),
    );
  });

  it("should never throw on bogus input", () => {
    expect(() =>
      foreignRulesHint({ filePath: "", cwd: "", sessionId: "" }, deps()),
    ).not.toThrow();
  });
});

describe("clearInjectedRules", () => {
  it("should clear only this session's entry, so the next edit injects again", () => {
    const edit = (s: string) =>
      foreignRulesHint(
        { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: s },
        deps(),
      );
    edit("s1");
    edit("s2");
    clearInjectedRules({ cwd: a, sessionId: "s1" }, deps());
    const marker = JSON.parse(
      readFileSync(join(a, ".sentinal", "injected-rules.json"), "utf-8"),
    );
    expect(marker).toEqual({
      s2: [join(b, ".sentinal", "rules", "b-rules.md")],
    });
    expect(edit("s1")).toContain("Use tabs in B.");
    expect(edit("s2")).toBeNull();
  });

  it("should delete the marker file when it becomes empty", () => {
    foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: a, sessionId: "s1" },
      deps(),
    );
    clearInjectedRules({ cwd: a, sessionId: "s1" }, deps());
    expect(existsSync(join(a, ".sentinal", "injected-rules.json"))).toBe(false);
  });

  it("should delete a non-repo session's marker file", () => {
    const nonRepo = join(root, "home");
    mkdirSync(nonRepo, { recursive: true });
    foreignRulesHint(
      { filePath: join(b, "src", "x.ts"), cwd: nonRepo, sessionId: "s9" },
      deps(),
    );
    clearInjectedRules({ cwd: nonRepo, sessionId: "s9" }, deps());
    expect(existsSync(join(home, "injected-rules", "s9.json"))).toBe(false);
  });

  it("should never throw without a marker or input", () => {
    expect(() =>
      clearInjectedRules({ cwd: a, sessionId: "nope" }, deps()),
    ).not.toThrow();
    expect(() =>
      clearInjectedRules({ cwd: "", sessionId: "" }, deps()),
    ).not.toThrow();
  });
});
