/**
 * Pre-Edit Guidance Hook Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { processPreEditGuide } from "./pre-edit-guide.js";
import type { CreateObservation } from "../memory/types.js";

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
  return {
    sessionId: "test-session",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "Some content",
    filePaths: [],
    tags: [],
    metadata: {},
    ...overrides,
  };
}

describe("processPreEditGuide", () => {
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
  });

  it("should return null when no observations exist for the file", async () => {
    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).toBeNull();
  });

  it("should return hint when observations exist for the file", async () => {
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Use JWT for authentication",
        content: "Decided to use JWT tokens for auth",
        filePaths: ["src/auth/auth.service.ts"],
        timestamp: Date.now() - 5000,
      }),
    );

    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("auth.service.ts");
    expect(result).toContain("Use JWT for authentication");
    expect(result).toContain("[decision]");
  });

  it("should not include observations about other files", async () => {
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Error in unrelated file",
        filePaths: ["src/other/file.ts"],
      }),
    );

    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).toBeNull();
  });

  it("should include multiple observations for the same file", async () => {
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Use JWT tokens",
        filePaths: ["src/auth/auth.service.ts"],
        timestamp: Date.now() - 10000,
      }),
    );
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Race condition in token refresh",
        filePaths: ["src/auth/auth.service.ts"],
        timestamp: Date.now() - 5000,
      }),
    );

    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("Use JWT tokens");
    expect(result).toContain("Race condition");
  });

  it("should match file paths that end with the target path", async () => {
    service.addObservation(
      makeObservation({
        type: "pattern",
        title: "Always validate DTOs",
        filePaths: ["/absolute/path/src/auth/auth.service.ts"],
      }),
    );

    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("Always validate DTOs");
  });

  it("should format the hint with Sentinal prefix", async () => {
    service.addObservation(
      makeObservation({
        type: "fix",
        title: "Fixed import order",
        filePaths: ["src/test.ts"],
      }),
    );

    const result = await processPreEditGuide({
      filePath: "src/test.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("[Sentinal]");
  });

  it("should show max 3 observations when effort is low", async () => {
    const filePath = "src/auth/auth.service.ts";
    for (let i = 1; i <= 6; i++) {
      service.addObservation(
        makeObservation({
          type: "discovery",
          title: `Observation ${i}`,
          filePaths: [filePath],
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const result = await processPreEditGuide({
      filePath,
      cwd: "/test/project",
      service,
      effort: "low",
    });

    expect(result).not.toBeNull();
    // Should show exactly 3 observations (low effort → maxHits = 3)
    const matches = result!.match(/^- /gm);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(3);
    expect(result).toContain("and 3 more observation(s)");
  });

  it("should show max 5 observations when effort is xhigh", async () => {
    const filePath = "src/auth/auth.service.ts";
    for (let i = 1; i <= 7; i++) {
      service.addObservation(
        makeObservation({
          type: "discovery",
          title: `Observation ${i}`,
          filePaths: [filePath],
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const result = await processPreEditGuide({
      filePath,
      cwd: "/test/project",
      service,
      effort: "xhigh",
    });

    expect(result).not.toBeNull();
    // Should show exactly 5 observations (xhigh effort → maxHits = 5)
    const matches = result!.match(/^- /gm);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(5);
    expect(result).toContain("and 2 more observation(s)");
  });

  it("should show max 5 observations when effort is not specified", async () => {
    const filePath = "src/auth/auth.service.ts";
    for (let i = 1; i <= 7; i++) {
      service.addObservation(
        makeObservation({
          type: "discovery",
          title: `Observation ${i}`,
          filePaths: [filePath],
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const result = await processPreEditGuide({
      filePath,
      cwd: "/test/project",
      service,
      // no effort field
    });

    expect(result).not.toBeNull();
    // Should show exactly 5 observations (default → maxHits = 5)
    const matches = result!.match(/^- /gm);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(5);
    expect(result).toContain("and 2 more observation(s)");
  });
});

// ─── Cross-project: hints + conflict check use the file's project (Phase 1) ─

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidecarClient } from "../sidecar/client.js";
import { preEditHookContext } from "./pre-edit-guide.js";

describe("pre-edit context keyed by the file's project", () => {
  let tmp: string;
  let a: string;
  let b: string;
  let svc: MemoryService;

  beforeEach(() => {
    svc = new MemoryService(new MemoryStore(":memory:"));
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "pre-edit-cross-")));
    a = join(tmp, "a");
    b = join(tmp, "b");
    for (const d of [a, b]) {
      mkdirSync(join(d, "src"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: d });
    }
  });

  afterEach(() => {
    svc.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeClient(projects: string[]): SidecarClient {
    return {
      memorySearch: async (q: { project?: string }) => {
        projects.push(q.project ?? "");
        return [];
      },
    } as unknown as SidecarClient;
  }

  it("editing B/src/x.ts from cwd A searches B's memories", async () => {
    const projects: string[] = [];
    await processPreEditGuide({
      filePath: join(b, "src", "x.ts"),
      cwd: a,
      client: fakeClient(projects),
    });
    expect(projects).toEqual([b]);
  }, 30_000);

  it("an explicit project wins", async () => {
    const projects: string[] = [];
    await processPreEditGuide({
      filePath: join(b, "src", "x.ts"),
      cwd: a,
      client: fakeClient(projects),
      project: "/explicit",
    });
    expect(projects).toEqual(["/explicit"]);
  });

  it("from A/src as cwd the direct fallback uses A's canonical identity", async () => {
    svc.addObservation(
      makeObservation({
        projectPath: a,
        title: "A note on x",
        filePaths: [join(a, "src", "x.ts")],
      }),
    );
    const result = await processPreEditGuide({
      filePath: join(a, "src", "x.ts"),
      cwd: join(a, "src"),
      service: svc,
    });
    expect(result).toContain("A note on x");
  }, 30_000);

  it("the conflict check queries the file's project (B from session A)", async () => {
    const asked: string[] = [];
    await preEditHookContext({
      filePath: join(b, "src", "x.ts"),
      cwd: a,
      sessionId: "s1",
      client: fakeClient([]),
      checkConflict: (_file, project) => {
        asked.push(project);
        return "[Sentinal] Warning: conflict";
      },
    });
    expect(asked).toEqual([b]);
  }, 30_000);

  it("the conflict check from A/src uses A's canonical identity, and its message is returned", async () => {
    const asked: string[] = [];
    const out = await preEditHookContext({
      filePath: join(a, "src", "x.ts"),
      cwd: join(a, "src"),
      sessionId: "s1",
      client: fakeClient([]),
      checkConflict: (_file, project) => {
        asked.push(project);
        return "[Sentinal] Warning: conflict";
      },
    });
    expect(asked).toEqual([a]);
    expect(out).toBe("[Sentinal] Warning: conflict");
  }, 30_000);

  it("no session id → no conflict check; nothing found → null", async () => {
    let called = false;
    const out = await preEditHookContext({
      filePath: join(a, "src", "x.ts"),
      cwd: a,
      client: fakeClient([]),
      checkConflict: () => {
        called = true;
        return null;
      },
    });
    expect(called).toBe(false);
    expect(out).toBeNull();
  }, 30_000);
});
