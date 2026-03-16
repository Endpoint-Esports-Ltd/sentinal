/**
 * Spec MCP Tools Tests
 *
 * Tests for spec workflow MCP tools:
 *   - spec_register: Register/update a plan in SQLite
 *   - spec_wait_file: Wait for file to appear on disk
 *   - spec_config: Read spec workflow toggle env vars
 *   - spec_plan_parse: Parse plan file metadata
 *   - spec_notify: Create notification in SQLite
 *   - spec_events: Get spec event history
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";
import { registerSpecTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";

function makePlanFile(dir: string, slug: string, status = "PENDING"): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${slug}.md`);
  writeFileSync(
    planFile,
    `# Test Plan

Status: ${status}
Type: Feature
Approved: Yes

## Progress Tracking

- [ ] Task 1: First task
- [ ] Task 2: Second task

**Total Tasks:** 2 | **Completed:** 0 | **Remaining:** 2

## Implementation Tasks

### Task 1: First task

**Objective:** Do the first thing.

### Task 2: Second task

**Objective:** Do the second thing.
`,
  );
  return planFile;
}

// --- spec_register tests ---

describe("spec_register MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("spec_register")).toBe(true);
  });

  it("should register a plan file and return formatted status", async () => {
    const planFile = makePlanFile(tmpDir, "2026-01-01-test-feature");
    const handler = tools.get("spec_register")!;

    const result = await handler({ plan_path: planFile, project: tmpDir });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Registered:");
    expect(result.content[0].text).toContain("2026-01-01-test-feature");
    expect(result.content[0].text).toContain("PENDING");
    expect(result.content[0].text).toContain("0/2");
  });

  it("should update plan file status when status parameter is provided", async () => {
    const planFile = makePlanFile(tmpDir, "2026-01-01-status-test", "PENDING");
    const handler = tools.get("spec_register")!;

    await handler({
      plan_path: planFile,
      project: tmpDir,
      status: "IN_PROGRESS",
    });

    // Verify the plan file was updated on disk
    const content = readFileSync(planFile, "utf-8");
    expect(content).toContain("Status: IN_PROGRESS");
    expect(content).not.toContain("Status: PENDING");

    // Verify SQLite is in sync
    const specStore = new SpecStore(store);
    const spec = specStore.getSpec("2026-01-01-status-test");
    expect(spec).not.toBeNull();
    expect(spec!.status).toBe("IN_PROGRESS");
  });

  it("should default project to CWD when not provided", async () => {
    const planFile = makePlanFile(tmpDir, "2026-01-01-default-project");
    const handler = tools.get("spec_register")!;

    const result = await handler({ plan_path: planFile });

    expect(result.content[0].text).toContain("Registered:");
    expect(result.content[0].text).toContain("2026-01-01-default-project");
  });
});

// --- spec_wait_file tests ---

describe("spec_wait_file MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("spec_wait_file")).toBe(true);
  });

  it("should return immediately if file already exists", async () => {
    const filePath = join(tmpDir, "existing-file.json");
    writeFileSync(filePath, '{"result": "ok"}');
    const handler = tools.get("spec_wait_file")!;

    const result = await handler({ file_path: filePath });

    expect(result.content[0].text).toContain("READY:");
    expect(result.content[0].text).toContain(filePath);
  });

  it("should detect file created after tool call starts", async () => {
    const filePath = join(tmpDir, "delayed-file.json");
    const handler = tools.get("spec_wait_file")!;

    // Create the file after a short delay
    setTimeout(() => {
      writeFileSync(filePath, '{"result": "ok"}');
    }, 500);

    const result = await handler({ file_path: filePath, timeout_seconds: 5 });

    expect(result.content[0].text).toContain("READY:");
    expect(result.content[0].text).toContain(filePath);
  });

  it("should return TIMEOUT when file does not appear", async () => {
    const filePath = join(tmpDir, "never-created.json");
    const handler = tools.get("spec_wait_file")!;

    const result = await handler({ file_path: filePath, timeout_seconds: 1 });

    expect(result.content[0].text).toContain("TIMEOUT:");
    expect(result.content[0].text).toContain("1s");
  });
});

// --- spec_config tests ---

describe("spec_config MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  const ENV_KEYS = [
    "SENTINAL_PLAN_QUESTIONS_ENABLED",
    "SENTINAL_PLAN_REVIEWER_ENABLED",
    "SENTINAL_PLAN_APPROVAL_ENABLED",
    "SENTINAL_SPEC_REVIEWER_ENABLED",
    "SENTINAL_WORKTREE_ENABLED",
    "SENTINAL_SESSION_ID",
  ];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    // Save and clear env vars
    for (const key of ENV_KEYS) delete process.env[key];
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("should be registered as a tool", () => {
    expect(tools.has("spec_config")).toBe(true);
  });

  it("should report all defaults when no env vars set", async () => {
    const handler = tools.get("spec_config")!;
    const result = await handler({});

    const text = result.content[0].text;
    expect(text).toContain("questions_enabled");
    expect(text).toContain("plan_reviewer_enabled");
    expect(text).toContain("approval_enabled");
    expect(text).toContain("spec_reviewer_enabled");
    expect(text).toContain("worktree_enabled");
    expect(text).toContain("session_id");
  });

  it("should report set env var values", async () => {
    process.env.SENTINAL_PLAN_QUESTIONS_ENABLED = "false";
    process.env.SENTINAL_SESSION_ID = "test-session-123";
    const handler = tools.get("spec_config")!;

    const result = await handler({});

    const text = result.content[0].text;
    expect(text).toContain("false");
    expect(text).toContain("disabled");
    expect(text).toContain("test-session-123");
  });
});

// --- spec_plan_parse tests ---

describe("spec_plan_parse MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("spec_plan_parse")).toBe(true);
  });

  it("should return parsed plan metadata", async () => {
    const planFile = makePlanFile(
      tmpDir,
      "2026-03-01-my-feature",
      "IN_PROGRESS",
    );
    const handler = tools.get("spec_plan_parse")!;

    const result = await handler({ plan_path: planFile });
    const text = result.content[0].text;

    expect(text).toContain("2026-03-01-my-feature");
    expect(text).toContain("Test Plan");
    expect(text).toContain("IN_PROGRESS");
    expect(text).toContain("feature");
    expect(text).toContain("plan-review.json");
    expect(text).toContain("spec-review.json");
  });
});

// --- spec_notify tests ---

describe("spec_notify MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("spec_notify")).toBe(true);
  });

  it("should create a notification", async () => {
    const handler = tools.get("spec_notify")!;

    const result = await handler({
      type: "success",
      title: "Plan approved",
      message: "The plan was approved by the reviewer",
    });

    expect(result.content[0].text).toContain("Notification created");
    expect(result.content[0].text).toContain("Plan approved");

    // Verify notification exists in store
    const notifs = store.getNotifications({ limit: 10 });
    expect(notifs.length).toBe(1);
    expect(notifs[0].title).toBe("Plan approved");
    expect(notifs[0].type).toBe("success");
  });
});

// --- spec_events tests ---

describe("spec_events MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("spec_events")).toBe(true);
  });

  it("should return event history for a spec", async () => {
    // Register a plan first (foreign key constraint on spec_events)
    const planFile = makePlanFile(tmpDir, "test-spec", "IN_PROGRESS");
    const specStore = new SpecStore(store);
    specStore.syncFromPlanFile(planFile, tmpDir);

    // Add some events
    store.logSpecEvent({
      specId: "test-spec",
      eventType: "phase_change",
      details: { from: "plan", to: "implement" },
    });
    store.logSpecEvent({
      specId: "test-spec",
      eventType: "task_update",
      details: { task: 1, status: "complete" },
    });

    const handler = tools.get("spec_events")!;
    const result = await handler({ spec_id: "test-spec" });
    const text = result.content[0].text;

    expect(text).toContain("phase_change");
    expect(text).toContain("task_update");
  });

  it("should return empty message when no events", async () => {
    const handler = tools.get("spec_events")!;
    const result = await handler({ spec_id: "nonexistent" });

    expect(result.content[0].text).toContain("No events");
  });
});

// --- Sidecar mode tests ---

function captureSidecarTools(
  mockClient: Partial<SidecarClient>,
): Map<string, ToolHandler> {
  return captureTools(registerSpecTools, {
    client: mockClient as SidecarClient,
  });
}

describe("spec MCP tools (sidecar mode)", () => {
  it("spec_status should delegate to client.getCurrentSpec", async () => {
    const mockClient = {
      getCurrentSpec: async () => ({
        id: "test-spec",
        title: "Test Spec",
        status: "IN_PROGRESS" as const,
        type: "feature" as const,
        approved: true,
        planFile: "/plans/test.md",
        tasks: [
          { position: 1, title: "Task 1", status: "complete" as const },
          { position: 2, title: "Task 2", status: "pending" as const },
        ],
        metadata: {},
      }),
    };

    const tools = captureSidecarTools(mockClient);
    const handler = tools.get("spec_status")!;
    const result = await handler({ project: "/test" });
    const text = result.content[0].text;

    expect(text).toContain("Test Spec");
    expect(text).toContain("IN_PROGRESS");
    expect(text).toContain("1/2");
  });

  it("spec_status should handle null from client", async () => {
    const mockClient = {
      getCurrentSpec: async () => null,
    };

    const tools = captureSidecarTools(mockClient);
    const handler = tools.get("spec_status")!;
    const result = await handler({ project: "/test" });

    expect(result.content[0].text).toContain("No active spec");
  });

  it("spec_register should delegate to client.syncSpec", async () => {
    const tmpDir = makeTmpDir();
    try {
      const planFile = makePlanFile(tmpDir, "2026-01-01-sidecar-test");
      const calls: Array<{ planPath: string; projectPath: string }> = [];
      const mockClient = {
        syncSpec: async (planPath: string, projectPath: string) => {
          calls.push({ planPath, projectPath });
        },
      };

      const tools = captureSidecarTools(mockClient);
      const handler = tools.get("spec_register")!;
      const result = await handler({ plan_path: planFile, project: tmpDir });

      expect(calls).toHaveLength(1);
      expect(calls[0].planPath).toBe(planFile);
      expect(result.content[0].text).toContain("Registered:");
      expect(result.content[0].text).toContain("2026-01-01-sidecar-test");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spec_notify should delegate to client.insertNotification", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mockClient = {
      insertNotification: async (notif: Record<string, unknown>) => {
        calls.push(notif);
      },
    };

    const tools = captureSidecarTools(mockClient);
    const handler = tools.get("spec_notify")!;
    await handler({
      type: "info",
      title: "Test notification",
      message: "Details",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Test notification");
    expect(calls[0].type).toBe("info");
  });

  it("spec_events should delegate to client.getSpecEvents", async () => {
    const mockClient = {
      getSpecEvents: async (_specId: string, _limit?: number) => [
        {
          id: 1,
          specId: "test-spec",
          sessionId: null,
          eventType: "phase_change" as const,
          timestamp: Date.now(),
          details: { from: "plan", to: "implement" },
        },
      ],
    };

    const tools = captureSidecarTools(mockClient);
    const handler = tools.get("spec_events")!;
    const result = await handler({ spec_id: "test-spec" });

    expect(result.content[0].text).toContain("phase_change");
  });

  it("spec_events should handle empty from client", async () => {
    const mockClient = {
      getSpecEvents: async () => [],
    };

    const tools = captureSidecarTools(mockClient);
    const handler = tools.get("spec_events")!;
    const result = await handler({ spec_id: "nonexistent" });

    expect(result.content[0].text).toContain("No events");
  });
});
