/**
 * Slot allocator (Phase 2, Task 3) + emergent slot release (Task 4).
 *
 * Slots are allocated from the CLOSED range [1, maxActive]. Slot 0 is reserved
 * for the developer's main checkout (D7) and is never handed out.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import {
  MAIN_CHECKOUT_SLOT,
  FIRST_ALLOCATABLE_SLOT,
  SLOT_ENV_RELATIVE_PATH,
  SLOT_ENV_VAR,
  findFreeSlot,
  allocateSlot,
  tryAllocateSlot,
  insertWithSlot,
  readSlotFromWorktree,
  formatSlot,
} from "./slots.js";
import { WorktreeError, type Worktree, type WorktreeStatus } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let n = 0;
function wtInput(
  overrides: Partial<Worktree> = {},
): Omit<Worktree, "mergedAt" | "mergeCommit" | "slot"> {
  const id = `wt-${++n}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    specId: undefined,
    projectPath: "/proj/a",
    worktreePath: `/proj/a/.sentinal/worktrees/${id}`,
    branchName: `sentinal/spec-${id}`,
    baseBranch: "main",
    baseCommit: "abc123def456",
    status: "active" as WorktreeStatus,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("slots", () => {
  let tmpDir: string;
  let dbPath: string;
  let memoryStore: MemoryStore;
  let store: WorktreeStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, "test.db");
    memoryStore = new MemoryStore(dbPath);
    store = new WorktreeStore(memoryStore);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── D7: slot 0 is reserved ──────────────────────────────────────────────

  describe("D7 — slot 0 reserved for the main checkout", () => {
    it("declares 0 reserved and 1 as the first allocatable slot", () => {
      expect(MAIN_CHECKOUT_SLOT).toBe(0);
      expect(FIRST_ALLOCATABLE_SLOT).toBe(1);
    });

    it("findFreeSlot never returns 0, even when nothing is taken", () => {
      expect(findFreeSlot([], 5)).toBe(1);
      expect(findFreeSlot([1, 2, 3, 4], 5)).toBe(5);
    });

    it("allocateSlot never returns 0 across a full pool lifetime", () => {
      const seen: number[] = [];
      for (let i = 0; i < 5; i++) {
        const s = allocateSlot(store, "/proj/a", 5);
        seen.push(s);
        insertWithSlot(store, wtInput(), 5);
      }
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      expect(seen).not.toContain(MAIN_CHECKOUT_SLOT);
    });

    it("capacity is unchanged by the reservation — maxActive 3 yields slots 1..3", () => {
      expect(findFreeSlot([], 3)).toBe(1);
      expect(findFreeSlot([1], 3)).toBe(2);
      expect(findFreeSlot([1, 2], 3)).toBe(3);
      expect(findFreeSlot([1, 2, 3], 3)).toBeNull();
      // 0 being taken or free is irrelevant — it is never in the pool.
      expect(findFreeSlot([0], 3)).toBe(1);
    });
  });

  // ── Allocation ──────────────────────────────────────────────────────────

  describe("allocateSlot", () => {
    it("hands out the LOWEST free slot", () => {
      insertWithSlot(store, wtInput(), 5); // 1
      insertWithSlot(store, wtInput(), 5); // 2
      const wt2 = store.listForProject("/proj/a").find((w) => w.slot === 2)!;
      store.updateStatus(wt2.id, "abandoned");
      expect(allocateSlot(store, "/proj/a", 5)).toBe(2);
    });

    it("gives two worktrees in one project distinct slots", () => {
      const a = insertWithSlot(store, wtInput(), 5);
      const b = insertWithSlot(store, wtInput(), 5);
      expect(a.slot).toBe(1);
      expect(b.slot).toBe(2);
      expect(a.slot).not.toBe(b.slot);
    });

    it("lets two DIFFERENT projects both hold slot 1 (D2)", () => {
      const a = insertWithSlot(store, wtInput({ projectPath: "/proj/a" }), 5);
      const b = insertWithSlot(store, wtInput({ projectPath: "/proj/b" }), 5);
      expect(a.slot).toBe(1);
      expect(b.slot).toBe(1);
    });

    it("counts ready-to-merge as LIVE — its slot is not reallocated", () => {
      const a = insertWithSlot(store, wtInput(), 5);
      store.updateStatus(a.id, "ready-to-merge");
      expect(allocateSlot(store, "/proj/a", 5)).toBe(2);
    });

    it("throws a typed SLOT_EXHAUSTED naming worktree_cleanup when the pool is full", () => {
      for (let i = 0; i < 3; i++) insertWithSlot(store, wtInput(), 3);
      let caught: unknown;
      try {
        allocateSlot(store, "/proj/a", 3);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WorktreeError);
      expect((caught as WorktreeError).code).toBe("SLOT_EXHAUSTED");
      expect((caught as WorktreeError).message).toContain("worktree_cleanup");
    });

    it("tryAllocateSlot returns null instead of throwing when the pool is full", () => {
      for (let i = 0; i < 3; i++) insertWithSlot(store, wtInput(), 3);
      expect(tryAllocateSlot(store, "/proj/a", 3)).toBeNull();
    });
  });

  // ── Persistence + cross-connection state ────────────────────────────────

  describe("persistence", () => {
    it("round-trips the slot through insert → get", () => {
      const a = insertWithSlot(store, wtInput(), 5);
      expect(store.get(a.id)!.slot).toBe(1);
    });

    it("keeps allocator state in SQLite, not instance memory (sidecar builds a fresh manager per request)", () => {
      insertWithSlot(store, wtInput(), 5);
      // A completely separate connection over the same DB file.
      const other = new MemoryStore(dbPath);
      try {
        const otherStore = new WorktreeStore(other);
        expect(otherStore.listLiveSlots("/proj/a")).toEqual([1]);
        expect(allocateSlot(otherStore, "/proj/a", 5)).toBe(2);
      } finally {
        other.close();
      }
    });

    it("listLiveSlots ignores terminal rows and NULL slots", () => {
      const a = insertWithSlot(store, wtInput(), 5);
      const b = insertWithSlot(store, wtInput(), 5);
      insertWithSlot(store, wtInput(), 5, {
        onExhausted: "null",
        forceNull: true,
      });
      store.updateStatus(b.id, "merged");
      expect(store.listLiveSlots("/proj/a")).toEqual([a.slot!]);
    });
  });

  // ── Atomicity / lost races ──────────────────────────────────────────────

  describe("allocate + insert atomicity", () => {
    it("rolls the slot back when the insert fails (the slot is reusable)", () => {
      insertWithSlot(store, wtInput(), 5); // slot 1
      const dup = wtInput();
      insertWithSlot(store, dup, 5); // slot 2
      // Re-inserting the same primary key fails for a reason unrelated to slots.
      expect(() => insertWithSlot(store, dup, 5)).toThrow();
      // Slot 3 must still be the next free one — nothing was leaked.
      expect(allocateSlot(store, "/proj/a", 5)).toBe(3);
    });

    /**
     * Model a real lost race deterministically.
     *
     * A genuine race cannot be staged inside the IMMEDIATE transaction — the
     * write lock makes a second connection fail with SQLITE_BUSY, which is the
     * lock doing its job. The realistic sequence is: a competing process
     * commits BEFORE we take the lock, and our snapshot of free slots is stale.
     * So the competitor inserts from a second connection just before
     * `runImmediate`, and `listLiveSlots` returns the stale (pre-commit) view.
     */
    function staleSnapshotSpy(
      otherStore: WorktreeStore,
      raceEveryAttempt: boolean,
    ): { spy: WorktreeStore; attempts: () => number } {
      let attempts = 0;
      let racerInserted = false;
      const spy = new Proxy(store, {
        get(target, prop, recv) {
          if (prop === "runImmediate") {
            return <T>(fn: () => T): T => {
              attempts++;
              if (!racerInserted) {
                racerInserted = true;
                otherStore.insert({ ...wtInput(), slot: 1 });
              }
              return target.runImmediate(fn);
            };
          }
          if (prop === "listLiveSlots") {
            return (p: string) =>
              raceEveryAttempt || attempts === 1 ? [] : target.listLiveSlots(p);
          }
          return Reflect.get(target, prop, recv);
        },
      }) as unknown as WorktreeStore;
      return { spy, attempts: () => attempts };
    }

    it("retries a LOST RACE and still produces a distinct slot — never SLOT_EXHAUSTED", () => {
      const other = new MemoryStore(dbPath);
      try {
        const { spy, attempts } = staleSnapshotSpy(
          new WorktreeStore(other),
          false,
        );
        const wt = insertWithSlot(spy, wtInput(), 5);
        expect(attempts()).toBe(2); // first attempt lost, second won
        expect(wt.slot).toBe(2); // the racer took 1
        expect(store.listLiveSlots("/proj/a")).toEqual([1, 2]);
      } finally {
        other.close();
      }
    });

    it("surfaces SLOT_RACE (not SLOT_EXHAUSTED) when every retry loses", () => {
      const other = new MemoryStore(dbPath);
      let caught: unknown;
      try {
        const { spy, attempts } = staleSnapshotSpy(
          new WorktreeStore(other),
          true,
        );
        try {
          insertWithSlot(spy, wtInput(), 5);
        } catch (e) {
          caught = e;
        }
        expect(attempts()).toBe(3); // bounded retry, not an infinite loop
      } finally {
        other.close();
      }
      expect(caught).toBeInstanceOf(WorktreeError);
      // A lost race is transient. Telling the user to run worktree_cleanup
      // would have them delete HEALTHY worktrees to fix a self-resolving state.
      expect((caught as WorktreeError).code).toBe("SLOT_RACE");
      expect((caught as WorktreeError).message).not.toContain(
        "worktree_cleanup",
      );
    });
  });

  // ── Recovery source: the worktree's own env file ─────────────────────────

  describe("readSlotFromWorktree", () => {
    it("reads the slot the directory's own config was written against", () => {
      const dir = join(tmpDir, "wt");
      mkdirSync(join(dir, ".sentinal"), { recursive: true });
      writeFileSync(
        join(dir, SLOT_ENV_RELATIVE_PATH),
        `# sentinal\n${SLOT_ENV_VAR}=4\n`,
      );
      expect(readSlotFromWorktree(dir)).toBe(4);
    });

    it("returns null when the file is missing, unparseable, or out of range", () => {
      const dir = join(tmpDir, "wt2");
      mkdirSync(join(dir, ".sentinal"), { recursive: true });
      expect(readSlotFromWorktree(dir)).toBeNull();

      writeFileSync(join(dir, SLOT_ENV_RELATIVE_PATH), "NOTHING=1\n");
      expect(readSlotFromWorktree(dir)).toBeNull();

      writeFileSync(join(dir, SLOT_ENV_RELATIVE_PATH), `${SLOT_ENV_VAR}=abc\n`);
      expect(readSlotFromWorktree(dir)).toBeNull();

      // Slot 0 is reserved — never accept it from disk.
      writeFileSync(join(dir, SLOT_ENV_RELATIVE_PATH), `${SLOT_ENV_VAR}=0\n`);
      expect(readSlotFromWorktree(dir)).toBeNull();
    });
  });

  // ── Preferred-slot recovery ─────────────────────────────────────────────

  describe("preferred slot", () => {
    it("honours a free preferred slot instead of the lowest free one", () => {
      const wt = insertWithSlot(store, wtInput(), 5, { preferred: 4 });
      expect(wt.slot).toBe(4);
    });

    it("falls back to the lowest free slot when the preferred one is taken", () => {
      insertWithSlot(store, wtInput(), 5, { preferred: 4 });
      const wt = insertWithSlot(store, wtInput(), 5, { preferred: 4 });
      expect(wt.slot).toBe(1);
    });

    it("ignores an out-of-range or reserved preferred slot", () => {
      expect(insertWithSlot(store, wtInput(), 3, { preferred: 0 }).slot).toBe(
        1,
      );
      expect(insertWithSlot(store, wtInput(), 3, { preferred: 99 }).slot).toBe(
        2,
      );
    });
  });

  // ── onExhausted: "null" — the detect/read path must never hard-fail ─────

  describe("onExhausted: null (read paths)", () => {
    it("inserts with slot = null and records a warning instead of throwing", () => {
      for (let i = 0; i < 3; i++) insertWithSlot(store, wtInput(), 3);
      const warnings: string[] = [];
      const wt = insertWithSlot(store, wtInput(), 3, {
        onExhausted: "null",
        warnings,
      });
      expect(wt.slot).toBeNull();
      expect(warnings.join("\n")).toContain("slot");
      expect(warnings.join("\n")).toContain("worktree_cleanup");
    });
  });

  // ── Task 4: release is EMERGENT from the index predicate ────────────────

  describe("Task 4 — emergent release (no code releases a slot)", () => {
    it("frees the slot when a row becomes abandoned", () => {
      const a = insertWithSlot(store, wtInput(), 3);
      store.updateStatus(a.id, "abandoned");
      expect(store.listLiveSlots("/proj/a")).toEqual([]);
      expect(insertWithSlot(store, wtInput(), 3).slot).toBe(1);
    });

    it("frees the slot when a row becomes merged", () => {
      const a = insertWithSlot(store, wtInput(), 3);
      store.updateStatus(a.id, "merged", "deadbeef");
      expect(store.listLiveSlots("/proj/a")).toEqual([]);
      expect(insertWithSlot(store, wtInput(), 3).slot).toBe(1);
    });

    it("frees the slot when the row is DELETED outright (store.delete)", () => {
      const a = insertWithSlot(store, wtInput(), 3);
      expect(store.delete(a.id)).toBe(true);
      expect(store.listLiveSlots("/proj/a")).toEqual([]);
      expect(insertWithSlot(store, wtInput(), 3).slot).toBe(1);
    });

    it("⛔ does NOT free the slot of a ready-to-merge worktree — it is still live on disk", () => {
      const a = insertWithSlot(store, wtInput(), 3);
      store.updateStatus(a.id, "ready-to-merge");

      // The slot stays taken...
      expect(store.listLiveSlots("/proj/a")).toEqual([1]);
      // ...the next allocation must NOT collide with it...
      expect(insertWithSlot(store, wtInput(), 3).slot).toBe(2);
      // ...and the DB itself refuses a colliding insert.
      expect(() =>
        store.insert({ ...wtInput(), status: "ready-to-merge", slot: 1 }),
      ).toThrow();
      // The record of which slot it holds is preserved, not nulled.
      expect(store.get(a.id)!.slot).toBe(1);
    });

    it("preserves the slot value on terminal rows (needed for reconcile recovery)", () => {
      const a = insertWithSlot(store, wtInput(), 3);
      store.updateStatus(a.id, "abandoned");
      // ⛔ Writing `SET slot = NULL` on release would destroy this.
      expect(store.get(a.id)!.slot).toBe(1);
    });
  });
});

