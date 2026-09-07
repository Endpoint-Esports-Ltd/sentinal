/**
 * Worktree Sidecar Routes Tests
 *
 * Tests for the worktree sidecar route handler:
 *   - GET /worktree/resolve — find worktree by slug
 *   - POST /worktree/abandon — abandon a worktree by ID
 *   - POST /worktree/cleanup — clean up stale worktrees
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fileLogModule from "../utils/file-log.js";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { spawnDetached } from "../runtime/spawn.js";
import { writePidfile } from "../runtime/pidfile.js";
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

    it("carries the slot in the response — the third consumer alongside MCP + CLI", async () => {
      // ⚠️ Confirmed, not assumed: the route serialises the whole Worktree, so
      // a slot missing from `deserialize` would silently reach every sidecar
      // caller (the OpenCode plugin among them) as `undefined`.
      const repoDir = join(tmpDir, "repo-slot");
      mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir);

      const manager = new WorktreeManager(ctx.wtStore);
      const created = manager.create("2026-08-07-route-slot", repoDir);
      expect(created.slot).toBe(1);

      const req = new Request(
        `http://localhost/worktree/resolve?slug=2026-08-07-route-slot&project=${encodeURIComponent(repoDir)}`,
        { method: "GET" },
      );
      const res = await handleWorktreeRequest(req, ctx);
      const body = (await res!.json()) as {
        ok: boolean;
        data: { slot?: number | null } | null;
      };

      expect(body.data).not.toBeNull();
      expect(body.data!.slot).toBe(1);
    });

    it("carries seeding/slot WARNINGS in the response — sidecar mode is the default detect path", async () => {
      // ⛔ Without this the "warn loudly" mitigation (Task 5, Rule 2) holds only
      // in direct mode: the sidecar computes the warnings and throws them away,
      // and silence is exactly what sends an agent back to copying the root
      // `.env` into the worktree.
      const repoDir = join(tmpDir, "repo-warn");
      mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir); // no .env.example anywhere

      const manager = new WorktreeManager(ctx.wtStore);
      const wt = manager.create("2026-08-08-route-warn", repoDir);
      // Drift: the row is lost, so resolve re-registers and re-seeds.
      ctx.wtStore.delete(wt.id);

      const req = new Request(
        `http://localhost/worktree/resolve?slug=2026-08-08-route-warn&project=${encodeURIComponent(repoDir)}`,
        { method: "GET" },
      );
      const res = await handleWorktreeRequest(req, ctx);
      const body = (await res!.json()) as {
        ok: boolean;
        data: { branchName: string; warnings?: string[] } | null;
      };

      expect(body.data).not.toBeNull();
      expect(body.data!.branchName).toBe(wt.branchName);
      expect(Array.isArray(body.data!.warnings)).toBe(true);
      expect(body.data!.warnings!.join("\n")).toContain(".env.example");
    });

    it("names the runtime contract's shared resources in those warnings (R11, Task 6)", async () => {
      // ⛔ Construction-site assertion for `worktree-routes.ts:62`. The route
      // builds its manager through `runtimeWorktreeConfig()`; if that injection
      // were dropped, the warning would fall back to the blanket Phase 2 text
      // and this test is the only thing that would notice.
      const repoDir = join(tmpDir, "repo-r11");
      mkdirSync(join(repoDir, ".sentinal"), { recursive: true });
      initRepo(repoDir);
      writeFileSync(
        join(repoDir, ".env.example"),
        "DATABASE_URL=postgres://x\n",
      );
      writeFileSync(
        join(repoDir, ".sentinal", "runtime.json"),
        JSON.stringify({ isolation: { database: "shared" } }),
      );
      // Committed, so `git worktree add` hands the worktree its own copy —
      // which is the file `sharedResourcesFor(worktreePath)` reads.
      Bun.spawnSync(["git", "add", "-Af"], { cwd: repoDir });
      Bun.spawnSync(["git", "commit", "-m", "runtime contract"], {
        cwd: repoDir,
      });

      const manager = new WorktreeManager(ctx.wtStore);
      const wt = manager.create("2026-08-09-route-r11", repoDir);
      // Rule 0 never overwrites, so create()'s `.env` has to go for the
      // re-registering seed (the site under test) to actually run.
      rmSync(join(wt.worktreePath, ".env"), { force: true });
      ctx.wtStore.delete(wt.id);

      const req = new Request(
        `http://localhost/worktree/resolve?slug=2026-08-09-route-r11&project=${encodeURIComponent(repoDir)}`,
        { method: "GET" },
      );
      const res = await handleWorktreeRequest(req, ctx);
      const body = (await res!.json()) as {
        data: { warnings?: string[] } | null;
      };

      expect(body.data).not.toBeNull();
      expect(body.data!.warnings!.join("\n")).toContain(
        "Shared with the main checkout: database.",
      );
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
      WorktreeManager.prototype.abandon = async function (id: string) {
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
        return { cleaned: 0, removed: [] };
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
        return { cleaned: 2, removed: [] };
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

    it("threads force/project/currentWorktree from the request body into cleanup()", async () => {
      const origCleanup = WorktreeManager.prototype.cleanup;
      let received: unknown = "NOT_CALLED";
      WorktreeManager.prototype.cleanup = function (opts?: unknown) {
        received = opts;
        return { cleaned: 1, removed: [] };
      };

      try {
        const req = new Request("http://localhost/worktree/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: "/real/caller/project",
            force: true,
            currentWorktree: "/real/caller/project/.sentinal/worktrees/spec-x",
          }),
        });
        const res = await handleWorktreeRequest(req, ctx);
        expect(res).not.toBeNull();

        const opts = received as {
          force?: boolean;
          projectPath?: string;
          currentWorktree?: string;
          isPlanActive?: (slug: string) => boolean;
        };
        expect(opts.force).toBe(true);
        expect(opts.projectPath).toBe("/real/caller/project");
        expect(opts.currentWorktree).toBe(
          "/real/caller/project/.sentinal/worktrees/spec-x",
        );
        // An isPlanActive resolver must be supplied (the IN_PROGRESS guard).
        expect(typeof opts.isPlanActive).toBe("function");
      } finally {
        WorktreeManager.prototype.cleanup = origCleanup;
      }
    });

    it("returns guard-5 warnings on the wire, so a skipped cleanup is not silent", async () => {
      // ⛔ The sidecar is the DEFAULT path. A warning computed here and thrown
      // away leaves the caller with "Cleaned up 0 worktrees." and no reason —
      // and the obvious next move for an agent reading that is to `rm -rf` the
      // directory by hand, which is the orphan guard 5 exists to prevent.
      const origCleanup = WorktreeManager.prototype.cleanup;
      WorktreeManager.prototype.cleanup = function (opts?: unknown) {
        (opts as { warnings?: string[] }).warnings?.push(
          "Skipped /wt/spec-z: pid 5150 is running from it.",
        );
        return { cleaned: 0, removed: [] };
      };

      try {
        const req = new Request("http://localhost/worktree/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: "/p", force: true }),
        });
        const res = await handleWorktreeRequest(req, ctx);
        const body = (await res!.json()) as {
          data: { cleaned: number; warnings?: string[] };
        };
        expect(body.data.cleaned).toBe(0);
        expect(body.data.warnings!.join("\n")).toContain("5150");
      } finally {
        WorktreeManager.prototype.cleanup = origCleanup;
      }
    });

    it("supplies guard 5's resolver from the manager config, not from the wire", async () => {
      const origCleanup = WorktreeManager.prototype.cleanup;
      let sawResolver = false;
      WorktreeManager.prototype.cleanup = function (this: WorktreeManager) {
        sawResolver =
          typeof (this as unknown as { config: { ownsLiveRuntime?: unknown } })
            .config.ownsLiveRuntime === "function";
        return { cleaned: 0, removed: [] };
      };

      try {
        const req = new Request("http://localhost/worktree/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: "/p", force: true }),
        });
        await handleWorktreeRequest(req, ctx);
        // Derived SERVER-side from the worktree's own pidfile — there is no
        // wire field for it, and there must not be one: a caller-supplied
        // "nothing is running" would be a caller-supplied licence to delete.
        expect(sawResolver).toBe(true);
      } finally {
        WorktreeManager.prototype.cleanup = origCleanup;
      }
    });
  });
});

// ─── Stop-on-exit, end to end against a REAL process group ──────────────────

/**
 * `worktree-routes.ts`'s abandon handler is the construction site whose
 * `stopOwnedRuntime` is behaviourally live (Task 6's DoD defers this assertion
 * to here). Everything is real: a real git worktree, a real detached process
 * group started inside it, a real pidfile, and the real HTTP route.
 */
