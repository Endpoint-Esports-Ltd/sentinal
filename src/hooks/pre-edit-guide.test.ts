/**
 * Pre-Edit Guidance Hook Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { processPreEditGuide } from "./pre-edit-guide.js";
import type { CreateObservation } from "../memory/types.js";

function makeObservation(overrides: Partial<CreateObservation> = {}): CreateObservation {
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
    service.addObservation(makeObservation({
      type: "decision",
      title: "Use JWT for authentication",
      content: "Decided to use JWT tokens for auth",
      filePaths: ["src/auth/auth.service.ts"],
      timestamp: Date.now() - 5000,
    }));

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
    service.addObservation(makeObservation({
      type: "error",
      title: "Error in unrelated file",
      filePaths: ["src/other/file.ts"],
    }));

    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).toBeNull();
  });

  it("should include multiple observations for the same file", async () => {
    service.addObservation(makeObservation({
      type: "decision",
      title: "Use JWT tokens",
      filePaths: ["src/auth/auth.service.ts"],
      timestamp: Date.now() - 10000,
    }));
    service.addObservation(makeObservation({
      type: "error",
      title: "Race condition in token refresh",
      filePaths: ["src/auth/auth.service.ts"],
      timestamp: Date.now() - 5000,
    }));

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
    service.addObservation(makeObservation({
      type: "pattern",
      title: "Always validate DTOs",
      filePaths: ["/absolute/path/src/auth/auth.service.ts"],
    }));

    const result = await processPreEditGuide({
      filePath: "src/auth/auth.service.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("Always validate DTOs");
  });

  it("should format the hint with Sentinal prefix", async () => {
    service.addObservation(makeObservation({
      type: "fix",
      title: "Fixed import order",
      filePaths: ["src/test.ts"],
    }));

    const result = await processPreEditGuide({
      filePath: "src/test.ts",
      cwd: "/test/project",
      service,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("[Sentinal]");
  });
});
