/**
 * Worktree Sidecar Routes Tests
 *
 * Tests for the worktree sidecar route handler:
 *   - GET /worktree/resolve — find worktree by slug
 *   - POST /worktree/abandon — abandon a worktree by ID
 *   - POST /worktree/cleanup — clean up stale worktrees
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { WorktreeManager } from "../worktree/manager.js";
import { handleWorktreeRequest } from "./worktree-routes.js";
import type { SidecarContext } from "./server.js";
import { makeTmpDir } from "../test-helpers.js";

/** Create a temp git repo with an initial commit. */
function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: dir });
}

function makeCtx(store: MemoryStore): SidecarContext {
  return {
    store,
    service: new MemoryService(store),
    specStore: new SpecStore(store),
    wtStore: new WorktreeStore(store),
    httpPort: 0,
  };
}

describe("worktree-routes", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = makeCtx(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── GET /worktree/resolve ─────────────────────────────────────────────

  describe("GET /worktree/resolve", () => {
    it("should return null for unknown slug", async () => {
      const req = new Request(
        "http://localhost/worktree/resolve?slug=nonexistent",
        { method: "GET" },
      );
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).not.toBeNull();
      const body = (await res!.json()) as { ok: boolean; data: null };
      expect(body.ok).toBe(true);
      expect(body.data).toBeNull();
    });

    it("should return 400 when slug is missing", async () => {
      const req = new Request("http://localhost/worktree/resolve", {
        method: "GET",
      });
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });

    it("should return null for non-matching paths", async () => {
      const req = new Request("http://localhost/other-path", { method: "GET" });
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).toBeNull();
    });

    it("should reconcile against disk when the index lost the record", async () => {
      // Real git repo with a worktree created via the default config
      const repoDir = join(tmpDir, "repo");
      mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir);

      const manager = new WorktreeManager(ctx.wtStore);
      const wt = manager.create("2026-06-09-route-drift", repoDir);
      // Simulate drift: DB record lost (e.g. transport failure mid-create)
      ctx.wtStore.delete(wt.id);

      const req = new Request(
        `http://localhost/worktree/resolve?slug=2026-06-09-route-drift&project=${encodeURIComponent(repoDir)}`,
        { method: "GET" },
      );
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).not.toBeNull();
      const body = (await res!.json()) as {
        ok: boolean;
        data: { branchName: string; status: string } | null;
      };
      expect(body.ok).toBe(true);
      expect(body.data).not.toBeNull();
      expect(body.data!.branchName).toBe(wt.branchName);
      expect(body.data!.status).toBe("active");
    });

    it("should self-heal when the directory is gone (client-mode parity)", async () => {
      const repoDir = join(tmpDir, "repo2");
      mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir);

      const manager = new WorktreeManager(ctx.wtStore);
      const wt = manager.create("2026-06-09-route-gone", repoDir);
      rmSync(wt.worktreePath, { recursive: true, force: true });
      Bun.spawnSync(["git", "worktree", "prune"], { cwd: repoDir });
      Bun.spawnSync(["git", "branch", "-D", wt.branchName], { cwd: repoDir });

      const req = new Request(
        `http://localhost/worktree/resolve?slug=2026-06-09-route-gone&project=${encodeURIComponent(repoDir)}`,
        { method: "GET" },
      );
      const res = await handleWorktreeRequest(req, ctx);
      const body = (await res!.json()) as { ok: boolean; data: null };
      expect(body.ok).toBe(true);
      expect(body.data).toBeNull();
      expect(ctx.wtStore.get(wt.id)!.status).toBe("abandoned");
    });
  });

  // ─── POST /worktree/abandon ────────────────────────────────────────────

  describe("POST /worktree/abandon", () => {
    it("should return 400 when worktree_id is missing", async () => {
      const req = new Request("http://localhost/worktree/abandon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });

    it("should return 404 when worktree ID does not exist", async () => {
      const req = new Request("http://localhost/worktree/abandon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktree_id: "nonexistent-id" }),
      });
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(404);
    });

    it("should abandon a worktree and return ok", async () => {
      // Insert a worktree record
      const wtPath = join(tmpDir, ".worktrees", "abandon-test");
      mkdirSync(wtPath, { recursive: true });
      ctx.wtStore.insert({
        id: "wt-abandon-route-1",
        projectPath: tmpDir,
        worktreePath: wtPath,
        branchName: "spec/abandon-test",
        baseBranch: "main",
        baseCommit: "abc123",
        status: "active",
        createdAt: Date.now(),
      });

      // Mock abandon to skip git operations
      const origAbandon = WorktreeManager.prototype.abandon;
      WorktreeManager.prototype.abandon = function (id: string) {
        (this as unknown as { store: WorktreeStore }).store.updateStatus(
          id,
          "abandoned",
        );
      };

      try {
        const req = new Request("http://localhost/worktree/abandon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ worktree_id: "wt-abandon-route-1" }),
        });
        const res = await handleWorktreeRequest(req, ctx);
        expect(res).not.toBeNull();
        const body = (await res!.json()) as { ok: boolean };
        expect(body.ok).toBe(true);

        // Verify row is abandoned
        const updated = ctx.wtStore.get("wt-abandon-route-1");
        expect(updated?.status).toBe("abandoned");
      } finally {
        WorktreeManager.prototype.abandon = origAbandon;
      }
    });

    it("should return null for non-matching paths", async () => {
      const req = new Request("http://localhost/other-path", {
        method: "POST",
      });
      const res = await handleWorktreeRequest(req, ctx);
      expect(res).toBeNull();
    });
  });

  // ─── POST /worktree/cleanup ────────────────────────────────────────────

  describe("POST /worktree/cleanup", () => {
    it("should return cleaned count of 0 when no stale worktrees", async () => {
      const origCleanup = WorktreeManager.prototype.cleanup;
      WorktreeManager.prototype.cleanup = function () {
        return 0;
      };

      try {
        const req = new Request("http://localhost/worktree/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const res = await handleWorktreeRequest(req, ctx);
        expect(res).not.toBeNull();
        const body = (await res!.json()) as {
          ok: boolean;
          data: { cleaned: number };
        };
        expect(body.ok).toBe(true);
        expect(body.data.cleaned).toBe(0);
      } finally {
        WorktreeManager.prototype.cleanup = origCleanup;
      }
    });

    it("should return count of cleaned stale worktrees", async () => {
      const origCleanup = WorktreeManager.prototype.cleanup;
      WorktreeManager.prototype.cleanup = function () {
        return 2;
      };

      try {
        const req = new Request("http://localhost/worktree/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const res = await handleWorktreeRequest(req, ctx);
        expect(res).not.toBeNull();
        const body = (await res!.json()) as {
          ok: boolean;
          data: { cleaned: number };
        };
        expect(body.ok).toBe(true);
        expect(body.data.cleaned).toBe(2);
      } finally {
        WorktreeManager.prototype.cleanup = origCleanup;
      }
    });
  });
});
