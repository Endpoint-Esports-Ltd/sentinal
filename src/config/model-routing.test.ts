import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import {
  getModelRouting,
  setModelRouting,
  resetModelRouting,
} from "./model-routing.js";
import { DEFAULT_MODEL_ROUTING, MODEL_ROUTING_KEY } from "./types.js";

describe("model-routing", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("getModelRouting", () => {
    it("should return defaults when no setting exists", () => {
      const routing = getModelRouting(store);
      expect(routing).toEqual(DEFAULT_MODEL_ROUTING);
    });

    it("should return stored config when set", () => {
      store.setSetting(
        MODEL_ROUTING_KEY,
        JSON.stringify({
          planning: "haiku",
          implementation: "opus",
          verification: "opus",
          plan_reviewer: "opus",
          spec_reviewer: "opus",
        }),
      );

      const routing = getModelRouting(store);
      expect(routing.planning).toBe("haiku");
      expect(routing.implementation).toBe("opus");
    });

    it("should return defaults for invalid JSON", () => {
      store.setSetting(MODEL_ROUTING_KEY, "not-valid-json");
      const routing = getModelRouting(store);
      expect(routing).toEqual(DEFAULT_MODEL_ROUTING);
    });

    it("should fill missing fields with defaults", () => {
      store.setSetting(
        MODEL_ROUTING_KEY,
        JSON.stringify({
          planning: "haiku",
        }),
      );

      const routing = getModelRouting(store);
      expect(routing.planning).toBe("haiku");
      expect(routing.implementation).toBe("sonnet");
      expect(routing.verification).toBe("sonnet");
      expect(routing.plan_reviewer).toBe("sonnet");
      expect(routing.spec_reviewer).toBe("sonnet");
    });
  });

  describe("setModelRouting", () => {
    it("should set full routing config", () => {
      const config = {
        planning: "opus",
        implementation: "haiku",
        verification: "haiku",
        plan_reviewer: "haiku",
        spec_reviewer: "haiku",
      };

      const result = setModelRouting(store, config);
      expect(result).toEqual(config);

      const stored = getModelRouting(store);
      expect(stored).toEqual(config);
    });

    it("should merge partial update with defaults", () => {
      const result = setModelRouting(store, { planning: "haiku" });
      expect(result.planning).toBe("haiku");
      expect(result.implementation).toBe("sonnet");
    });

    it("should merge partial update with existing config", () => {
      setModelRouting(store, { planning: "haiku", implementation: "opus" });
      const result = setModelRouting(store, { verification: "haiku" });

      expect(result.planning).toBe("haiku");
      expect(result.implementation).toBe("opus");
      expect(result.verification).toBe("haiku");
    });
  });

  describe("resetModelRouting", () => {
    it("should reset to defaults", () => {
      setModelRouting(store, { planning: "haiku" });
      expect(getModelRouting(store).planning).toBe("haiku");

      resetModelRouting(store);
      expect(getModelRouting(store)).toEqual(DEFAULT_MODEL_ROUTING);
    });

    it("should not throw when no setting exists", () => {
      expect(() => resetModelRouting(store)).not.toThrow();
    });
  });
});
