/**
 * Shared Memory Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSharedMemory,
  writeSharedMemory,
  addSharedObservation,
  sharedMemoryPath,
  toObservation,
  ensureSentinalGitignore,
  type SharedObservation,
} from "./shared.js";

function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `sentinal-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSharedObs(
  overrides: Partial<SharedObservation> = {},
): SharedObservation {
  return {
    type: "decision",
    title: "Test shared observation",
    content: "Some shared content",
    tags: ["test"],
    filePaths: [],
    createdAt: "2026-03-15",
    ...overrides,
  };
}

describe("sharedMemoryPath", () => {
  it("should return path inside .sentinal directory", () => {
    const path = sharedMemoryPath("/my/project");
    expect(path).toBe("/my/project/.sentinal/project-memory.json");
  });
});

describe("readSharedMemory", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpProject();
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should return empty array when file does not exist", () => {
    const result = readSharedMemory(projectDir);
    expect(result).toEqual([]);
  });

  it("should return empty array on invalid JSON", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(sharedMemoryPath(projectDir), "not valid json{{{");
    const result = readSharedMemory(projectDir);
    expect(result).toEqual([]);
  });

  it("should parse valid shared memory file", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(
      sharedMemoryPath(projectDir),
      JSON.stringify(
        {
          version: 1,
          observations: [
            makeSharedObs({ title: "First" }),
            makeSharedObs({ title: "Second", type: "pattern" }),
          ],
        },
        null,
        2,
      ),
    );

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("First");
    expect(result[1].type).toBe("pattern");
  });

  it("should return empty array when observations field is missing", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(sharedMemoryPath(projectDir), JSON.stringify({ version: 1 }));
    const result = readSharedMemory(projectDir);
    expect(result).toEqual([]);
  });
});

describe("writeSharedMemory", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpProject();
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should create .sentinal directory and write formatted JSON", () => {
    const obs = [makeSharedObs({ title: "Written" })];
    writeSharedMemory(projectDir, obs);

    const raw = readFileSync(sharedMemoryPath(projectDir), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0].title).toBe("Written");
    // Should be formatted (2-space indent)
    expect(raw).toContain("  ");
  });

  it("should overwrite existing file", () => {
    writeSharedMemory(projectDir, [makeSharedObs({ title: "First" })]);
    writeSharedMemory(projectDir, [makeSharedObs({ title: "Second" })]);

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Second");
  });
});

describe("addSharedObservation", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpProject();
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should add observation to empty file", () => {
    addSharedObservation(projectDir, makeSharedObs({ title: "New obs" }));

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("New obs");
  });

  it("should append to existing observations", () => {
    addSharedObservation(projectDir, makeSharedObs({ title: "First" }));
    addSharedObservation(projectDir, makeSharedObs({ title: "Second" }));

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(2);
  });

  it("should deduplicate by title", () => {
    addSharedObservation(projectDir, makeSharedObs({ title: "Same title" }));
    addSharedObservation(
      projectDir,
      makeSharedObs({ title: "Same title", content: "Updated" }),
    );

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Updated");
  });
});

describe(".sentinal/.gitignore", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpProject();
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  const gitignoreOf = (dir: string) => join(dir, ".sentinal", ".gitignore");

  // The exact v1 content Sentinal used to generate (byte-for-byte incl. the
  // trailing newline). Existing files matching this are safe to upgrade.
  const V1_CONTENT =
    "# Ignore everything in .sentinal/ except shared project memory\n" +
    "*\n" +
    "!.gitignore\n" +
    "!project-memory.json\n";

  // v2: the skills/rules allowlist (2026-07-19). Superseded by v3, which adds
  // `!runtime.json`. Existing installs sitting on v2 must UPGRADE, not be
  // classified user-customised — otherwise the runtime contract never reaches
  // teammates or CI and the whole tier silently never activates.
  const V2_CONTENT =
    "# Ignore everything in .sentinal/ except shared project memory, rules, and skills\n" +
    "*\n" +
    "!.gitignore\n" +
    "!project-memory.json\n" +
    "!rules\n" +
    "!rules/\n" +
    "!rules/**\n" +
    "!skills\n" +
    "!skills/\n" +
    "!skills/**\n";

  it("should create .gitignore when writing shared memory", () => {
    writeSharedMemory(projectDir, [makeSharedObs()]);

    const content = readFileSync(gitignoreOf(projectDir), "utf-8");
    expect(existsSync(gitignoreOf(projectDir))).toBe(true);
    expect(content).toContain("!project-memory.json");
    expect(content).toContain("!skills/");
    expect(content).toContain("!skills/**");
    expect(content).toContain("!rules/");
    expect(content).toContain("!rules/**");
  });

  // BEHAVIORAL proof (string assertions can't catch the nested-un-ignore
  // gotcha): init a real git repo, generate the file, and use `git check-ignore`
  // to confirm what is actually tracked vs ignored. `git check-ignore <path>`
  // exits 0 when the path IS ignored, non-zero when it is NOT (i.e. tracked).
  it("tracks skills/rules (.md + .sh) and project-memory.json; ignores other files", () => {
    const { execFileSync } = require("node:child_process");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null", // insulate from global git config
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    execFileSync("git", ["init", "-q"], { cwd: projectDir, env });

    writeSharedMemory(projectDir, [makeSharedObs()]);
    const s = join(projectDir, ".sentinal");
    mkdirSync(join(s, "skills", "my-skill"), { recursive: true });
    mkdirSync(join(s, "rules"), { recursive: true });
    writeFileSync(join(s, "skills", "my-skill", "SKILL.md"), "# skill\n");
    writeFileSync(join(s, "skills", "my-skill", "run.sh"), "echo hi\n");
    writeFileSync(join(s, "rules", "standards.md"), "# rule\n");
    writeFileSync(join(s, "scratch.log"), "noise\n");

    // git check-ignore: exit 0 = ignored, non-zero = tracked.
    const isIgnored = (rel: string): boolean => {
      try {
        execFileSync("git", ["check-ignore", "-q", rel], {
          cwd: projectDir,
          env,
        });
        return true; // exit 0
      } catch {
        return false; // non-zero
      }
    };

    // Tracked (NOT ignored):
    expect(isIgnored(".sentinal/project-memory.json")).toBe(false);
    expect(isIgnored(".sentinal/skills/my-skill/SKILL.md")).toBe(false);
    expect(isIgnored(".sentinal/skills/my-skill/run.sh")).toBe(false);
    expect(isIgnored(".sentinal/rules/standards.md")).toBe(false);
    // Ignored:
    expect(isIgnored(".sentinal/scratch.log")).toBe(true);
  });

  it("upgrades an existing .gitignore that matches a known prior version", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(gitignoreOf(projectDir), V1_CONTENT);

    writeSharedMemory(projectDir, [makeSharedObs()]);

    const content = readFileSync(gitignoreOf(projectDir), "utf-8");
    expect(content).not.toBe(V1_CONTENT); // was upgraded
    expect(content).toContain("!skills/**");
    expect(content).toContain("!rules/**");
  });

  // ── Phase 3 / R9: the project-authored runtime contract must be committable ──

  it("upgrades a v2 .gitignore so .sentinal/runtime.json becomes trackable", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(gitignoreOf(projectDir), V2_CONTENT);

    writeSharedMemory(projectDir, [makeSharedObs()]);

    const content = readFileSync(gitignoreOf(projectDir), "utf-8");
    expect(content).not.toBe(V2_CONTENT); // was upgraded, not treated as custom
    expect(content).toContain("!runtime.json");
    // The v2 allowlist must survive the upgrade.
    expect(content).toContain("!project-memory.json");
    expect(content).toContain("!skills/**");
    expect(content).toContain("!rules/**");
  });

  // BEHAVIOURAL proof, not a string assertion: `!runtime.json` after a `*`
  // deny-all only works because .sentinal/ is not itself excluded by a parent
  // .gitignore. Only `git check-ignore` can prove the negation actually took.
  it("tracks .sentinal/runtime.json (not ignored) in a real git repo", () => {
    const { execFileSync } = require("node:child_process");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    execFileSync("git", ["init", "-q"], { cwd: projectDir, env });

    writeSharedMemory(projectDir, [makeSharedObs()]);
    writeFileSync(join(projectDir, ".sentinal", "runtime.json"), "{}\n");

    const isIgnored = (rel: string): boolean => {
      try {
        execFileSync("git", ["check-ignore", "-q", rel], {
          cwd: projectDir,
          env,
        });
        return true;
      } catch {
        return false;
      }
    };

    expect(isIgnored(".sentinal/runtime.json")).toBe(false);
    // Guard against a too-broad negation: neighbours stay ignored.
    expect(isIgnored(".sentinal/runtime.log")).toBe(true);
    expect(isIgnored(".sentinal/runtime.json.bak")).toBe(true);
  });

  it("preserves a user-customized .gitignore (no known-prior match)", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(gitignoreOf(projectDir), "custom content\n");

    writeSharedMemory(projectDir, [makeSharedObs()]);

    expect(readFileSync(gitignoreOf(projectDir), "utf-8")).toBe(
      "custom content\n",
    );
  });

  /**
   * R9a — the upgrade path must not depend on shared memory being used.
   *
   * `ensureGitignore` used to have exactly ONE call site: `writeSharedMemory`.
   * So the KNOWN_PRIOR_GITIGNORES upgrade (which is what makes
   * `.sentinal/runtime.json` committable) only ever reached projects that
   * later promoted an observation to shared memory. A project that never did
   * kept `runtime.json` ignored and the whole runtime-contract tier silently
   * never activated for it.
   *
   * `ensureSentinalGitignore()` is the install/update entry point. It must
   * preserve `ensureGitignore`'s guard EXACTLY — rewrite only on an exact
   * match against the current content or a known prior version, never touch
   * anything else.
   */
  describe("ensureSentinalGitignore (install/update entry point)", () => {
    const initGit = (dir: string) => {
      const { execFileSync } = require("node:child_process");
      execFileSync("git", ["init", "-q"], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
    };

    it("upgrades a v2 .gitignore WITHOUT any shared-memory write", () => {
      initGit(projectDir);
      mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
      writeFileSync(gitignoreOf(projectDir), V2_CONTENT);

      expect(ensureSentinalGitignore(projectDir)).toBe(true);

      const content = readFileSync(gitignoreOf(projectDir), "utf-8");
      expect(content).toContain("!runtime.json");
      expect(content).toContain("!project-memory.json");
      expect(content).toContain("!skills/**");
    });

    it("upgrades a v1 .gitignore WITHOUT any shared-memory write", () => {
      initGit(projectDir);
      mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
      writeFileSync(gitignoreOf(projectDir), V1_CONTENT);

      expect(ensureSentinalGitignore(projectDir)).toBe(true);
      expect(readFileSync(gitignoreOf(projectDir), "utf-8")).toContain(
        "!runtime.json",
      );
    });

    it("creates the file when .sentinal/ exists but carries no .gitignore", () => {
      initGit(projectDir);
      mkdirSync(join(projectDir, ".sentinal"), { recursive: true });

      expect(ensureSentinalGitignore(projectDir)).toBe(true);
      expect(existsSync(gitignoreOf(projectDir))).toBe(true);
    });

    // ⛔ The whole point of the guard. A user who edited the file owns it.
    it("leaves a user-customized .gitignore byte-for-byte untouched", () => {
      initGit(projectDir);
      mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
      const custom =
        "*\n!.gitignore\n!project-memory.json\n!continue-here.md\n";
      writeFileSync(gitignoreOf(projectDir), custom);

      expect(ensureSentinalGitignore(projectDir)).toBe(false);
      expect(readFileSync(gitignoreOf(projectDir), "utf-8")).toBe(custom);
    });

    it("is a no-op when the file is already current (no needless rewrite)", () => {
      initGit(projectDir);
      mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
      writeSharedMemory(projectDir, [makeSharedObs()]);
      const current = readFileSync(gitignoreOf(projectDir), "utf-8");

      expect(ensureSentinalGitignore(projectDir)).toBe(false);
      expect(readFileSync(gitignoreOf(projectDir), "utf-8")).toBe(current);
    });

    // `sentinal install` is frequently run from $HOME, where ~/.sentinal/ is
    // the RUNTIME dir (sidecar.sock, bin/). Writing a .gitignore there is
    // noise, and a .gitignore outside a git working tree does nothing anyway.
    it("does nothing when .sentinal/ exists but the path is not a git work tree", () => {
      mkdirSync(join(projectDir, ".sentinal"), { recursive: true });

      expect(ensureSentinalGitignore(projectDir)).toBe(false);
      expect(existsSync(gitignoreOf(projectDir))).toBe(false);
    });

    // Never CREATE .sentinal/ — that is the installer's job, not this helper's.
    it("does nothing when .sentinal/ does not exist", () => {
      initGit(projectDir);

      expect(ensureSentinalGitignore(projectDir)).toBe(false);
      expect(existsSync(join(projectDir, ".sentinal"))).toBe(false);
    });

    it("never throws on an unwritable / bogus path", () => {
      expect(() =>
        ensureSentinalGitignore("/nonexistent/definitely/not/here"),
      ).not.toThrow();
    });
  });
});

