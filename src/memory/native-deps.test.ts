import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import {
  DEPS_DIR,
  resolveTransformers,
  resolveSqliteVecPath,
  nativeDepsStatus,
} from "./native-deps.js";

describe("native-deps", () => {
  let tmpDeps: string;

  beforeEach(() => {
    tmpDeps = mkdtempSync(join(tmpdir(), "sentinal-deps-"));
  });

  afterEach(() => {
    rmSync(tmpDeps, { recursive: true, force: true });
  });

  describe("DEPS_DIR", () => {
    it("should point into ~/.sentinal/deps", () => {
      expect(DEPS_DIR.endsWith(join(".sentinal", "deps"))).toBe(true);
    });
  });

  describe("resolveTransformers", () => {
    it("should return the module when the bare import succeeds", async () => {
      const fake = { pipeline: () => {}, env: {} };
      const result = await resolveTransformers({
        importer: async (spec: string) => {
          expect(spec).toBe("@xenova/transformers");
          return fake;
        },
      });
      expect(result).toBe(fake as never);
    });

    it("should fall back to the deps dir when the bare import fails", async () => {
      // Lay out a fake installed package in the temp deps dir
      const pkgDir = join(tmpDeps, "node_modules", "@xenova", "transformers");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@xenova/transformers", main: "./index.js" }),
      );
      writeFileSync(join(pkgDir, "index.js"), "");

      const fake = { pipeline: () => {}, env: {} };
      const calls: string[] = [];
      const result = await resolveTransformers({
        depsDir: tmpDeps,
        importer: async (spec: string) => {
          calls.push(spec);
          if (spec === "@xenova/transformers") {
            throw new Error("Cannot find module");
          }
          return fake;
        },
      });

      expect(result).toBe(fake as never);
      expect(calls).toHaveLength(2);
      // Fallback must be a file URL into the deps dir entry point
      expect(calls[1]!.startsWith("file://")).toBe(true);
      expect(calls[1]!).toContain("transformers");
    });

    it("should return null when both resolutions fail", async () => {
      const result = await resolveTransformers({
        depsDir: tmpDeps, // empty — no package installed
        importer: async () => {
          throw new Error("Cannot find module");
        },
      });
      expect(result).toBeNull();
    });

    it("should prefer the self-contained bundle over the node_modules entry", async () => {
      // Both the bundle and the node_modules package exist
      mkdirSync(join(tmpDeps, "bundle"), { recursive: true });
      writeFileSync(
        join(tmpDeps, "bundle", "transformers.bundle.mjs"),
        "export const pipeline = 1;",
      );
      const pkgDir = join(tmpDeps, "node_modules", "@xenova", "transformers");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ main: "./index.js" }),
      );
      writeFileSync(join(pkgDir, "index.js"), "");

      const fake = { pipeline: () => {}, env: {} };
      const calls: string[] = [];
      const result = await resolveTransformers({
        depsDir: tmpDeps,
        importer: async (spec: string) => {
          calls.push(spec);
          if (spec === "@xenova/transformers") {
            throw new Error("Cannot find module");
          }
          return fake;
        },
      });

      expect(result).toBe(fake as never);
      // Second attempt must be the BUNDLE (works in compiled binaries),
      // not the node_modules entry (which does not).
      expect(calls[1]!).toContain("transformers.bundle.mjs");
    });

    it("should fall back to node_modules entry when no bundle exists", async () => {
      const pkgDir = join(tmpDeps, "node_modules", "@xenova", "transformers");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ main: "./index.js" }),
      );
      writeFileSync(join(pkgDir, "index.js"), "");

      const fake = { pipeline: () => {}, env: {} };
      const calls: string[] = [];
      const result = await resolveTransformers({
        depsDir: tmpDeps,
        importer: async (spec: string) => {
          calls.push(spec);
          if (spec === "@xenova/transformers") {
            throw new Error("Cannot find module");
          }
          return fake;
        },
      });

      expect(result).toBe(fake as never);
      expect(calls[1]!).toContain("index.js");
    });
  });

  describe("resolveSqliteVecPath", () => {
    it("should use getLoadablePath from the bare import when available", async () => {
      const result = await resolveSqliteVecPath({
        importer: async () => ({ getLoadablePath: () => "/x/vec0.dylib" }),
      });
      expect(result).toBe("/x/vec0.dylib");
    });

    it("should fall back to the platform package in the deps dir", async () => {
      const ext = platform() === "darwin" ? ".dylib" : ".so";
      const pkgDir = join(
        tmpDeps,
        "node_modules",
        `sqlite-vec-${platform()}-${arch()}`,
      );
      mkdirSync(pkgDir, { recursive: true });
      const dylibPath = join(pkgDir, `vec0${ext}`);
      writeFileSync(dylibPath, "");

      const result = await resolveSqliteVecPath({
        depsDir: tmpDeps,
        importer: async () => {
          throw new Error("Cannot find module");
        },
      });
      expect(result).toBe(dylibPath);
    });

    it("should return null when nothing resolves", async () => {
      const result = await resolveSqliteVecPath({
        depsDir: tmpDeps,
        importer: async () => {
          throw new Error("Cannot find module");
        },
      });
      expect(result).toBeNull();
    });
  });

  describe("nativeDepsStatus", () => {
    it("should report both missing with a setup hint", async () => {
      const status = await nativeDepsStatus({
        depsDir: tmpDeps,
        importer: async () => {
          throw new Error("Cannot find module");
        },
      });
      expect(status.transformers).toBe(false);
      expect(status.sqliteVec).toBe(false);
      expect(status.hint).toContain("sentinal memory setup");
    });

    it("should report available with no hint when both resolve", async () => {
      const status = await nativeDepsStatus({
        importer: async (spec: string) => {
          if (spec === "@xenova/transformers") return { pipeline: () => {} };
          return { getLoadablePath: () => "/x/vec0.dylib" };
        },
      });
      expect(status.transformers).toBe(true);
      expect(status.sqliteVec).toBe(true);
      expect(status.hint).toBeNull();
    });

    it("should capture resolution error details for diagnosis", async () => {
      const status = await nativeDepsStatus({
        depsDir: tmpDeps,
        importer: async () => {
          throw new Error("dlopen failed: bad CPU type");
        },
      });
      expect(status.transformers).toBe(false);
      expect(status.errors.length).toBeGreaterThan(0);
      expect(status.errors.join(" ")).toContain("dlopen failed");
    });
  });
});
