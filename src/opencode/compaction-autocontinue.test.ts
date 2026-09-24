import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidecarClient } from "../sidecar/client.js";
import type { TddCycle } from "../memory/types.js";
import type { Spec } from "../spec/types.js";
import {
  resolveProjectIdentity,
  resolveWorkspaceRoot,
} from "../project/identity.js";
import { isInside } from "../worktree/disk-scan.js";
import { handleCompactionAutocontinue } from "./compaction-autocontinue.js";

/** Every argument each sidecar method was called with, in call order. */
interface MockCalls {
  listActiveTddStates: unknown[][];
  getCurrentSpec: unknown[][];
}

// Minimal mock shape — only the methods we need. It CAPTURES its arguments:
// a mock that discards them (the old `_projectPath`) makes it impossible to
// observe which root reached the sidecar, which is exactly the bug class
// this module had (identity vs workspace conflation).
function makeMockSidecar(opts: {
  tddStates?: TddCycle[];
  currentSpec?: Spec | null;
}): { sidecar: SidecarClient; calls: MockCalls } {
  const calls: MockCalls = { listActiveTddStates: [], getCurrentSpec: [] };
  const sidecar = {
    listActiveTddStates: async (...args: unknown[]) => {
      calls.listActiveTddStates.push(args);
      return opts.tddStates ?? [];
    },
    getCurrentSpec: async (...args: unknown[]) => {
      calls.getCurrentSpec.push(args);
      return opts.currentSpec ?? null;
    },
  } as unknown as SidecarClient;
  return { sidecar, calls };
}

function redCycle(filePath: string): TddCycle {
  return {
    id: 1,
    filePath,
    specId: null,
    taskPosition: null,
    state: "RED_CONFIRMED",
    testFilePath: null,
    lastFailOutput: null,
    updatedAt: Date.now(),
  };
}

/** Same root for both — the non-worktree (main checkout) case. */
const SAME = (p: string) => ({ identity: p, workspace: p });

