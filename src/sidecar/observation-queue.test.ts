/**
 * Observation Queue Tests (M11 — dir-as-queue)
 *
 * The queue is a DIRECTORY of one-file-per-observation entries
 * (`wx`-created, name = zero-padded timestamp + per-process sequence +
 * random suffix), so:
 *  - enqueue is a single atomic file create — a concurrent drain can never
 *    overwrite it (Truth 17)
 *  - drain unlinks each entry individually on success and leaves it on failure
 *  - the legacy single-file spool (`observation-queue.json`) is migrated once
 *    (entries ingested as individual files, spool deleted)
 *
 * All tests redirect the tree via SENTINAL_HOME (read fresh on every call).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import {
  ObservationQueue,
  getQueueDir,
  getQueuePath,
} from "./observation-queue.js";

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

/** Read every entry file in FIFO (name-sorted) order. */
function readEntries(): ObservationPayload[] {
  const dir = getQueueDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

describe("ObservationQueue (dir-as-queue)", () => {
  let savedHome: string | undefined;
  let scratchHome: string;

  beforeEach(() => {
    savedHome = process.env.SENTINAL_HOME;
    scratchHome = mkdtempSync(join(tmpdir(), "obs-q-"));
    process.env.SENTINAL_HOME = scratchHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  // ─── Enqueue ──────────────────────────────────────────────────────────

  it("enqueues one file per observation into the queue dir", () => {
    ObservationQueue.enqueue(makePayload());

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Test observation");
  });

  it("preserves FIFO order across rapid enqueues (same-ms safe)", () => {
    ObservationQueue.enqueue(makePayload({ title: "First" }));
    ObservationQueue.enqueue(makePayload({ title: "Second" }));
    ObservationQueue.enqueue(makePayload({ title: "Third" }));

    expect(readEntries().map((e) => e.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("caps the queue at 50 entries, dropping oldest", () => {
    for (let i = 0; i < 55; i++) {
      ObservationQueue.enqueue(makePayload({ title: `Obs ${i}` }));
    }

    const entries = readEntries();
    expect(entries).toHaveLength(50);
    expect(entries[0]!.title).toBe("Obs 5");
    expect(entries[49]!.title).toBe("Obs 54");
  });

  it("calls the log callback when the cap is exceeded", () => {
    const logs: string[] = [];
    for (let i = 0; i < 50; i++) {
      ObservationQueue.enqueue(makePayload({ title: `Obs ${i}` }));
    }
    ObservationQueue.enqueue(makePayload({ title: "Overflow" }), (m) =>
      logs.push(m),
    );
    expect(logs.some((l) => l.includes("dropped"))).toBe(true);
  });

  it("never throws when the queue dir is not creatable", () => {
    process.env.SENTINAL_HOME = "/dev/null/not-a-dir";
    expect(() => ObservationQueue.enqueue(makePayload())).not.toThrow();
  });

  // ─── Legacy single-file spool migration ───────────────────────────────

  it("migrates the legacy spool file into individual entries, then deletes it", () => {
    writeFileSync(
      getQueuePath(),
      JSON.stringify([
        makePayload({ title: "Legacy 1" }),
        makePayload({ title: "Legacy 2" }),
      ]),
      "utf-8",
    );

    ObservationQueue.enqueue(makePayload({ title: "New" }));

    expect(existsSync(getQueuePath())).toBe(false);
    expect(readEntries().map((e) => e.title)).toEqual([
      "Legacy 1",
      "Legacy 2",
      "New",
    ]);
  });

  it("counts legacy entries via pending() after migration", () => {
    writeFileSync(
      getQueuePath(),
      JSON.stringify([makePayload({ title: "Legacy" })]),
      "utf-8",
    );
    expect(ObservationQueue.pending()).toBe(1);
    expect(existsSync(getQueuePath())).toBe(false);
  });

  it("drains legacy entries after migration", async () => {
    writeFileSync(
      getQueuePath(),
      JSON.stringify([makePayload({ title: "Legacy" })]),
      "utf-8",
    );
    const sent: string[] = [];
    const result = await ObservationQueue.drain(async (obs) => {
      sent.push(obs.title);
    });
    expect(result.sent).toBe(1);
    expect(sent).toEqual(["Legacy"]);
    expect(existsSync(getQueuePath())).toBe(false);
  });

  it("discards a corrupt legacy spool without throwing", () => {
    writeFileSync(getQueuePath(), "not valid json{{{", "utf-8");
    ObservationQueue.enqueue(makePayload({ title: "After corruption" }));
    expect(existsSync(getQueuePath())).toBe(false);
    expect(readEntries().map((e) => e.title)).toEqual(["After corruption"]);
  });

  // ─── Pending ──────────────────────────────────────────────────────────

  it("pending() counts all entries", () => {
    ObservationQueue.enqueue(makePayload());
    ObservationQueue.enqueue(makePayload());
    expect(ObservationQueue.pending()).toBe(2);
  });

  it("pending(projectPath) filters by project", () => {
    ObservationQueue.enqueue(makePayload({ projectPath: "/a" }));
    ObservationQueue.enqueue(makePayload({ projectPath: "/b" }));
    ObservationQueue.enqueue(makePayload({ projectPath: "/a" }));

    expect(ObservationQueue.pending("/a")).toBe(2);
    expect(ObservationQueue.pending("/b")).toBe(1);
    expect(ObservationQueue.pending("/c")).toBe(0);
  });

  it("pending() is 0 when nothing was ever enqueued", () => {
    expect(ObservationQueue.pending()).toBe(0);
  });

  // ─── Drain ────────────────────────────────────────────────────────────

  it("drains all entries in FIFO order and unlinks them", async () => {
    ObservationQueue.enqueue(makePayload({ title: "One" }));
    ObservationQueue.enqueue(makePayload({ title: "Two" }));

    const sent: string[] = [];
    const result = await ObservationQueue.drain(async (obs) => {
      sent.push(obs.title);
    });

    expect(result).toEqual({ sent: 2, failed: 0, remaining: 0 });
    expect(sent).toEqual(["One", "Two"]);
    expect(ObservationQueue.pending()).toBe(0);
  });

  it("keeps failed entries on disk for the next drain", async () => {
    ObservationQueue.enqueue(makePayload({ title: "Success" }));
    ObservationQueue.enqueue(makePayload({ title: "Fail" }));
    ObservationQueue.enqueue(makePayload({ title: "Success2" }));

    const result = await ObservationQueue.drain(async (obs) => {
      if (obs.title === "Fail") throw new Error("send failed");
    });

    expect(result).toEqual({ sent: 2, failed: 1, remaining: 1 });
    expect(readEntries().map((e) => e.title)).toEqual(["Fail"]);
  });

  it("returns zeros on an empty queue", async () => {
    const result = await ObservationQueue.drain(async () => {});
    expect(result).toEqual({ sent: 0, failed: 0, remaining: 0 });
  });

  it("drops a corrupt entry file instead of wedging the drain", async () => {
    ObservationQueue.enqueue(makePayload({ title: "Good" }));
    mkdirSync(getQueueDir(), { recursive: true });
    writeFileSync(join(getQueueDir(), "zzz-corrupt.json"), "corrupt!!!");

    const result = await ObservationQueue.drain(async () => {});
    expect(result.sent).toBe(1);
    expect(ObservationQueue.pending()).toBe(0);
  });

  it("never rejects when the queue dir is not creatable", async () => {
    process.env.SENTINAL_HOME = "/dev/null/not-a-dir";
    await expect(ObservationQueue.drain(async () => {})).resolves.toEqual({
      sent: 0,
      failed: 0,
      remaining: 0,
    });
  });

  // ─── Truth 17: enqueue interleaved into a drain survives ─────────────
  //
  // Deterministic same-process interleaving (chosen over a spawned
  // cross-process race, which is timing-dependent and flaky): the shared
  // state IS the filesystem, and the atomic property under test — enqueue
  // creates a distinct file; drain only unlinks files it actually
  // processed — is fully exercised by interleaving through the drain's
  // async sendFn. The old single-file queue fails this test: the drain's
  // final whole-file write-back overwrote the mid-drain enqueue.

  it("an enqueue interleaved into a drain is not lost (Truth 17)", async () => {
    ObservationQueue.enqueue(makePayload({ title: "A" }));
    ObservationQueue.enqueue(makePayload({ title: "B" }));

    const sent: string[] = [];
    await ObservationQueue.drain(async (obs) => {
      sent.push(obs.title);
      if (obs.title === "A") {
        // Interleaved writer (another process, conceptually)
        ObservationQueue.enqueue(makePayload({ title: "Mid-drain" }));
      }
    });

    expect(sent).toEqual(["A", "B"]);
    // The interleaved observation must survive the drain…
    expect(ObservationQueue.pending()).toBe(1);
    expect(readEntries().map((e) => e.title)).toEqual(["Mid-drain"]);

    // …and be delivered by the next drain.
    const second = await ObservationQueue.drain(async (obs) => {
      sent.push(obs.title);
    });
    expect(second.sent).toBe(1);
    expect(sent).toEqual(["A", "B", "Mid-drain"]);
  });

  it("two enqueues in the same millisecond both survive (unique names)", () => {
    // Same-ms uniqueness comes from the per-process sequence + random
    // suffix; hammer enough enqueues to guarantee same-ms collisions.
    for (let i = 0; i < 20; i++) {
      ObservationQueue.enqueue(makePayload({ title: `Burst ${i}` }));
    }
    expect(ObservationQueue.pending()).toBe(20);
  });
});