describe("POST /worktree/abandon stops the owned group first", () => {
  let tmpDir: string;
  let repoDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;
  const started: number[] = [];

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = makeCtx(store);
  });

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("kills the process group before the directory is removed", async () => {
    const manager = new WorktreeManager(ctx.wtStore);
    const wt = manager.create("2026-08-09-abandon-stop", repoDir);

    // A real detached group whose cwd is the worktree — the durable
    // ownership proof `spawnDetached` is built around.
    const proc = spawnDetached({
      worktreePath: wt.worktreePath,
      command: "sleep 30",
      slot: wt.slot ?? null,
    });
    started.push(proc.pid);
    writePidfile(wt.worktreePath, {
      pid: proc.pid,
      pgid: proc.pgid,
      startedAt: Date.now(),
      command: "sleep 30",
      state: "ready",
    });
    expect(isAlive(proc.pid)).toBe(true);

    const req = new Request("http://localhost/worktree/abandon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktree_id: wt.id }),
    });
    const res = await handleWorktreeRequest(req, ctx);
    expect(((await res!.json()) as { ok: boolean }).ok).toBe(true);

    // ⛔ Both halves matter: a process left running with its cwd deleted is
    // exactly the orphan this tier exists to prevent.
    expect(await waitFor(() => !isAlive(proc.pid))).toBe(true);
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(ctx.wtStore.get(wt.id)!.status).toBe("abandoned");
  }, 20_000);

  /**
   * ⛔ The sidecar is the DEFAULT path for `worktree_abandon`
   * (`mcp-tools.ts` prefers `client.abandonWorktree`). A designed refusal that
   * arrives as an opaque failure is worse than no refusal: an agent that cannot
   * see WHY abandon failed reaches for `rm -rf`, which is the incident class
   * this phase exists to prevent. The remedy text — the pids in the way, the
   * `ps` command, and the pidfile to delete — must survive the wire verbatim.
   */
  it("surfaces a RUNTIME_STOP_FAILED refusal with its remedy text, not an opaque 500", async () => {
    const manager = new WorktreeManager(ctx.wtStore);
    const wt = manager.create("2026-08-09-abandon-refuse", repoDir);

    // A pidfile naming a LIVE pid that provably belongs to nothing here: the
    // real gate reports `foreign` and refuses, with no process to clean up.
    writePidfile(wt.worktreePath, {
      pid: process.pid,
      pgid: process.pid,
      startedAt: Date.now(),
      command: "npm run dev",
      state: "ready",
    });

    const req = new Request("http://localhost/worktree/abandon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktree_id: wt.id }),
    });
    const res = await handleWorktreeRequest(req, ctx);
    const body = (await res!.json()) as { ok: boolean; error?: string };

    expect(body.ok).toBe(false);
    // 409 Conflict: the request was well-formed, the server refused on state.
    expect(res!.status).toBe(409);
    expect(body.error).toContain(String(process.pid));
    expect(body.error).toContain("runtime.pid");
    expect(body.error).toContain(wt.worktreePath);

    // ⛔ And the refusal is real, not cosmetic: nothing was deleted.
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(ctx.wtStore.get(wt.id)!.status).toBe("active");
  }, 20_000);

  /**
   * The escape hatch, asserted rather than merely documented. A worktree whose
   * stop keeps refusing cannot be abandoned, cannot be merged, and is skipped
   * by `worktree_cleanup --force` — so if deleting the ownership record by hand
   * did NOT unwedge it, a worktree could become permanently un-abandonable.
   */
  it("is unwedged by deleting .sentinal/runtime.pid — the documented escape hatch", async () => {
    const manager = new WorktreeManager(ctx.wtStore);
    const wt = manager.create("2026-08-09-abandon-escape", repoDir);
    const pidfile = join(wt.worktreePath, ".sentinal", "runtime.pid");

    writePidfile(wt.worktreePath, {
      pid: process.pid,
      pgid: process.pid,
      startedAt: Date.now(),
      command: "npm run dev",
      state: "ready",
    });

    const call = async () =>
      handleWorktreeRequest(
        new Request("http://localhost/worktree/abandon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ worktree_id: wt.id }),
        }),
        ctx,
      );

    expect(((await (await call())!.json()) as { ok: boolean }).ok).toBe(false);

    // The remedy the refusal names, performed by hand.
    expect(existsSync(pidfile)).toBe(true);
    rmSync(pidfile, { force: true });

    expect(((await (await call())!.json()) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(ctx.wtStore.get(wt.id)!.status).toBe("abandoned");
  }, 20_000);
});

