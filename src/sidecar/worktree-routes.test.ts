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
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { WorktreeManager } from "../worktree/manager.js";
import { handleWorktreeRequest } from "./worktree-routes.js";
import type { SidecarContext } from "./server.js";
import { makeTmpDir } from "../test-helpers.js";

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
        this.store.updateStatus(id, "abandoned");
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
