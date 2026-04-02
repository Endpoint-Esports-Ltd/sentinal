import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
    const body = (await res!.json()) as { ok: boolean; data: typeof DEFAULT_MODEL_ROUTING };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(DEFAULT_MODEL_ROUTING);
  });

  it("should return custom model routing when configured", async () => {
    setModelRouting(store, { planning: "haiku" });
    const req = new Request("http://localhost/config/model-routing", {
      method: "GET",
    });
    const res = await handleConfigRequest(req, makeCtx(store));
    const body = (await res!.json()) as { data: { planning: string; implementation: string } };
    expect(body.data.planning).toBe("haiku");
    expect(body.data.implementation).toBe("sonnet");
  });

  it("should return null for non-matching paths", async () => {
    const req = new Request("http://localhost/other-path", { method: "GET" });
    const res = await handleConfigRequest(req, makeCtx(store));
    expect(res).toBeNull();
  });
});