// ─── Acted-on set on the wire (issue #9) ───────────────────────────────────

describe("POST /worktree/cleanup — acted-on set", () => {
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

  async function cleanup(body: unknown): Promise<any> {
    const req = new Request("http://localhost/worktree/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await (await handleWorktreeRequest(req, ctx))!.json()) as any;
  }

  it("returns the removed set alongside the count", async () => {
    const orig = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function () {
      return {
        cleaned: 1,
        removed: [
          {
            path: "/repo/.sentinal/worktrees/spec-x",
            branch: "sentinal/spec-x",
            slug: "x",
            pass: "force" as const,
          },
        ],
      };
    };
    try {
      const body = await cleanup({ project: tmpDir, force: true });
      expect(body.ok).toBe(true);
      expect(body.data.removed).toHaveLength(1);
      expect(body.data.removed[0].path).toBe(
        "/repo/.sentinal/worktrees/spec-x",
      );
      expect(body.data.removed[0].branch).toBe("sentinal/spec-x");
    } finally {
      WorktreeManager.prototype.cleanup = orig;
    }
  });

  it("STILL returns `cleaned` — an older bundled client reads only that", async () => {
    const orig = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function () {
      return {
        cleaned: 2,
        removed: [
          {
            path: "/a",
            branch: "sentinal/spec-a",
            slug: "a",
            pass: "force" as const,
          },
          {
            path: "/b",
            branch: "sentinal/spec-b",
            slug: "b",
            pass: "force" as const,
          },
        ],
      };
    };
    try {
      const body = await cleanup({ project: tmpDir, force: true });
      expect(body.data.cleaned).toBe(2);
    } finally {
      WorktreeManager.prototype.cleanup = orig;
    }
  });
});

// ─── Idempotency keys on destructive routes (issue #9) ─────────────────────

describe("POST /worktree/cleanup — idempotency", () => {
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

  async function cleanup(body: unknown): Promise<any> {
    const req = new Request("http://localhost/worktree/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await (await handleWorktreeRequest(req, ctx))!.json()) as any;
  }

  it("does the work ONCE for a repeated idempotency_key", async () => {
    const orig = WorktreeManager.prototype.cleanup;
    let runs = 0;
    WorktreeManager.prototype.cleanup = function () {
      runs++;
      return {
        cleaned: 7,
        removed: [
          {
            path: "/w/7",
            branch: "sentinal/spec-7",
            slug: "7",
            pass: "force" as const,
          },
        ],
      };
    };
    try {
      const first = await cleanup({
        project: tmpDir,
        force: true,
        idempotencyKey: "req-42",
      });
      // This is the retry the reporter made after being told it failed.
      const second = await cleanup({
        project: tmpDir,
        force: true,
        idempotencyKey: "req-42",
      });

      expect(runs).toBe(1);
      expect(first.data.cleaned).toBe(7);
      // The retry must learn what the ORIGINAL call did — not report 0.
      expect(second.data.cleaned).toBe(7);
      expect(second.data.replayed).toBe(true);
      expect(second.data.removed).toEqual(first.data.removed);
    } finally {
      WorktreeManager.prototype.cleanup = orig;
    }
  });

  it("runs again without a key — unchanged behaviour", async () => {
    const orig = WorktreeManager.prototype.cleanup;
    let runs = 0;
    WorktreeManager.prototype.cleanup = function () {
      runs++;
      return { cleaned: 0, removed: [] };
    };
    try {
      await cleanup({ project: tmpDir, force: true });
      const second = await cleanup({ project: tmpDir, force: true });
      expect(runs).toBe(2);
      expect(second.data.replayed).toBeUndefined();
    } finally {
      WorktreeManager.prototype.cleanup = orig;
    }
  });
});

// ─── Audit logging (issue #9) ──────────────────────────────────────────────
// `rg -c "worktree" ~/.sentinal/sidecar.log` returned 0 on a real machine after
// a destructive cleanup had run: worktree operations were NEVER logged
// server-side. Combined with a client error that misreported a timeout as
// "unreachable", there was no way to determine whether a destructive operation
// had executed short of manually inspecting git state.

describe("worktree-routes audit logging", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;
  let logPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = makeCtx(store);
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
    logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function logLines(): string[] {
    return fileLogModule.readLastLines(logPath, 100);
  }

  it("logs start and outcome for POST /worktree/cleanup", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);

    const req = new Request("http://localhost/worktree/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: repoDir, force: false }),
    });
    const res = await handleWorktreeRequest(req, ctx);
    expect(res).not.toBeNull();

    const lines = logLines();
    // Every record must be greppable by the word an operator would search for.
    expect(lines.some((l) => l.includes("worktree"))).toBe(true);
    expect(
      lines.some((l) => l.includes("/worktree/cleanup") && l.includes("start")),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.includes("/worktree/cleanup") && l.includes("cleaned="),
      ),
    ).toBe(true);
  });

  it("records the force flag — the difference between safe and destructive", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);

    const req = new Request("http://localhost/worktree/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: repoDir, force: true }),
    });
    await handleWorktreeRequest(req, ctx);

    expect(logLines().some((l) => l.includes("force=true"))).toBe(true);
  });

  it("logs the elapsed duration so a client timeout can be reconciled", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);

    const req = new Request("http://localhost/worktree/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: repoDir }),
    });
    await handleWorktreeRequest(req, ctx);

    expect(logLines().some((l) => /\d+ms/.test(l))).toBe(true);
  });

  it("logs start and outcome for POST /worktree/abandon", async () => {
    const wtPath = join(tmpDir, ".worktrees", "log-abandon");
    mkdirSync(wtPath, { recursive: true });
    ctx.wtStore.insert({
      id: "wt-log-abandon",
      projectPath: tmpDir,
      worktreePath: wtPath,
      branchName: "sentinal/spec-2026-09-07-log",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const req = new Request("http://localhost/worktree/abandon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktree_id: "wt-log-abandon" }),
    });
    await handleWorktreeRequest(req, ctx);

    const lines = logLines();
    expect(
      lines.some((l) => l.includes("/worktree/abandon") && l.includes("start")),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.includes("/worktree/abandon") && l.includes("wt-log-abandon"),
      ),
    ).toBe(true);
  });

  it("logs a FAILED outcome when a handler throws", async () => {
    // force + a non-existent project makes getRepoRoot throw inside cleanup.
    const req = new Request("http://localhost/worktree/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: join(tmpDir, "definitely-not-a-repo"),
        force: true,
      }),
    });
    const res = await handleWorktreeRequest(req, ctx);
    expect(res!.status).toBe(500);

    const lines = logLines();
    expect(lines.some((l) => l.includes("/worktree/cleanup"))).toBe(true);
    expect(lines.some((l) => l.includes("FAILED"))).toBe(true);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}
