import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import {
  getModelRouting,
  setModelRouting,
  resetModelRouting,
  resolveModelRouting,
  applyModelRouting,
  findInstalledPluginDirs,
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

  describe("resolveModelRouting", () => {
    it("should return stored config when no env vars set", () => {
      setModelRouting(store, { planning: "haiku" });
      const result = resolveModelRouting(store);
      expect(result.planning).toBe("haiku");
      expect(result.implementation).toBe("sonnet");
    });

    it("should override with env vars", () => {
      const orig = process.env.SENTINAL_MODEL_PLANNING;
      process.env.SENTINAL_MODEL_PLANNING = "haiku";
      try {
        const result = resolveModelRouting(store);
        expect(result.planning).toBe("haiku");
      } finally {
        if (orig === undefined) delete process.env.SENTINAL_MODEL_PLANNING;
        else process.env.SENTINAL_MODEL_PLANNING = orig;
      }
    });

    it("should override all phases with env vars", () => {
      const envs = {
        SENTINAL_MODEL_PLANNING: "haiku",
        SENTINAL_MODEL_IMPLEMENTATION: "opus",
        SENTINAL_MODEL_VERIFICATION: "haiku",
        SENTINAL_MODEL_PLAN_REVIEWER: "opus",
        SENTINAL_MODEL_SPEC_REVIEWER: "opus",
      };
      const originals: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(envs)) {
        originals[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        const result = resolveModelRouting(store);
        expect(result.planning).toBe("haiku");
        expect(result.implementation).toBe("opus");
        expect(result.verification).toBe("haiku");
        expect(result.plan_reviewer).toBe("opus");
        expect(result.spec_reviewer).toBe("opus");
      } finally {
        for (const [k, orig] of Object.entries(originals)) {
          if (orig === undefined) delete process.env[k];
          else process.env[k] = orig;
        }
      }
    });
  });

  describe("applyModelRouting", () => {
    const testDir = join(tmpdir(), `sentinal-routing-test-${process.pid}`);

    beforeEach(() => {
      mkdirSync(join(testDir, "commands"), { recursive: true });
      mkdirSync(join(testDir, "agents"), { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("should patch model frontmatter in commands", () => {
      writeFileSync(
        join(testDir, "commands", "spec-plan.md"),
        "---\ndescription: test\nmodel: opus\n---\nContent here",
      );
      const result = applyModelRouting([testDir], {
        ...DEFAULT_MODEL_ROUTING,
        planning: "haiku",
      });
      expect(result.patched.length).toBeGreaterThan(0);
      const content = readFileSync(
        join(testDir, "commands", "spec-plan.md"),
        "utf-8",
      );
      expect(content).toContain("model: haiku");
      expect(content).not.toContain("model: opus");
    });

    it("should patch model frontmatter in agents", () => {
      writeFileSync(
        join(testDir, "agents", "plan-reviewer.md"),
        "---\nname: plan-reviewer\nmodel: sonnet\n---\nContent",
      );
      const result = applyModelRouting([testDir], {
        ...DEFAULT_MODEL_ROUTING,
        plan_reviewer: "opus",
      });
      expect(result.patched).toContain(
        join(testDir, "agents", "plan-reviewer.md"),
      );
      const content = readFileSync(
        join(testDir, "agents", "plan-reviewer.md"),
        "utf-8",
      );
      expect(content).toContain("model: opus");
    });

    it("should not modify files not in the routing map", () => {
      writeFileSync(
        join(testDir, "commands", "spec.md"),
        "---\nmodel: sonnet\n---\nContent",
      );
      const result = applyModelRouting([testDir], {
        ...DEFAULT_MODEL_ROUTING,
        planning: "haiku",
      });
      expect(result.patched).not.toContain(
        join(testDir, "commands", "spec.md"),
      );
      const content = readFileSync(
        join(testDir, "commands", "spec.md"),
        "utf-8",
      );
      expect(content).toContain("model: sonnet");
    });

    it("should add model line to files that lack it", () => {
      writeFileSync(
        join(testDir, "commands", "spec-master-plan.md"),
        "---\ndescription: test\n---\nContent",
      );
      const result = applyModelRouting([testDir], {
        ...DEFAULT_MODEL_ROUTING,
        planning: "haiku",
      });
      expect(result.patched).toContain(
        join(testDir, "commands", "spec-master-plan.md"),
      );
      const content = readFileSync(
        join(testDir, "commands", "spec-master-plan.md"),
        "utf-8",
      );
      expect(content).toContain("model: haiku");
    });

    it("should handle multiple plugin dirs", () => {
      const dir2 = join(testDir, "dir2", "commands");
      mkdirSync(dir2, { recursive: true });
      writeFileSync(
        join(testDir, "commands", "spec-plan.md"),
        "---\nmodel: opus\n---\n",
      );
      writeFileSync(
        join(dir2, "spec-plan.md"),
        "---\nmodel: opus\n---\n",
      );
      const result = applyModelRouting(
        [testDir, join(testDir, "dir2")],
        { ...DEFAULT_MODEL_ROUTING, planning: "haiku" },
      );
      expect(result.patched.length).toBe(2);
    });

    it("should skip non-existent dirs gracefully", () => {
      const result = applyModelRouting(
        ["/nonexistent/dir"],
        DEFAULT_MODEL_ROUTING,
      );
      expect(result.patched).toEqual([]);
    });
  });

  describe("findInstalledPluginDirs", () => {
    const testBase = join(
      tmpdir(),
      `sentinal-find-dirs-test-${process.pid}`,
    );

    afterEach(() => {
      rmSync(testBase, { recursive: true, force: true });
    });

    it("should return empty array when base dir does not exist", () => {
      expect(findInstalledPluginDirs("/nonexistent/path")).toEqual([]);
    });

    it("should find plugin dir containing commands/spec-plan.md", () => {
      const pluginDir = join(testBase, "marketplace", "sentinal");
      mkdirSync(join(pluginDir, "commands"), { recursive: true });
      writeFileSync(join(pluginDir, "commands", "spec-plan.md"), "---\n---");
      const result = findInstalledPluginDirs(testBase);
      expect(result).toContain(pluginDir);
    });

    it("should find multiple plugin dirs", () => {
      const dir1 = join(testBase, "plugins", "sentinal");
      const dir2 = join(testBase, "cache", "sentinal");
      mkdirSync(join(dir1, "commands"), { recursive: true });
      mkdirSync(join(dir2, "commands"), { recursive: true });
      writeFileSync(join(dir1, "commands", "spec-plan.md"), "---\n---");
      writeFileSync(join(dir2, "commands", "spec-plan.md"), "---\n---");
      const result = findInstalledPluginDirs(testBase);
      expect(result.length).toBe(2);
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
