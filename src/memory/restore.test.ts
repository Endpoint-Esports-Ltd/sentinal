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

  it("should return empty context for unknown project", () => {
    const result = restoreContext(service, {
      projectPath: "/unknown/project",
    });

    expect(result.hasMemory).toBe(false);
    expect(result.markdown).toBe("");
    expect(result.observationCount).toBe(0);
  });

  it("should include project path in context", () => {
    service.addObservation(makeObservation());

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.hasMemory).toBe(true);
    expect(result.markdown).toContain("/test/project");
  });

  it("should include key decisions", () => {
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Chose repository pattern for data access",
        timestamp: Date.now() - 5000,
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Key Decisions");
    expect(result.markdown).toContain("Chose repository pattern");
  });

  it("should include recent discoveries", () => {
    service.addObservation(
      makeObservation({
        type: "discovery",
        title: "CDK virtual scroll needs explicit height",
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Recent Discoveries");
    expect(result.markdown).toContain("CDK virtual scroll");
  });

  it("should include patterns", () => {
    service.addObservation(
      makeObservation({
        type: "pattern",
        title: "All DTOs use class-validator with whitelist: true",
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Patterns");
    expect(result.markdown).toContain("class-validator");
  });

  it("should show unresolved errors as active issues", () => {
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Race condition in auth token refresh",
        filePaths: ["src/auth.ts"],
        timestamp: Date.now() - 5000,
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Active Issues");
    expect(result.markdown).toContain("Race condition");
  });

  it("should NOT show errors that have been fixed", () => {
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

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    // Error should not appear in Active Issues since it was fixed
    expect(result.markdown).not.toContain("### Active Issues");
  });

  it("should include recent fixes", () => {
    service.addObservation(
      makeObservation({
        type: "fix",
        title: "Fixed auth token refresh race condition",
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("### Recent Fixes");
    expect(result.markdown).toContain("Fixed auth token");
  });

  it("should respect recentLimit", () => {
    for (let i = 0; i < 20; i++) {
      service.addObservation(
        makeObservation({ title: `Observation ${i}`, timestamp: i }),
      );
    }

    const result = restoreContext(service, {
      projectPath: "/test/project",
      recentLimit: 5,
    });

    expect(result.observationCount).toBe(5);
  });

  it("should truncate output at maxOutputLength", () => {
    for (let i = 0; i < 50; i++) {
      service.addObservation(
        makeObservation({
          type: "decision",
          title: `Very long decision title number ${i} with lots of detail about the architecture`,
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const result = restoreContext(service, {
      projectPath: "/test/project",
      maxOutputLength: 500,
    });

    expect(result.markdown.length).toBeLessThanOrEqual(500);
    expect(result.markdown).toContain("*(truncated)*");
  });

  it("should format dates as YYYY-MM-DD", () => {
    const specificDate = new Date("2026-03-08T12:00:00Z").getTime();
    service.addObservation(
      makeObservation({
        type: "decision",
        title: "Test date formatting",
        timestamp: specificDate,
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).toContain("2026-03-08");
  });

  it("should show file-context-aware related observations", () => {
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

    const result = restoreContext(service, {
      projectPath: "/test/project",
      currentFiles: ["src/auth/auth.service.ts"],
    });

    // Should have the "Related to Current Files" section
    // with the error/fix related to auth.service.ts
    expect(result.markdown).toContain("auth");
    expect(result.hasMemory).toBe(true);
  });

  it("should not show Related to Current Files when no currentFiles provided", () => {
    service.addObservation(
      makeObservation({
        type: "error",
        title: "Some error",
        filePaths: ["src/foo.ts"],
      }),
    );

    const result = restoreContext(service, {
      projectPath: "/test/project",
    });

    expect(result.markdown).not.toContain("### Related to Current Files");
  });

  it("should only include observations for the specified project", () => {
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

    const result = restoreContext(service, {
      projectPath: "/project-a",
    });

    expect(result.markdown).toContain("Project A decision");
    expect(result.markdown).not.toContain("Project B decision");
  });
});
