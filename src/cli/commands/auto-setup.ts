/**
 * Semantic Search Auto-Setup
 *
 * Shared helper that runs `runMemorySetup()` (src/memory/setup.ts) as a
 * visible, NON-FATAL step at the end of `sentinal install` and
 * `sentinal update --reinstall-plugins`. Setup itself is an idempotent
 * fast no-op when already provisioned, so calling it on every
 * install/update costs milliseconds in the common case.
 *
 * Honors SENTINAL_NO_AUTO_SETUP=1 (single skip line, no setup call).
 * Never throws — an install must never fail because of semantic search.
 */

import { runMemorySetup } from "../../memory/setup.js";
import type { MemorySetupResult } from "../../memory/setup.js";

/** Injectable setup runner (default: runMemorySetup). */
export type AutoSetupRunner = () => Promise<MemorySetupResult>;

const MANUAL_HINT = "Run 'sentinal memory setup' manually.";

/**
 * Run semantic search setup as a best-effort post-install step.
 *
 * @param label Context shown in output ("install" or "update").
 * @param runner Injectable for tests; default runs the real setup.
 */
export async function runAutoSetup(
  label: string,
  runner: AutoSetupRunner = () => runMemorySetup(),
): Promise<void> {
  if (process.env.SENTINAL_NO_AUTO_SETUP === "1") {
    console.log(
      "Semantic search auto-setup skipped (SENTINAL_NO_AUTO_SETUP=1).",
    );
    return;
  }

  console.log(`\nSetting up semantic search (${label})...`);
  try {
    const result = await runner();
    console.log(result.report);
    if (!result.ok) {
      console.error(`Semantic search setup did not complete. ${MANUAL_HINT}`);
    }
  } catch (e) {
    console.error(`Semantic search setup failed: ${(e as Error).message}`);
    console.error(MANUAL_HINT);
  }
}
