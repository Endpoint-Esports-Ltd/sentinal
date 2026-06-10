import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTransformersBundle,
  isBundleFresh,
  BUNDLE_REL_PATH,
} from "./setup-bundle.js";

interface SpawnCall {
  cmd: string[];
  cwd?: string;
}

function layoutDeps(depsDir: string, transformersVersion = "2.17.2"): void {
  const pkgDir = join(depsDir, "node_modules", "@xenova", "transformers");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@xenova/transformers",
      version: transformersVersion,
      main: "./src/transformers.js",
    }),
  );
  writeFileSync(join(pkgDir, "src", "transformers.js"), "// entry");
  // onnxruntime-node native bin tree
  const binSrc = join(
    depsDir,
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v3",
    "darwin",
    "arm64",
  );
  mkdirSync(binSrc, { recursive: true });
  writeFileSync(join(binSrc, "onnxruntime_binding.node"), "fake-native");
}

describe("setup-bundle", () => {
  let depsDir: string;

  beforeEach(() => {
    depsDir = mkdtempSync(join(tmpdir(), "sentinal-bundle-"));
    layoutDeps(depsDir);
  });

  afterEach(() => {
    rmSync(depsDir, { recursive: true, force: true });
  });

  /** Spawner that "succeeds" and creates the bundle file like a real build. */
  function bundleCreatingSpawner(calls: SpawnCall[], failBun = false) {
    return (cmd: string[], opts?: { cwd?: string }): number => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd[0] === "bun" && failBun) throw new Error("bun ENOENT");
      const bundlePath = join(depsDir, BUNDLE_REL_PATH);
      mkdirSync(join(depsDir, "bundle"), { recursive: true });
      writeFileSync(bundlePath, "export const pipeline = 1;");
      return 0;
    };
  }

  describe("buildTransformersBundle", () => {
    it("should build via bun first and write meta + copy the native bin tree", async () => {
      const calls: SpawnCall[] = [];
      const result = await buildTransformersBundle({
        depsDir,
        spawner: bundleCreatingSpawner(calls),
        skipSmoke: true,
      });

      expect(result.ok).toBe(true);
      expect(result.bundler).toBe("bun");
      expect(calls[0]!.cmd[0]).toBe("bun");
      // Native layout copied to sibling bin/
      expect(
        existsSync(
          join(
            depsDir,
            "bin",
            "napi-v3",
            "darwin",
            "arm64",
            "onnxruntime_binding.node",
          ),
        ),
      ).toBe(true);
      // Meta written with the installed version
      const meta = JSON.parse(
        readFileSync(join(depsDir, "bundle", ".bundle-meta.json"), "utf-8"),
      );
      expect(meta.transformersVersion).toBe("2.17.2");
      expect(meta.bundler).toBe("bun");
    });

    it("should fall back to npx esbuild when bun spawn fails", async () => {
      const calls: SpawnCall[] = [];
      const result = await buildTransformersBundle({
        depsDir,
        spawner: bundleCreatingSpawner(calls, true),
        skipSmoke: true,
      });

      expect(result.ok).toBe(true);
      expect(result.bundler).toBe("esbuild");
      const esbuildCall = calls.find((c) => c.cmd.includes("esbuild"));
      expect(esbuildCall).toBeDefined();
      const joined = esbuildCall!.cmd.join(" ");
      // The spike-proven flags
      expect(joined).toContain("--bundle");
      expect(joined).toContain("--alias:sharp=");
      expect(joined).toContain("--external:*.node");
      expect(joined).toContain("createRequire");
    });

    it("should fail with an actionable report when transformers is not installed", async () => {
      rmSync(join(depsDir, "node_modules", "@xenova"), {
        recursive: true,
        force: true,
      });
      const result = await buildTransformersBundle({
        depsDir,
        spawner: () => 0,
        skipSmoke: true,
      });
      expect(result.ok).toBe(false);
      expect(result.report.join("\n")).toContain("@xenova/transformers");
    });

    it("should fail (and not write fresh meta) when the import smoke fails", async () => {
      const calls: SpawnCall[] = [];
      const result = await buildTransformersBundle({
        depsDir,
        spawner: (cmd: string[], opts?: { cwd?: string }) => {
          calls.push({ cmd, cwd: opts?.cwd });
          if (cmd[0] === "bun" && cmd[1] === "-e") return 1; // smoke fails
          const bundlePath = join(depsDir, BUNDLE_REL_PATH);
          mkdirSync(join(depsDir, "bundle"), { recursive: true });
          writeFileSync(bundlePath, "export const broken = 1;");
          return 0;
        },
      });

      expect(result.ok).toBe(false);
      expect(result.report.join("\n")).toContain("smoke failed");
      // Freshness must NOT report true for a bundle that failed its smoke
      expect(isBundleFresh(depsDir)).toBe(false);
    });

    it("should fail when both bundlers are unavailable", async () => {
      const result = await buildTransformersBundle({
        depsDir,
        spawner: () => {
          throw new Error("ENOENT");
        },
        skipSmoke: true,
      });
      expect(result.ok).toBe(false);
      expect(result.bundler).toBeNull();
    });
  });

  describe("real bundle integration (requires provisioned ~/.sentinal/deps)", () => {
    const realDeps = join(
      process.env.HOME ?? "",
      ".sentinal",
      "deps",
      "node_modules",
      "@xenova",
      "transformers",
    );

    it.skipIf(!existsSync(realDeps))(
      "should build a real bundle via system bun and pass the import smoke",
      async () => {
        const intDir = mkdtempSync(join(tmpdir(), "sentinal-bundle-int-"));
        try {
          // Reuse the machine's installed deps via symlink — no 150MB install
          symlinkSync(
            join(process.env.HOME!, ".sentinal", "deps", "node_modules"),
            join(intDir, "node_modules"),
          );

          const result = await buildTransformersBundle({ depsDir: intDir });

          expect(result.ok).toBe(true);
          expect(result.bundler).toBe("bun");
          expect(existsSync(join(intDir, BUNDLE_REL_PATH))).toBe(true);
          // Import smoke ran and passed (reported by the builder)
          expect(result.report.join("\n")).toContain("import smoke passed");
        } finally {
          rmSync(intDir, { recursive: true, force: true });
        }
      },
      120_000,
    );
  });

  describe("isBundleFresh", () => {
    it("should be false when no bundle exists", () => {
      expect(isBundleFresh(depsDir)).toBe(false);
    });

    it("should be true when meta version matches the installed package", async () => {
      await buildTransformersBundle({
        depsDir,
        spawner: bundleCreatingSpawner([]),
        skipSmoke: true,
      });
      expect(isBundleFresh(depsDir)).toBe(true);
    });

    it("should be false when the installed package version changed", async () => {
      await buildTransformersBundle({
        depsDir,
        spawner: bundleCreatingSpawner([]),
        skipSmoke: true,
      });
      layoutDeps(depsDir, "3.0.0"); // simulate upgrade
      expect(isBundleFresh(depsDir)).toBe(false);
    });
  });
});