// ─── Rendering (D1 surfacing) ────────────────────────────────────────────────

describe("formatSlot", () => {
  it("renders an allocated slot and states the slot-0 convention", () => {
    expect(formatSlot(3)).toBe("3 (slot 0 is the main checkout)");
  });

  it("⛔ NEVER renders the word `null` for an unassigned slot", () => {
    // A bare "null" in tool output reads as a bug, not as a documented state —
    // and hides the fact that the worktree's runtime is not namespaced.
    for (const v of [null, undefined]) {
      expect(formatSlot(v)).toBe(
        "not assigned (pre-V12 record, or no free slot — see warnings)",
      );
      expect(formatSlot(v)).not.toContain("null");
    }
  });

  it("⛔ does NOT attribute an unassigned slot to a pre-V12 record alone", () => {
    // `slot = null` has a SECOND origin this phase introduces deliberately:
    // an exhausted pool or a lost race on the reconcile/detect path. Naming
    // only "pre-V12" tells a user whose worktree is five minutes old a false
    // cause, and points them at no remedy.
    expect(formatSlot(null)).toContain("no free slot");
    expect(formatSlot(null)).toContain("warnings");
  });

  it("renders slot 0 honestly if one is ever encountered", () => {
    // The allocator never hands out 0, but a hand-edited DB might contain it.
    expect(formatSlot(0)).toContain("0");
    expect(formatSlot(0)).toContain("main checkout");
  });
});