/**
 * R9 regression, against THIS repository's own checked-in `.sentinal/.gitignore`.
 *
 * The generator test above proves the emitted content is correct. It does NOT
 * prove this repo benefits: this repo's file carries a deliberate local
 * `!continue-here.md` customisation (recorded in
 * `docs/plans/2026-07-19-sentinal-gitignore-track-skills-rules.md:28`), so it
 * matches neither GITIGNORE_CONTENT nor any KNOWN_PRIOR_GITIGNORES entry and
 * `ensureGitignore` will never auto-upgrade it. It is hand-maintained, and this
 * test is what stops the hand-maintenance silently rotting.
 */
describe("this repo's own .sentinal/.gitignore (R9)", () => {
  const repoRoot = join(import.meta.dir, "..", "..");

  const isIgnoredHere = (rel: string): boolean => {
    const { execFileSync } = require("node:child_process");
    // Same insulation as the temp-repo helper above: a developer whose global
    // `core.excludesFile` ignores `.sentinal/` or `*.json` would otherwise get
    // a different answer than CI. (A global rule can only ADD ignores, so this
    // could never have caused a false pass — only local flakiness.)
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    try {
      execFileSync("git", ["check-ignore", "-q", rel], { cwd: repoRoot, env });
      return true;
    } catch {
      return false;
    }
  };

  it("does not ignore .sentinal/runtime.json", () => {
    expect(isIgnoredHere(".sentinal/runtime.json")).toBe(false);
  });

  it("still ignores unrelated .sentinal/ scratch files", () => {
    expect(isIgnoredHere(".sentinal/scratch.log")).toBe(true);
  });
});

describe("toObservation", () => {
  it("should convert SharedObservation to full Observation", () => {
    const shared = makeSharedObs({
      title: "Converted",
      type: "pattern",
      createdAt: "2026-03-15",
    });

    const obs = toObservation(shared, "/test/project", 0);

    expect(obs.id).toBe(-1);
    expect(obs.sessionId).toBe("shared");
    expect(obs.projectPath).toBe("/test/project");
    expect(obs.type).toBe("pattern");
    expect(obs.title).toBe("Converted");
    expect(obs.timestamp).toBeGreaterThan(0);
    expect(obs.metadata).toEqual({ source: "shared" });
    expect(obs.qualityScore).toBe(1.0);
  });

  it("should generate sequential negative IDs", () => {
    const shared = makeSharedObs();
    const obs0 = toObservation(shared, "/test", 0);
    const obs1 = toObservation(shared, "/test", 1);
    const obs2 = toObservation(shared, "/test", 2);

    expect(obs0.id).toBe(-1);
    expect(obs1.id).toBe(-2);
    expect(obs2.id).toBe(-3);
  });
});
