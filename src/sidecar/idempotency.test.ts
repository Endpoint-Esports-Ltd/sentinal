/**
 * Idempotency for destructive sidecar routes (issue #9).
 *
 * The reported failure mode: a destructive `worktree_cleanup` completed
 * server-side, the CLIENT timed out, the caller was told it had failed, and so
 * the caller retried — twice. For `cleanup` a repeat happens to be harmless
 * (nothing is left to delete), but the same client path fronts
 * `POST /worktree/sync` (squash merge) and `POST /worktree/abandon`, where a
 * double-execute is not harmless.
 *
 * Task 1 makes the error honest ("outcome unknown") and Task 4 makes the
 * outcome reconcilable. This closes the loop: a retry carrying the SAME key
 * replays the first result instead of doing the work again.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { makeTmpDir } from "../test-helpers.js";
import {
  withIdempotency,
  withIdempotencyAsync,
  IDEMPOTENCY_TTL_MS,
} from "./idempotency.js";

describe("withIdempotency", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes the operation when no key is supplied", () => {
    let runs = 0;
    const a = withIdempotency(store, "cleanup", undefined, () => {
      runs++;
      return { cleaned: 1 };
    });
    const b = withIdempotency(store, "cleanup", undefined, () => {
      runs++;
      return { cleaned: 1 };
    });

    // No key means no promise of idempotency — behaviour is exactly as before.
    expect(runs).toBe(2);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it("executes once and replays the SAME result for a repeated key", () => {
    let runs = 0;
    const op = () => {
      runs++;
      return { cleaned: 7, removed: ["/a", "/b"] };
    };

    const first = withIdempotency(store, "cleanup", "key-1", op);
    const second = withIdempotency(store, "cleanup", "key-1", op);

    expect(runs).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // The replay must carry the ORIGINAL outcome, not an empty one — that is
    // the entire point: the caller learns what the first call did.
    expect(second.result).toEqual(first.result);
    expect(second.result).toEqual({ cleaned: 7, removed: ["/a", "/b"] });
  });

  it("executes again for a DIFFERENT key", () => {
    let runs = 0;
    const op = () => {
      runs++;
      return { cleaned: runs };
    };

    withIdempotency(store, "cleanup", "key-a", op);
    const second = withIdempotency(store, "cleanup", "key-b", op);

    expect(runs).toBe(2);
    expect(second.replayed).toBe(false);
  });

  it("scopes keys per operation — the same key on a different op re-executes", () => {
    let runs = 0;
    const op = () => {
      runs++;
      return { ok: true };
    };

    withIdempotency(store, "cleanup", "shared", op);
    const other = withIdempotency(store, "abandon", "shared", op);

    // Otherwise a caller reusing a request id across operations would get a
    // cleanup's result back from an abandon.
    expect(runs).toBe(2);
    expect(other.replayed).toBe(false);
  });

  it("re-executes once the record has expired", () => {
    let runs = 0;
    const op = () => {
      runs++;
      return { cleaned: runs };
    };

    withIdempotency(store, "cleanup", "aging", op);
    // Age the record past the TTL by rewriting it with an old timestamp.
    const raw = store.getSetting("idem:cleanup:aging")!;
    const parsed = JSON.parse(raw) as { at: number; result: unknown };
    store.setSetting(
      "idem:cleanup:aging",
      JSON.stringify({
        ...parsed,
        at: Date.now() - IDEMPOTENCY_TTL_MS - 1_000,
      }),
    );

    const second = withIdempotency(store, "cleanup", "aging", op);
    expect(runs).toBe(2);
    expect(second.replayed).toBe(false);
  });

  it("does NOT record a result when the operation throws", () => {
    let runs = 0;
    const boom = () => {
      runs++;
      throw new Error("git exploded");
    };

    expect(() => withIdempotency(store, "cleanup", "fails", boom)).toThrow(
      "git exploded",
    );
    // A failed operation must remain retryable — caching the failure would
    // make a transient git error permanent for the TTL.
    expect(store.getSetting("idem:cleanup:fails")).toBeNull();

    expect(() => withIdempotency(store, "cleanup", "fails", boom)).toThrow();
    expect(runs).toBe(2);
  });

  it("survives a corrupt record by re-executing rather than throwing", () => {
    store.setSetting("idem:cleanup:corrupt", "{not json");
    let runs = 0;
    const res = withIdempotency(store, "cleanup", "corrupt", () => {
      runs++;
      return { cleaned: 0 };
    });
    expect(runs).toBe(1);
    expect(res.replayed).toBe(false);
  });
});

// `abandon` stops a process group and removes a directory, and it is async —
// so the sync wrapper cannot guard it. A double-abandon is NOT harmless the way
// a double-cleanup is, which is why this variant exists.
describe("withIdempotencyAsync", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("awaits and executes once for a repeated key", async () => {
    let runs = 0;
    const op = async () => {
      runs++;
      await Bun.sleep(1);
      return { status: "abandoned" };
    };

    const first = await withIdempotencyAsync(store, "abandon", "k", op);
    const second = await withIdempotencyAsync(store, "abandon", "k", op);

    expect(runs).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ status: "abandoned" });
  });

  it("does NOT record a REJECTED operation", async () => {
    let runs = 0;
    const op = async () => {
      runs++;
      await Bun.sleep(1);
      throw new Error("stop refused");
    };

    await expect(
      withIdempotencyAsync(store, "abandon", "bad", op),
    ).rejects.toThrow("stop refused");
    expect(store.getSetting("idem:abandon:bad")).toBeNull();

    // ⛔ Critical: a REFUSED abandon (e.g. RUNTIME_STOP_FAILED) must stay
    // retryable. Recording it would make the refusal permanent for the TTL.
    await expect(
      withIdempotencyAsync(store, "abandon", "bad", op),
    ).rejects.toThrow();
    expect(runs).toBe(2);
  });

  it("runs every time when no key is supplied", async () => {
    let runs = 0;
    const op = async () => {
      runs++;
      return 1;
    };
    await withIdempotencyAsync(store, "abandon", undefined, op);
    await withIdempotencyAsync(store, "abandon", undefined, op);
    expect(runs).toBe(2);
  });
});
