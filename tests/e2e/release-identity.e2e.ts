// Version/identity gate (Task 2 of the E2E release-artifact gate).
//
// PURPOSE: prove the release gate is exercising the INTENDED release artifact,
// not a stale dev build. `sentinal --version` alone is provably insufficient:
// a local release build and the dev `dist/sentinal` are compiled from the SAME
// package.json, so their version strings are IDENTICAL. The binaryPath identity
// check is the ONLY thing that catches a silent dev-fallback (pre-mortem #1).
//
// This whole file is gated on SENTINAL_E2E_BINARY. When unset it does ZERO
// sandbox work (green-by-skip), mirroring tests/e2e/real-binary.e2e.ts.
//
// Run enabled:  SENTINAL_E2E_BINARY=$(pwd)/dist/sentinal bun test ./tests/e2e/release-identity.e2e.ts
// Run skipped:  bun test ./tests/e2e/release-identity.e2e.ts

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./harness/sandbox.ts";

const BIN = process.env.SENTINAL_E2E_BINARY;
const TIMEOUT = 60_000;

// REPO_ROOT = two levels up from tests/e2e/.
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_SRC = join(REPO_ROOT, "src", "cli", "index.ts");

// Expected version: explicit override wins, else the repo package.json version.
function expectedVersion(): string {
  if (process.env.SENTINAL_E2E_EXPECT_VERSION) {
    return process.env.SENTINAL_E2E_EXPECT_VERSION;
  }
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  ) as { version: string };
  return pkg.version;
}

describe("release identity gate (SENTINAL_E2E_BINARY)", () => {
  // Non-gated smoke: ALWAYS runs, does no sandbox work. Documents the guard so
  // the file is green-by-skip in the plain e2e suite (mirrors real-binary.e2e.ts).
  it("is green-by-skip with zero side effects when SENTINAL_E2E_BINARY is unset", () => {
    if (BIN) {
      // When set, the gated case below carries the coverage; this is a no-op.
      expect(typeof BIN).toBe("string");
      return;
    }
    expect(BIN).toBeUndefined();
  });

  let realBefore: Record<string, string>;
  let sb: Sandbox | undefined;

  beforeAll(() => {
    realBefore = snapshotRealDirs();
  });

  afterEach(() => {
    sb?.cleanup();
    sb = undefined;
  });

  it.skipIf(!BIN)(
    "runs the requested binary (identity) and reports the expected version",
    () => {
      sb = createSandbox();

      // ── Identity (the falsifiable core) ─────────────────────────────────────
      // resolveEntry() guarantees: when SENTINAL_E2E_BINARY is set it either
      // THROWS (missing) or returns [resolve(override)]. There is NO code path
      // where the override is set yet binaryPath falls back to the dev build, so
      // the strongest correct+falsifiable assertion is exact equality with the
      // resolved override. If a regression made entry() ignore the override and
      // return CLI_COMPILED (dist/sentinal) or the bun-src fallback, this fails
      // (unless the override literally IS that path).
      const wantedBinary = resolve(BIN!);
      expect(sb.binaryPath).toBe(wantedBinary);

      // Reject the bun-src fallback unconditionally: the dev fallback
      // ["bun", CLI_SRC] would set binaryPath to CLI_SRC (…/src/cli/index.ts).
      // That path can never be a legitimate release-artifact override, so this
      // catches a silent source-mode fallback regardless of the override value.
      expect(sb.binaryPath).not.toBe(CLI_SRC);
      expect(sb.binaryPath.endsWith(join("src", "cli", "index.ts"))).toBe(false);

      // NOTE on the "reject the dev dist/sentinal build" requirement: a blanket
      // "binaryPath must NOT end with /dist/sentinal" is WRONG when the caller
      // deliberately points SENTINAL_E2E_BINARY AT dist/sentinal (the Task 2
      // verify command does exactly that). In that case binaryPath legitimately
      // ends with /dist/sentinal AND equals resolve(override) — that is correct,
      // not a fallback. The falsifiable dev-fallback guard is therefore:
      // "binaryPath must equal the requested override" (already asserted above)
      // PLUS "if the override is NOT dist/sentinal, binaryPath must not be the
      // dev CLI_COMPILED path". We express the conditional half here.
      const devCompiled = join(REPO_ROOT, "dist", "sentinal");
      if (wantedBinary !== resolve(devCompiled)) {
        expect(sb.binaryPath).not.toBe(resolve(devCompiled));
      }

      // ── Version ─────────────────────────────────────────────────────────────
      // Use cwd: sb.home (always exists). The harness default cwd is
      // <home>/work, which is only created by install(); we do not install here,
      // and posix_spawn returns ENOENT when the cwd is missing.
      const res = sb.run(["--version"], { cwd: sb.home });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe(expectedVersion());

      assertNoRealEscape(realBefore);
    },
    TIMEOUT,
  );
});
