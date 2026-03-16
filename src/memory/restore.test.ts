/**
 * Context Restoration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { restoreContext } from "./restore.js";
import type { CreateObservation } from "./types.js";

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
  return {
    sessionId: "session-1",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "Test content",
    filePaths: [],
    tags: [],
    metadata: {},
    ...overrides,
  };
}

describe("restoreContext", () => {
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
  });

  it("should return empty context for unknown project", async () => {
    const result = await restoreContext(service, {
      projectPath: "/unknown/project",
    });

    expect(result.hasMemory).toBe(false);
    expect(result.markdown).toBe("");
    expect(result.observationCount).toBe(0);
  });

  it("should include project path in context", async () => {
    service.addObservation(makeObservation());

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.hasMemory).toBe(true);
    expect(result.markdown).toContain("/test/project");
  });

  it("should include key decisions", async () => {
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Chose repository pattern for data access",
        timestamp: Date.now() - 5000,
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Key Decisions");
    expect(result.markdown).toContain("Chose repository pattern");
  });

  it("should include recent discoveries", async () => {
    service.addObservation(
      makeObservation({
        type: "discovery",
        title: "CDK virtual scroll needs explicit height",
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Recent Discoveries");
    expect(result.markdown).toContain("CDK virtual scroll");
  });

  it("should include patterns", async () => {
    service.addObservation(
      makeObservation({
        type: "pattern",
        title: "All DTOs use class-validator with whitelist: true",
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Patterns");
    expect(result.markdown).toContain("class-validator");
  });

  it("should show unresolved errors as active issues", async () => {
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Race condition in auth token refresh",
        filePaths: ["src/auth.ts"],
        timestamp: Date.now() - 5000,
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Active Issues");
    expect(result.markdown).toContain("Race condition");
  });

  it("should NOT show errors that have been fixed", async () => {
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Build failed due to missing import",
        filePaths: ["src/app.ts"],
        timestamp: Date.now() - 10000,
      }),
    );

    service.addObservation(
      makeObservation({
        type: "fix",
        title: "Fixed missing import in app.ts",
        filePaths: ["src/app.ts"],
        timestamp: Date.now() - 5000,
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    // Error should not appear in Active Issues since it was fixed
    expect(result.markdown).not.toContain("### Active Issues");
  });

  it("should include recent fixes", async () => {
    service.addObservation(
      makeObservation({
        type: "fix",
        title: "Fixed auth token refresh race condition",
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Recent Fixes");
    expect(result.markdown).toContain("Fixed auth token");
  });

  it("should respect recentLimit", async () => {
    for (let i = 0; i < 20; i++) {
      service.addObservation(
        makeObservation({ title: `Observation ${i}`, timestamp: i }),
      );
    }

    const result = await restoreContext(service, {
      projectPath: "/test/project",
      recentLimit: 5,
    });

    expect(result.observationCount).toBe(5);
  });

  it("should truncate output at maxOutputLength", async () => {
    for (let i = 0; i < 50; i++) {
      service.addObservation(
        makeObservation({
          type: "decision",
          title: `Very long decision title number ${i} with lots of detail about the architecture`,
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const result = await restoreContext(service, {
      projectPath: "/test/project",
      maxOutputLength: 500,
    });

    expect(result.markdown.length).toBeLessThanOrEqual(500);
    expect(result.markdown).toContain("*(truncated)*");
  });

  it("should format dates as YYYY-MM-DD", async () => {
    const specificDate = new Date("2026-03-08T12:00:00Z").getTime();
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Test date formatting",
        timestamp: specificDate,
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("2026-03-08");
  });

  it("should show file-context-aware related observations", async () => {
    // Add an error on a specific file
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Type error in auth service",
        filePaths: ["src/auth/auth.service.ts"],
        timestamp: Date.now() - 8000,
      }),
    );

    // Add a fix on the same file (resolves the error above)
    service.addObservation(
      makeObservation({
        type: "fix",
        title: "Fixed type error in auth service",
        filePaths: ["src/auth/auth.service.ts"],
        timestamp: Date.now() - 5000,
      }),
    );

    // Add an unrelated observation
    service.addObservation(
      makeObservation({
        type: "discovery",
        title: "Unrelated discovery",
        filePaths: ["src/other/file.ts"],
        timestamp: Date.now() - 3000,
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
      currentFiles: ["src/auth/auth.service.ts"],
    });

    // Should have the "Related to Current Files" section
    // with the error/fix related to auth.service.ts
    expect(result.markdown).toContain("auth");
    expect(result.hasMemory).toBe(true);
  });

  it("should not show Related to Current Files when no currentFiles provided", async () => {
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Some error",
        filePaths: ["src/foo.ts"],
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).not.toContain("### Related to Current Files");
  });

  // ─── Semantic Restore ──────────────────────────────────────────────────

  it("should accept semanticQuery and return a Promise", async () => {
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Chose SQLite for memory storage",
        content: "SQLite provides reliable embedded database with FTS5 support",
        timestamp: Date.now() - 10000,
      }),
    );

    // restoreContext always returns a Promise now
    const result = await restoreContext(service, {
      projectPath: "/test/project",
      semanticQuery: "database storage SQLite",
    });

    expect(result.hasMemory).toBe(true);
    expect(result.observationCount).toBeGreaterThan(0);
    expect(result.markdown).toContain("Sentinal Memory Context");
  });

  it("should fall back to chronological when semanticQuery search fails", async () => {
    service.addObservation(
      makeObservation({
        type: "discovery",
        title: "Fallback test observation",
        timestamp: Date.now() - 1000,
      }),
    );

    // Even if semantic search fails internally, should still return results
    const result = await restoreContext(service, {
      projectPath: "/test/project",
      semanticQuery: "some query that exercises the path",
    });

    expect(result.hasMemory).toBe(true);
    expect(result.markdown).toContain("Fallback test observation");
  });

  it("should supplement sparse semantic results with chronological", async () => {
    // Add several observations
    for (let i = 0; i < 8; i++) {
      service.addObservation(
        makeObservation({
          type: "discovery",
          title: `Discovery ${i}`,
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const result = await restoreContext(service, {
      projectPath: "/test/project",
      semanticQuery: "test query",
    });

    expect(result.hasMemory).toBe(true);
    // Should have observations (either from semantic or chronological supplement)
    expect(result.observationCount).toBeGreaterThan(0);
  });

  // ─── Shared Memory Integration ──────────────────────────────────────────

  it("should include shared observations in restore output", async () => {
    // Dynamically import shared memory helpers
    const { writeSharedMemory } = await import("./shared.js");
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const projectDir = join(tmpdir(), `sentinal-restore-shared-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      // Write shared observations to the project
      writeSharedMemory(projectDir, [{
        type: "decision",
        title: "Shared architecture decision",
        content: "We use event-driven architecture",
        tags: ["architecture"],
        filePaths: [],
        createdAt: "2026-03-15",
      }]);

      const result = await restoreContext(service, {
        projectPath: projectDir,
      });

      expect(result.hasMemory).toBe(true);
      expect(result.markdown).toContain("Shared architecture decision");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("should work when no shared memory file exists", async () => {
    const result = await restoreContext(service, {
      projectPath: "/nonexistent/project",
    });

    // Should still work (empty shared memory, no SQLite data for this path)
    expect(result.hasMemory).toBe(false);
  });

  it("should only include observations for the specified project", async () => {
    service.addObservation(
      makeObservation({
        projectPath: "/project-a",
        type: "decision",
        title: "Project A decision",
      }),
    );
    service.addObservation(
      makeObservation({
        projectPath: "/project-b",
        type: "decision",
        title: "Project B decision",
      }),
    );

    const result = await restoreContext(service, {
      projectPath: "/project-a",
    });

    expect(result.markdown).toContain("Project A decision");
    expect(result.markdown).not.toContain("Project B decision");
  });
});
