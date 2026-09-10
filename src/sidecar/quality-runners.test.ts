/**
 * Quality Runners Tests (Task 6 D2 ride-along)
 *
 * The tsbuildinfo cache dirs must resolve through `getSentinalHome()` so a
 * `SENTINAL_HOME` override (set for every test run by test-preload) redirects
 * them — mirroring the `db-path.test.ts` guard pattern. Before the fix they
 * hardcoded `homedir()/.sentinal` and every suite run wrote to the real tree.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runTsc } from "./quality-runners.js";
import { projectHash } from "../analysis/helpers.js";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

let projDir: string;

beforeAll(() => {
  projDir = join(tmpdir(), `qr-d2-${Date.now().toString(36)}`);
  mkdirSync(join(projDir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(projDir, "tsconfig.json"), "{}");
  writeFileSync(join(projDir, "package.json"), "{}");
  // Fake local tsc: instant success — we only care where the cache lands.
  writeFileSync(
    join(projDir, "node_modules", ".bin", "tsc"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(projDir, { recursive: true, force: true });
});

describe("runTsc tsbuildinfo cache location (D2)", () => {
  it("writes the tsbuildinfo cache dirs under SENTINAL_HOME, not the real ~/.sentinal", async () => {
    const home = process.env.SENTINAL_HOME;
    expect(home).toBeTruthy(); // test-preload always sets it
    expect(home).not.toBe(join(homedir(), ".sentinal"));

    const result = await runTsc(projDir, 10_000);
    expect(result.ok).toBe(true);

    const hash = projectHash(projDir);
    // shouldInvalidateTsBuildInfo unconditionally writes the meta file,
    // and runTsc mkdirs the tsbuildinfo dir — both must be under the override.
    expect(existsSync(join(home!, "tsbuildinfo-meta", `${hash}.json`))).toBe(
      true,
    );
    expect(existsSync(join(home!, "tsbuildinfo"))).toBe(true);
  }, 15_000);
});
