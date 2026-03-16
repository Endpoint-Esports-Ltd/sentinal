/**
 * Observation Queue Tests
 *
 * Tests the offline observation queue that buffers observations
 * when the sidecar is unavailable and drains them on reconnection.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import * as queueModule from "./observation-queue.js";
import { ObservationQueue } from "./observation-queue.js";

type ObservationPayload = Parameters<typeof ObservationQueue.enqueue>[0];

function makePayload(
  overrides: Partial<ObservationPayload> = {},
): ObservationPayload {
  return {
    sessionId: "test-session",
    projectPath: "/test/project",
    type: "fix",
    title: "Test observation",
    content: "Fixed a bug",
    filePaths: ["src/foo.ts"],
    tags: ["fix"],
    metadata: { source: "auto-capture" },
    ...overrides,
  };
}

describe("ObservationQueue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `obs-q-${Date.now().toString(36)}`);
    mkdirSync(tmpDir, { recursive: true });
    spyOn(queueModule, "getQueuePath").mockReturnValue(
      join(tmpDir, "observation-queue.json"),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  // ─── Enqueue ──────────────────────────────────────────────────────────

  it("should enqueue an observation to disk", () => {
    ObservationQueue.enqueue(makePayload());

    const queuePath = queueModule.getQueuePath();
    expect(existsSync(queuePath)).toBe(true);

    const data = JSON.parse(readFileSync(queuePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe("Test observation");
  });

  it("should append to existing queue", () => {
    ObservationQueue.enqueue(makePayload({ title: "First" }));
    ObservationQueue.enqueue(makePayload({ title: "Second" }));

    const data = JSON.parse(readFileSync(queueModule.getQueuePath(), "utf-8"));
    expect(data).toHaveLength(2);
    expect(data[0].title).toBe("First");
    expect(data[1].title).toBe("Second");
  });

  it("should cap queue at 50 entries, dropping oldest", () => {
    for (let i = 0; i < 55; i++) {
      ObservationQueue.enqueue(makePayload({ title: `Obs ${i}` }));
    }

    const data = JSON.parse(readFileSync(queueModule.getQueuePath(), "utf-8"));
    expect(data).toHaveLength(50);
    // Oldest (0-4) should be dropped, 5-54 remain
    expect(data[0].title).toBe("Obs 5");
    expect(data[49].title).toBe("Obs 54");
  });

  it("should call log callback when cap is exceeded", () => {
    const logs: string[] = [];
    const logFn = (msg: string) => logs.push(msg);

    // Fill to 50
    for (let i = 0; i < 50; i++) {
      ObservationQueue.enqueue(makePayload({ title: `Obs ${i}` }));
    }
    // One more triggers cap
    ObservationQueue.enqueue(makePayload({ title: "Overflow" }), logFn);
    expect(logs.some((l) => l.includes("dropped"))).toBe(true);
  });

  it("should handle corrupted queue file gracefully", () => {
    writeFileSync(queueModule.getQueuePath(), "not valid json{{{");

    // Should not throw — starts fresh
    ObservationQueue.enqueue(makePayload({ title: "After corruption" }));

    const data = JSON.parse(readFileSync(queueModule.getQueuePath(), "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe("After corruption");
  });

  it("should handle missing queue file gracefully", () => {
    ObservationQueue.enqueue(makePayload({ title: "First ever" }));

    const data = JSON.parse(readFileSync(queueModule.getQueuePath(), "utf-8"));
    expect(data).toHaveLength(1);
  });

  // ─── Multi-project ────────────────────────────────────────────────────

  it("should store entries from different projects in same queue", () => {
    ObservationQueue.enqueue(
      makePayload({ projectPath: "/project-a", title: "From A" }),
    );
    ObservationQueue.enqueue(
      makePayload({ projectPath: "/project-b", title: "From B" }),
    );
    ObservationQueue.enqueue(
      makePayload({ projectPath: "/project-a", title: "From A again" }),
    );

    const data = JSON.parse(readFileSync(queueModule.getQueuePath(), "utf-8"));
    expect(data).toHaveLength(3);
    expect(
      data.filter((e: any) => e.projectPath === "/project-a"),
    ).toHaveLength(2);
    expect(
      data.filter((e: any) => e.projectPath === "/project-b"),
    ).toHaveLength(1);
  });

  // ─── Pending ──────────────────────────────────────────────────────────

  it("should return total pending count", () => {
    ObservationQueue.enqueue(makePayload());
    ObservationQueue.enqueue(makePayload());

    expect(ObservationQueue.pending()).toBe(2);
  });

  it("should return filtered pending count by project", () => {
    ObservationQueue.enqueue(makePayload({ projectPath: "/a" }));
    ObservationQueue.enqueue(makePayload({ projectPath: "/b" }));
    ObservationQueue.enqueue(makePayload({ projectPath: "/a" }));

    expect(ObservationQueue.pending("/a")).toBe(2);
    expect(ObservationQueue.pending("/b")).toBe(1);
    expect(ObservationQueue.pending("/c")).toBe(0);
  });

  it("should return 0 when queue file does not exist", () => {
    expect(ObservationQueue.pending()).toBe(0);
  });

  // ─── Drain ────────────────────────────────────────────────────────────

  it("should drain all entries via sendFn and clear queue", async () => {
    ObservationQueue.enqueue(makePayload({ title: "One" }));
    ObservationQueue.enqueue(makePayload({ title: "Two" }));

    const sent: string[] = [];
    const result = await ObservationQueue.drain(async (obs) => {
      sent.push(obs.title);
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(sent).toEqual(["One", "Two"]);

    // Queue file should be empty or deleted
    expect(ObservationQueue.pending()).toBe(0);
  });

  it("should handle partial failures — keep failed entries", async () => {
    ObservationQueue.enqueue(makePayload({ title: "Success" }));
    ObservationQueue.enqueue(makePayload({ title: "Fail" }));
    ObservationQueue.enqueue(makePayload({ title: "Success2" }));

    const result = await ObservationQueue.drain(async (obs) => {
      if (obs.title === "Fail") throw new Error("sidecar down");
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);

    // Failed entry should remain in queue
    const remaining = JSON.parse(
      readFileSync(queueModule.getQueuePath(), "utf-8"),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("Fail");
  });

  it("should drain entries from multiple projects", async () => {
    ObservationQueue.enqueue(makePayload({ projectPath: "/a", title: "A1" }));
    ObservationQueue.enqueue(makePayload({ projectPath: "/b", title: "B1" }));

    const sent: string[] = [];
    const result = await ObservationQueue.drain(async (obs) => {
      sent.push(`${obs.projectPath}:${obs.title}`);
    });

    expect(result.sent).toBe(2);
    expect(sent).toEqual(["/a:A1", "/b:B1"]);
  });

  it("should return zeros when queue is empty", async () => {
    const result = await ObservationQueue.drain(async () => {});

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it("should handle corrupted queue during drain", async () => {
    writeFileSync(queueModule.getQueuePath(), "corrupt!!!");

    const result = await ObservationQueue.drain(async () => {});

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
  });
});
