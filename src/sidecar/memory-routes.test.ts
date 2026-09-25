/**
 * Memory route project canonicalization (Task 10, D3).
 *
 * Reads fail OPEN: an absent/blank project means "all projects"; a SUPPLIED
 * project is canonicalized before it filters, so a raw alias (macOS `/var`,
 * a symlink, a subdirectory) still matches rows stored under the canonical key.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { writeSharedMemory } from "../memory/shared.js";
import { handleSidecarRequest } from "./routes.js";
import type { SidecarContext } from "./server.js";

async function call(
  ctx: SidecarContext,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const res = await handleSidecarRequest(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ctx,
  );
  return (await res.json()) as { ok: boolean; data?: any; error?: string };
}

describe("memory read routes — project canonicalization", () => {
  let root: string;
  let aliasHolder: string;
  let alias: string;
  let store: MemoryStore;
  let ctx: SidecarContext;
  let ids: { mine: number; other: number; mine2: number };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mem-routes-")));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
    mkdirSync(join(root, "src"));
    aliasHolder = realpathSync(mkdtempSync(join(tmpdir(), "mem-alias-")));
    symlinkSync(root, join(aliasHolder, "link"));
    alias = join(aliasHolder, "link", "src");

    store = new MemoryStore(":memory:");
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
    // Distinct timestamps: the timeline's before/after windows are strict.
    let t = Date.now() - 60_000;
    const add = (projectPath: string, title: string) =>
      ctx.service.addObservation({
        sessionId: "s1",
        projectPath,
        timestamp: (t += 1000),
        type: "discovery",
        title,
        content: "zebracanonical marker content",
        filePaths: [],
        tags: [],
        metadata: {},
      }).id;
    ids = {
      mine: add(root, "zebracanonical mine"),
      other: add("/elsewhere/project", "zebracanonical other"),
      mine2: add(root, "zebracanonical neighbour"),
    };
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(aliasHolder, { recursive: true, force: true });
  });

  it("/memory/search canonicalizes a supplied project (raw alias matches)", async () => {
    const r = await call(ctx, "/memory/search", {
      query: "zebracanonical",
      project: alias,
    });
    expect(r.ok).toBe(true);
    const found = (r.data as Array<{ id: number }>).map((o) => o.id);
    expect(found).toContain(ids.mine);
    expect(found).not.toContain(ids.other);
  }, 30_000);

  it("/memory/search with a blank project searches ALL projects", async () => {
    const r = await call(ctx, "/memory/search", {
      query: "zebracanonical",
      project: "  ",
    });
    const found = (r.data as Array<{ id: number }>).map((o) => o.id);
    expect(found).toContain(ids.mine);
    expect(found).toContain(ids.other);
  });

  it("/memory/timeline canonicalizes a supplied project", async () => {
    const r = await call(ctx, "/memory/timeline", {
      anchor: ids.mine,
      depth: 5,
      project: alias,
    });
    expect(r.ok).toBe(true);
    const all = JSON.stringify(r.data);
    // The same-project NEIGHBOUR is only returned if the filter matched.
    expect(all).toContain("zebracanonical neighbour");
    expect(all).not.toContain("zebracanonical other");
  }, 30_000);

  it("/context keys the restore by the canonical project", async () => {
    const r = await call(ctx, `/context?project=${encodeURIComponent(alias)}`);
    expect(r.ok).toBe(true);
    expect(r.data.hasMemory).toBe(true);
    expect(r.data.markdown).toContain("zebracanonical mine");
  }, 30_000);

  it("/context still rejects a missing project", async () => {
    const r = await call(ctx, "/context");
    expect(r.ok).toBe(false);
  });
});

describe("/context — storage key vs workspace (D8)", () => {
  let main: string;
  let linked: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });

  beforeEach(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), "ctx-main-")));
    git(main, "init", "-q", "-b", "main");
    git(
      main,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    linked = join(
      realpathSync(mkdtempSync(join(tmpdir(), "ctx-linked-"))),
      "wt",
    );
    git(main, "worktree", "add", "-q", linked, "-b", "feature");
    // Uncommitted shared-memory entry that exists ONLY in the linked worktree.
    writeSharedMemory(linked, [
      {
        type: "decision",
        title: "worktree-only shared decision",
        content: "uncommitted",
        tags: [],
        filePaths: [],
        createdAt: "2026-09-25",
      },
    ]);

    store = new MemoryStore(":memory:");
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
    ctx.service.addObservation({
      sessionId: "s1",
      projectPath: main,
      timestamp: Date.now() - 1000,
      type: "discovery",
      title: "canonical-main observation",
      content: "stored under the main checkout key",
      filePaths: [],
      tags: [],
      metadata: {},
    });
  });

  afterEach(() => {
    store.close();
    git(main, "worktree", "remove", "--force", linked);
    rmSync(main, { recursive: true, force: true });
    rmSync(join(linked, ".."), { recursive: true, force: true });
  });

  it("an old client sending the raw worktree cwd gets canonical memories AND the worktree's shared memory", async () => {
    const r = await call(ctx, `/context?project=${encodeURIComponent(linked)}`);
    expect(r.ok).toBe(true);
    expect(r.data.markdown).toContain("canonical-main observation");
    expect(r.data.markdown).toContain("worktree-only shared decision");
  }, 30_000);

  it("an explicit workspace param is where shared memory is read from", async () => {
    const r = await call(
      ctx,
      `/context?project=${encodeURIComponent(main)}&workspace=${encodeURIComponent(linked)}`,
    );
    expect(r.data.markdown).toContain("canonical-main observation");
    expect(r.data.markdown).toContain("worktree-only shared decision");
  }, 30_000);

  it("the identity alone (plugin before D8) still reads the main checkout's shared memory", async () => {
    const r = await call(ctx, `/context?project=${encodeURIComponent(main)}`);
    expect(r.data.markdown).toContain("canonical-main observation");
    expect(r.data.markdown).not.toContain("worktree-only shared decision");
  }, 30_000);
});

// ─── POST /observation auto-capture dedupe (hardening-sweep Task 15, D10) ──
//
// The route ALWAYS takes the service's deduped path, so an auto-capture that
// carries no client signature (every CC hook and plugin version to date) is
// still collapsed server-side.

describe("/observation — auto-capture dedupe (D10)", () => {
  let root: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mem-dedupe-")));
    store = new MemoryStore(":memory:");
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const payload = (metadata: Record<string, unknown>, content = "same") => ({
    sessionId: "s",
    projectPath: root,
    type: "fix",
    title: "Fixed issue in a.ts",
    content,
    metadata,
  });

  it("10 identical unsigned auto-captures → 1 row with occurrences 10", async () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(
        await call(ctx, "/observation", payload({ source: "auto-capture" })),
      );
    }
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.getStats().totalObservations).toBe(1);
    const id = results[0]!.data.id;
    expect(results.every((r) => r.data.id === id)).toBe(true);
    expect(results[0]!.data.deduplicated).toBe(false);
    expect(results[9]!.data.deduplicated).toBe(true);
    expect(store.getObservation(id)!.metadata.occurrences).toBe(10);
  });

  it("a manual save (mcp-tool) is never deduped and keeps the old response shape", async () => {
    const a = await call(ctx, "/observation", payload({ source: "mcp-tool" }));
    const b = await call(ctx, "/observation", payload({ source: "mcp-tool" }));
    expect(b.data.id).not.toBe(a.data.id);
    expect("deduplicated" in a.data).toBe(false);
    expect(a.data.metadata).toEqual({ source: "mcp-tool" });
    expect(store.getStats().totalObservations).toBe(2);
  });

  it("a dedupeKey collapses repeats (instructions-loaded)", async () => {
    const loaded = (content: string) => ({
      ...payload(
        { source: "instructions-loaded", dedupeKey: `${root}/CLAUDE.md` },
        content,
      ),
      type: "discovery",
      title: "Instructions loaded: CLAUDE.md",
    });
    const a = await call(ctx, "/observation", loaded("reason: session_start"));
    const b = await call(
      ctx,
      "/observation",
      loaded("reason: path_glob_match"),
    );
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.deduplicated).toBe(true);
  });
});
