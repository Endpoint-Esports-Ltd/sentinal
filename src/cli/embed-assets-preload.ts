/**
 * Test Preload — ensure generated embedded-assets.ts exists.
 *
 * `src/cli/embedded-assets.ts` is generated (see scripts/embed-assets.mjs) and
 * intentionally NOT committed to git. Several test files import it
 * (target-assets.test.ts, plugin-exports.test.ts, file-length.test.ts) and the
 * install/update commands import it as source. On a fresh checkout the file is
 * absent, which would break `bun test` at import resolution.
 *
 * This preload (registered in bunfig.toml `[test] preload`) generates the file
 * if — and only if — it is missing. When present (the common case) it is a
 * single stat + early return, so it adds no meaningful cost to the test run.
 *
 * Regenerating on every run is deliberately avoided: the generator shells out to
 * `bun build` (the OpenCode plugin bundle), which is ~100ms and pointless when
 * the file is already current from a prior build/install.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const GENERATED = join(REPO_ROOT, "src", "cli", "embedded-assets.ts");

if (!existsSync(GENERATED)) {
  // Use the full `embed-assets` script — it runs build:opencode first, which
  // produces the plugin bundle (targets/opencode/dist/sentinal.mjs) that the
  // generator requires. Calling the bare generator on a clean checkout (where
  // dist/ does not yet exist) fails with "Plugin bundle not found".
  const result = spawnSync("bun", ["run", "embed-assets"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `embed-assets-preload: failed to generate ${GENERATED} ` +
        `(exit ${result.status}). Run 'bun run embed-assets' manually.`,
    );
  }
}
