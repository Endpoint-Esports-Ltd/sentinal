/**
 * TDD Routes Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { bulkTddTransition } from "./tdd-routes.js";

function ensureSpec(store: MemoryStore, specId: string): void {
  const db = store.getRawDb();
  db.run(
    `INSERT OR IGNORE INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at)
     VALUES (?, '/test', 'Test', ?, 'feature', 'IN_PROGRESS', 1, '/test.md', 1, 0, ?, ?)`,
    [specId, specId, Date.now(), Date.now()],
  );
}

describe("bulkTddTransition", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    ensureSpec(store, "spec-1");
    ensureSpec(store, "spec-2");
  });

  afterEach(() => {
    store.close();
  });

  it("should transition TEST_WRITTEN to RED_CONFIRMED on confirm_red", () => {
    store.setTddState({ filePath: "src/a.ts", state: "TEST_WRITTEN", specId: "spec-1", testFilePath: "src/a.test.ts" });
    store.setTddState({ filePath: "src/b.ts", state: "TEST_WRITTEN", specId: "spec-1", testFilePath: "src/b.test.ts" });

    const result = bulkTddTransition(store, "confirm_red");
    expect(result.count).toBe(2);

    const a = store.getTddState("src/a.ts");
    const b = store.getTddState("src/b.ts");
    expect(a!.state).toBe("RED_CONFIRMED");
    expect(b!.state).toBe("RED_CONFIRMED");
  });

  it("should not transition RED_CONFIRMED states on confirm_red", () => {
    store.setTddState({ filePath: "src/a.ts", state: "RED_CONFIRMED", specId: "spec-1" });
    store.setTddState({ filePath: "src/b.ts", state: "TEST_WRITTEN", specId: "spec-1" });

    const result = bulkTddTransition(store, "confirm_red");
    expect(result.count).toBe(1); // only b.ts

    const a = store.getTddState("src/a.ts");
    expect(a!.state).toBe("RED_CONFIRMED");
  });

  it("should clear RED_CONFIRMED states on confirm_green", () => {
    store.setTddState({ filePath: "src/a.ts", state: "RED_CONFIRMED", specId: "spec-1" });
    store.setTddState({ filePath: "src/b.ts", state: "RED_CONFIRMED", specId: "spec-1" });
    store.setTddState({ filePath: "src/c.ts", state: "TEST_WRITTEN", specId: "spec-1" }); // should NOT be cleared

    const result = bulkTddTransition(store, "confirm_green");
    expect(result.count).toBe(2);

    const a = store.getTddState("src/a.ts");
    const b = store.getTddState("src/b.ts");
    const c = store.getTddState("src/c.ts");
    expect(a).toBeNull(); // cleared
    expect(b).toBeNull(); // cleared
    expect(c!.state).toBe("TEST_WRITTEN"); // untouched
  });

  it("should return 0 when no matching states exist", () => {
    const result = bulkTddTransition(store, "confirm_red");
    expect(result.count).toBe(0);
  });

  it("should scope to specId when provided", () => {
    store.setTddState({ filePath: "src/a.ts", state: "TEST_WRITTEN", specId: "spec-1" });
    store.setTddState({ filePath: "src/b.ts", state: "TEST_WRITTEN", specId: "spec-2" });

    const result = bulkTddTransition(store, "confirm_red", "spec-1");
    expect(result.count).toBe(1);

    const a = store.getTddState("src/a.ts");
    const b = store.getTddState("src/b.ts");
    expect(a!.state).toBe("RED_CONFIRMED");
    expect(b!.state).toBe("TEST_WRITTEN"); // different spec, untouched
  });
});