describe("handleCompactionAutocontinue", () => {
  it("returns shouldContinue:true with empty context when sidecar is null", async () => {
    const result = await handleCompactionAutocontinue(null, SAME("/project"));
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("returns shouldContinue:false when TDD is in RED_CONFIRMED state", async () => {
    const tddStates: TddCycle[] = [redCycle("/project/src/foo.ts")];
    const { sidecar } = makeMockSidecar({ tddStates });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toContain("RED");
  });

  it("returns shouldContinue:true with spec resume directive when spec is IN_PROGRESS", async () => {
    const spec: Spec = {
      id: "spec-1",
      title: "My Feature",
      status: "IN_PROGRESS",
      type: "feature",
      approved: true,
      planFile: "docs/plans/2026-01-01-my-feature.md",
      tasks: [
        { position: 1, title: "Setup types", status: "complete" },
        { position: 2, title: "Implement handler", status: "in-progress" },
        { position: 3, title: "Write tests", status: "pending" },
      ],
      metadata: {},
    };
    const { sidecar } = makeMockSidecar({ tddStates: [], currentSpec: spec });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    expect(result.shouldContinue).toBe(true);
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toContain("docs/plans/2026-01-01-my-feature.md");
    expect(result.context[0]).toContain("Task 2");
    expect(result.context[0]).toContain("Implement handler");
  });

  it("falls back to first pending task when no in-progress task exists", async () => {
    const spec: Spec = {
      id: "spec-2",
      title: "Another Feature",
      status: "IN_PROGRESS",
      type: "feature",
      approved: true,
      planFile: "docs/plans/2026-02-01-another.md",
      tasks: [
        { position: 1, title: "First task", status: "complete" },
        { position: 2, title: "Second task", status: "pending" },
      ],
      metadata: {},
    };
    const { sidecar } = makeMockSidecar({ tddStates: [], currentSpec: spec });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    expect(result.shouldContinue).toBe(true);
    expect(result.context[0]).toContain("Task 2");
    expect(result.context[0]).toContain("Second task");
  });

  it("returns shouldContinue:true with empty context when idle (no TDD red, no active spec)", async () => {
    const { sidecar } = makeMockSidecar({ tddStates: [], currentSpec: null });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("filters TDD states by workspace — ignores RED_CONFIRMED from other projects", async () => {
    const tddStates: TddCycle[] = [redCycle("/other-project/src/foo.ts")];
    const { sidecar } = makeMockSidecar({ tddStates, currentSpec: null });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/my-project"),
    );
    expect(result.shouldContinue).toBe(true); // other project's RED doesn't block us
    expect(result.context).toEqual([]);
  });

  it("does not treat a sibling sharing the root as a prefix as inside the workspace", async () => {
    // `/project-evil/...` startsWith `/project` — a raw prefix test matches it.
    const tddStates: TddCycle[] = [redCycle("/project-evil/src/foo.ts")];
    const { sidecar } = makeMockSidecar({ tddStates, currentSpec: null });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("returns shouldContinue:true with empty context when spec is IN_PROGRESS but all tasks are complete", async () => {
    const spec: Spec = {
      id: "spec-done",
      title: "Completed Feature",
      status: "IN_PROGRESS",
      type: "feature",
      approved: true,
      planFile: "docs/plans/2026-03-01-done.md",
      tasks: [
        { position: 1, title: "Task A", status: "complete" },
        { position: 2, title: "Task B", status: "complete" },
      ],
      metadata: {},
    };
    const { sidecar } = makeMockSidecar({ tddStates: [], currentSpec: spec });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    // All tasks done — no currentTask, so idle fallthrough
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("ignores TDD states that are not RED_CONFIRMED", async () => {
    const tddStates: TddCycle[] = [
      { ...redCycle("/project/src/bar.ts"), state: "TEST_WRITTEN" },
    ];
    const { sidecar } = makeMockSidecar({ tddStates, currentSpec: null });
    const result = await handleCompactionAutocontinue(
      sidecar,
      SAME("/project"),
    );
    expect(result.shouldContinue).toBe(true);
    expect(result.context).toEqual([]);
  });
});

// ── Real linked-worktree fixture: identity ≠ workspace ─────────────────────
//
// Synthetic string literals cannot catch the identity/workspace conflation —
// with `SAME(...)` both roots are equal, so either one "works". Only a real
// `git worktree add` produces the two DIFFERENT roots the plugin passes.
describe("handleCompactionAutocontinue — linked worktree (identity ≠ workspace)", () => {
  let fixtureRoot: string;
  let mainRoot: string;
  let linkedRoot: string;
  let roots: { identity: string; workspace: string };

  function git(cwd: string, ...args: string[]): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
  }

  beforeAll(() => {
    // realpathSync: macOS tmpdir is a /var → /private/var symlink.
    fixtureRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "sentinal-compaction-fixture-")),
    );
    mainRoot = join(fixtureRoot, "main");
    linkedRoot = join(fixtureRoot, "linked");
    mkdirSync(mainRoot, { recursive: true });

    git(mainRoot, "init", "-q", "-b", "main");
    git(mainRoot, "config", "user.email", "fixture@example.com");
    git(mainRoot, "config", "user.name", "Fixture");
    writeFileSync(join(mainRoot, "README.md"), "fixture\n");
    git(mainRoot, "add", ".");
    git(mainRoot, "commit", "-q", "-m", "init");
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", linkedRoot);

    mkdirSync(join(linkedRoot, "src"), { recursive: true });
    writeFileSync(join(linkedRoot, "src", "foo.ts"), "export {};\n");

    roots = {
      identity: resolveProjectIdentity(linkedRoot),
      workspace: resolveWorkspaceRoot(linkedRoot),
    };
  }, 20_000);

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("fixture precondition: identity is the MAIN checkout, workspace the LINKED one", () => {
    expect(roots.identity).toBe(mainRoot);
    expect(roots.workspace).toBe(linkedRoot);
    expect(roots.identity).not.toBe(roots.workspace);
  });

  it("pauses when a RED cycle lives under the WORKSPACE, even though identity differs", async () => {
    const { sidecar } = makeMockSidecar({
      tddStates: [redCycle(join(linkedRoot, "src", "foo.ts"))],
      currentSpec: null,
    });
    const result = await handleCompactionAutocontinue(sidecar, roots);
    expect(result.shouldContinue).toBe(false);
    expect(result.context[0]).toContain("RED");
  });

  it("does NOT pause for a RED cycle under the identity (main checkout) when working in the linked worktree", async () => {
    const { sidecar } = makeMockSidecar({
      tddStates: [redCycle(join(mainRoot, "README.md"))],
      currentSpec: null,
    });
    const result = await handleCompactionAutocontinue(sidecar, roots);
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("passes the IDENTITY (storage key), not the workspace, to getCurrentSpec", async () => {
    const { sidecar, calls } = makeMockSidecar({
      tddStates: [],
      currentSpec: null,
    });
    await handleCompactionAutocontinue(sidecar, roots);
    expect(calls.getCurrentSpec).toEqual([[mainRoot]]);
    // listActiveTddStates is unscoped today — it must receive no root at all.
    expect(calls.listActiveTddStates).toEqual([[]]);
  });

  it("isInside is STRICT — the workspace root itself is not inside itself", async () => {
    expect(isInside(linkedRoot, linkedRoot)).toBe(false);
    const { sidecar } = makeMockSidecar({
      tddStates: [redCycle(linkedRoot)],
      currentSpec: null,
    });
    const result = await handleCompactionAutocontinue(sidecar, roots);
    expect(result.shouldContinue).toBe(true);
  });

  it("excludes a RELATIVE filePath (fail-open, matching prior behaviour)", async () => {
    // A relative path resolves against the process cwd, never the workspace.
    expect(isInside("src/foo.ts", linkedRoot)).toBe(false);
    const { sidecar } = makeMockSidecar({
      tddStates: [redCycle("src/foo.ts")],
      currentSpec: null,
    });
    const result = await handleCompactionAutocontinue(sidecar, roots);
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });
});
