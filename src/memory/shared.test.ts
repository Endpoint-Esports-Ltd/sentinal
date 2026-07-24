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

  it("preserves a user-customized .gitignore (no known-prior match)", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(gitignoreOf(projectDir), "custom content\n");

    writeSharedMemory(projectDir, [makeSharedObs()]);

    expect(readFileSync(gitignoreOf(projectDir), "utf-8")).toBe(
      "custom content\n",
    );
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
