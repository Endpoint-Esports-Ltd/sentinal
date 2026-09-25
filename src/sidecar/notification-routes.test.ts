/**
 * Notification Routes Tests — the read side the OpenCode plugin needs.
 *
 * The plugin cannot open the store (no bun:sqlite in its bundle), so Task 12's
 * "session.created surfaces notifications" needs a sidecar READ route and a
 * per-id mark-read route. The rules are the SAME ones the Claude Code
 * SessionStart hook applies (src/hooks/session-notifications.ts):
 *   - this project's unread rows + unread GLOBAL-source rows (sidecar skew),
 *   - never another project's rows, never NULL-project history,
 *   - mark read ONE id at a time — never the global markAllNotificationsRead().
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
import { join } from "node:path";
import { realpathSync, rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import * as fileLogModule from "../utils/file-log.js";
import { SKEW_NOTIFICATION_SOURCE } from "./retire-notify.js";
import {
  handleNotificationRequest,
  handleInsertNotificationRoute,
} from "./notification-routes.js";
import {
  listSessionNotificationCandidates,
  surfaceSessionNotifications,
  type SessionNotificationReader,
} from "../hooks/session-notifications.js";
import { startSidecar, stopSidecar } from "./server.js";
import { SidecarClient } from "./client.js";
import type { SidecarContext } from "./server.js";
import type { Notification } from "../memory/types.js";

function get(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function post(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(res: Response | null): Promise<T> {
  expect(res).not.toBeNull();
  return (await res!.json()) as T;
}

describe("handleNotificationRequest", () => {
  let tmpDir: string;
  let projectA: string; // canonical (realpath'd) — what writers store
  let projectB: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
    projectA = realpathSync(tmpDir);
    projectB = join(projectA, "..", "some-other-project-b");
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
  });

  afterEach(() => {
    mock.restore();
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(): Record<string, number> {
    const mk = (title: string, projectPath: string | null, source: string) =>
      store.insertNotification({ type: "info", title, projectPath, source }).id;
    return {
      mine: mk("mine", projectA, "session-end"),
      other: mk("other", projectB, "session-end"),
      history: mk("history", null, "session-end"),
      skew: mk("skew", null, SKEW_NOTIFICATION_SOURCE),
    };
  }

  it("returns null for unrelated paths", async () => {
    expect(await handleNotificationRequest(get("/health"), ctx)).toBeNull();
    expect(
      await handleNotificationRequest(post("/notification", {}), ctx),
    ).toBeNull();
  });

  it("GET /notifications/session returns this project's unread rows plus global skew — never another project's or NULL history", async () => {
    const ids = seed();
    const body = await json<{ ok: boolean; data: Notification[] }>(
      await handleNotificationRequest(
        get(`/notifications/session?project=${encodeURIComponent(projectA)}`),
        ctx,
      ),
    );
    expect(body.ok).toBe(true);
    const got = body.data.map((n) => n.id).sort();
    expect(got).toEqual([ids.mine, ids.skew].sort());
  });

  it("normalizes the project to its canonical identity", async () => {
    const ids = seed();
    // A trailing-slash / non-canonical spelling of the same directory.
    const body = await json<{ data: Notification[] }>(
      await handleNotificationRequest(
        get(
          `/notifications/session?project=${encodeURIComponent(tmpDir + "/")}`,
        ),
        ctx,
      ),
    );
    expect(body.data.map((n) => n.id)).toContain(ids.mine);
  });

  it("rejects a missing or blank project with 400 rather than falling back to the sidecar's cwd", async () => {
    seed();
    for (const q of ["", "?project=", "?project=%20%20"]) {
      const res = await handleNotificationRequest(
        get(`/notifications/session${q}`),
        ctx,
      );
      expect(res!.status).toBe(400);
    }
  });

  it("does not mark anything read — listing is side-effect free", async () => {
    seed();
    const before = store.getUnreadNotificationCount();
    await handleNotificationRequest(
      get(`/notifications/session?project=${encodeURIComponent(projectA)}`),
      ctx,
    );
    expect(store.getUnreadNotificationCount()).toBe(before);
  });

  it("POST /notifications/read marks exactly ONE id read", async () => {
    const ids = seed();
    const before = store.getUnreadNotificationCount();
    const res = await handleNotificationRequest(
      post("/notifications/read", { id: ids.mine }),
      ctx,
    );
    expect(res!.status).toBe(200);
    expect(store.getUnreadNotificationCount()).toBe(before - 1);
    const unread = store.getNotifications({ unread: true, limit: 100 });
    expect(unread.map((n) => n.id).sort()).toEqual(
      [ids.other, ids.history, ids.skew].sort(),
    );
  });

  // ── POST /notification carries a project (Task 14 / D5) ──────────────────

  async function insert(body: Record<string, unknown>): Promise<Response> {
    const req = post("/notification", body);
    const res = await handleInsertNotificationRoute(new URL(req.url), req, ctx);
    expect(res).not.toBeNull();
    return res!;
  }

  it("POST /notification stores a supplied projectPath as its canonical identity", async () => {
    // Non-canonical spelling (trailing slash, un-realpath'd tmp dir).
    const res = await insert({
      type: "warning",
      title: "API Error: overloaded",
      source: "stop-failure",
      projectPath: tmpDir + "/",
    });
    expect(res.status).toBe(200);
    const [row] = store.getNotifications({ limit: 10 });
    expect(row!.projectPath).toBe(projectA);
    expect(row!.source).toBe("stop-failure");
  });

  it("POST /notification without projectPath (old client) still stores the row, project NULL", async () => {
    const res = await insert({ type: "warning", title: "legacy" });
    expect(res.status).toBe(200);
    const [row] = store.getNotifications({ limit: 10 });
    expect(row!.title).toBe("legacy");
    expect(row!.projectPath).toBeNull();
  });

  it("POST /notification rejects a blank projectPath with 400 and stores nothing", async () => {
    for (const projectPath of ["", "   "]) {
      const res = await insert({ type: "warning", title: "x", projectPath });
      expect(res.status).toBe(400);
    }
    expect(store.getNotifications({ limit: 10 })).toEqual([]);
  });

  it("a project warning inserted via the route surfaces in THAT project's session digest and not another's", async () => {
    await insert({
      type: "warning",
      title: "Sentinal hooks disabled",
      source: "config-change",
      projectPath: projectA,
    });
    const reader = (): SessionNotificationReader => ({
      listCandidates: (p, limit) =>
        listSessionNotificationCandidates(store, p, limit),
      markRead: (id) => store.markNotificationRead(id),
    });

    // Project B first, so A's row is still unread afterwards.
    expect(await surfaceSessionNotifications(reader(), projectB)).toBeNull();
    const listedB = await json<{ data: Notification[] }>(
      await handleNotificationRequest(
        get(`/notifications/session?project=${encodeURIComponent(projectB)}`),
        ctx,
      ),
    );
    expect(listedB.data).toEqual([]);

    const digestA = await surfaceSessionNotifications(reader(), projectA);
    expect(digestA).toContain("[warning] Sentinal hooks disabled");
  });

  it("POST /notifications/read rejects a missing or non-integer id", async () => {
    seed();
    const before = store.getUnreadNotificationCount();
    for (const body of [undefined, {}, { id: "3" }, { id: 1.5 }, { id: -1 }]) {
      const res = await handleNotificationRequest(
        post("/notifications/read", body),
        ctx,
      );
      expect(res!.status).toBe(400);
    }
    expect(store.getUnreadNotificationCount()).toBe(before);
  });
});

describe("SidecarClient notification methods (real sidecar)", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let client: SidecarClient;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = await startSidecar({
      store,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });
    const port = (sidecar.server as unknown as { port: number }).port;
    client = SidecarClient.buildForTest(`http://127.0.0.1:${port}`);
  });

  afterEach(() => {
    try {
      stopSidecar(sidecar.server, sidecar.ctx);
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips list + per-id mark-read over the wire", async () => {
    const projectA = realpathSync(tmpDir);
    const mine = store.insertNotification({
      type: "info",
      title: "mine",
      projectPath: projectA,
      source: "session-end",
    });
    const other = store.insertNotification({
      type: "info",
      title: "other",
      projectPath: join(projectA, "..", "elsewhere"),
      source: "session-end",
    });

    const listed = await client.listSessionNotifications(projectA, 5);
    expect(listed.map((n) => n.id)).toEqual([mine.id]);

    await client.markNotificationRead(mine.id);
    expect(await client.listSessionNotifications(projectA, 5)).toEqual([]);
    // The other project's notification is untouched.
    expect(
      store.getNotifications({ unread: true, limit: 10 }).map((n) => n.id),
    ).toEqual([other.id]);
  });

  it("client.insertNotification sends projectPath over the wire; omitting it still works", async () => {
    const projectA = realpathSync(tmpDir);
    await client.insertNotification({
      type: "warning",
      title: "scoped",
      source: "spec-notify",
      projectPath: tmpDir,
    });
    await client.insertNotification({ type: "warning", title: "legacy" });

    const rows = store.getNotifications({ limit: 10 });
    const byTitle = new Map(rows.map((n) => [n.title, n]));
    expect(byTitle.get("scoped")!.projectPath).toBe(projectA);
    expect(byTitle.get("legacy")!.projectPath).toBeNull();
    expect(
      (await client.listSessionNotifications(projectA, 5)).map((n) => n.title),
    ).toEqual(["scoped"]);
  });
});
