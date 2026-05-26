import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { handleConfigRequest } from "./config-routes.js";
import type { SidecarContext } from "./server.js";
import { setModelRouting } from "../config/model-routing.js";
import { DEFAULT_MODEL_ROUTING } from "../config/types.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";

function makeCtx(store: MemoryStore): SidecarContext {
  return {
    store,
    service: new MemoryService(store),
    specStore: new SpecStore(store),
    wtStore: new WorktreeStore(store),
    httpPort: 0,
  };
}

describe("config-routes", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("should return default model routing when no config set", async () => {
    const req = new Request("http://localhost/config/model-routing", {
      method: "GET",
    });
    const res = await handleConfigRequest(req, makeCtx(store));
    expect(res).not.toBeNull();
    const body = (await res!.json()) as {
      ok: boolean;
      data: typeof DEFAULT_MODEL_ROUTING;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(DEFAULT_MODEL_ROUTING);
  });

  it("should return custom model routing when configured", async () => {
    setModelRouting(store, { planning: "haiku" });
    const req = new Request("http://localhost/config/model-routing", {
      method: "GET",
    });
    const res = await handleConfigRequest(req, makeCtx(store));
    const body = (await res!.json()) as {
      data: { planning: string; implementation: string };
    };
    expect(body.data.planning).toBe("haiku");
    expect(body.data.implementation).toBe("sonnet");
  });

  it("should return null for non-matching paths", async () => {
    const req = new Request("http://localhost/other-path", { method: "GET" });
    const res = await handleConfigRequest(req, makeCtx(store));
    expect(res).toBeNull();
  });

  describe("GET /config/compaction", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `sentinal-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns reserved value from opencode.json when compaction.reserved is set", async () => {
      writeFileSync(
        join(tmpDir, "opencode.json"),
        JSON.stringify({ compaction: { reserved: 5000 } }),
      );
      const req = new Request(
        `http://localhost/config/compaction?project=${encodeURIComponent(tmpDir)}`,
        { method: "GET" },
      );
      const res = await handleConfigRequest(req, makeCtx(store));
      expect(res).not.toBeNull();
      const body = (await res!.json()) as { ok: boolean; data: { reserved: number } };
      expect(body.ok).toBe(true);
      expect(body.data.reserved).toBe(5000);
    });

    it("returns default 10000 when opencode.json has no compaction key", async () => {
      writeFileSync(
        join(tmpDir, "opencode.json"),
        JSON.stringify({ model: "sonnet" }),
      );
      const req = new Request(
        `http://localhost/config/compaction?project=${encodeURIComponent(tmpDir)}`,
        { method: "GET" },
      );
      const res = await handleConfigRequest(req, makeCtx(store));
      expect(res).not.toBeNull();
      const body = (await res!.json()) as { ok: boolean; data: { reserved: number } };
      expect(body.ok).toBe(true);
      expect(body.data.reserved).toBe(10000);
    });

    it("returns default 10000 when opencode.json does not exist", async () => {
      const req = new Request(
        `http://localhost/config/compaction?project=${encodeURIComponent(tmpDir)}`,
        { method: "GET" },
      );
      const res = await handleConfigRequest(req, makeCtx(store));
      expect(res).not.toBeNull();
      const body = (await res!.json()) as { ok: boolean; data: { reserved: number } };
      expect(body.ok).toBe(true);
      expect(body.data.reserved).toBe(10000);
    });

    it("returns default 10000 when no project param provided", async () => {
      const req = new Request("http://localhost/config/compaction", { method: "GET" });
      const res = await handleConfigRequest(req, makeCtx(store));
      expect(res).not.toBeNull();
      const body = (await res!.json()) as { ok: boolean; data: { reserved: number } };
      expect(body.ok).toBe(true);
      expect(body.data.reserved).toBe(10000);
    });
  });
});
