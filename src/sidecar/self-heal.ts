/**
 * Sidecar Vector Self-Heal
 *
 * When vector search degrades because native deps are MISSING (compiled
 * binaries can't bundle sqlite-vec / @xenova/transformers), the sidecar
 * provisions itself: it spawns its own binary's `memory setup` and re-runs
 * vector init — zero user action.
 *
 * Gates (ALL must hold before an attempt):
 *   1. Degrade reason indicates missing deps ("not available" / SETUP_HINT).
 *      Extension-load failures ("not authorized", "loadExtension") are NOT
 *      healable by setup and never trigger.
 *   2. env SENTINAL_NO_AUTO_SETUP !== "1".
 *   3. Version-scoped settings backoff key not set. The key is written at
 *      attempt START so a crashed attempt cannot retry-loop. This same key
 *      makes recursion impossible: the reinit callback re-enters
 *      initVectorSearch, whose degrade path fires self-heal again, but the
 *      key is already set so the second invocation is a no-op.
 *   4. Running as a COMPILED binary (`__SENTINAL_VERSION__` build define).
 *      Source runs always skip (tests use opts.forceCompiled).
 *
 * Spawn target is `process.execPath` — the RUNNING binary itself — never
 * ~/.sentinal/bin/sentinal, which can be an older binary.
 *
 * Import-cycle note: vector-init.ts imports this module at runtime, so this
 * module only imports vector-init TYPES. The reinit callback is injected by
 * the caller instead of importing initVectorSearch here.
 */

import { spawn } from "node:child_process";
import { SETUP_HINT } from "../memory/native-deps.js";
import { logSidecar } from "../utils/file-log.js";
import type { MemoryStore } from "../memory/store.js";
import type { VectorSearchState } from "./vector-init.js";

// ─── Version-Scoped Backoff Key ──────────────────────────────────────────────

declare const __SENTINAL_VERSION__: string | undefined;

function sentinalVersion(): string {
  if (typeof __SENTINAL_VERSION__ !== "undefined") {
    return __SENTINAL_VERSION__;
  }
  return "dev";
}

/**
 * Settings key marking that automatic setup was attempted for this version.
 * Written at attempt START — crashed attempts must not retry-loop.
 */
export const VECTOR_AUTOSETUP_ATTEMPTED_KEY = `vector_autosetup_attempted_${sentinalVersion()}`;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal sidecar surface the self-heal needs (structural subset of SidecarContext). */
export interface SelfHealContext {
  store: MemoryStore;
  vectorState?: VectorSearchState;
}

export interface SelfHealOptions {
  /** Spawn a command, resolve with its exit code. Injectable for tests. */
  spawner?: (cmd: string, args: string[]) => Promise<number>;
  /** Re-initialize vector search after a successful setup (injected by vector-init). */
  reinit?: () => Promise<void>;
  /** Test override for the compiled-binary gate. */
  forceCompiled?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * True when the degrade reason is something `memory setup` can fix (missing
 * native deps). Homebrew-SQLite / extension-load failures are not healable.
 */
function isMissingDepsError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  if (lower.includes("not authorized")) return false;
  if (lower.includes("loadextension")) return false;
  return lower.includes("not available") || error.includes(SETUP_HINT);
}

const defaultSpawner = (cmd: string, args: string[]): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: false, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

// ─── Self-Heal ───────────────────────────────────────────────────────────────

/**
 * Attempt automatic provisioning of missing vector deps. Fire-and-forget
 * safe (never throws). Returns true when an attempt was made (regardless of
 * outcome), false when a gate skipped it.
 */
export async function maybeSelfHealVectorDeps(
  ctx: SelfHealContext,
  opts: SelfHealOptions = {},
): Promise<boolean> {
  const state = ctx.vectorState;
  if (!state || state.status !== "unavailable") return false;
  if (!isMissingDepsError(state.error)) return false;
  if (process.env.SENTINAL_NO_AUTO_SETUP === "1") return false;

  const compiled =
    opts.forceCompiled ?? typeof __SENTINAL_VERSION__ !== "undefined";
  if (!compiled) return false;

  try {
    if (ctx.store.getSetting(VECTOR_AUTOSETUP_ATTEMPTED_KEY) !== null) {
      return false;
    }
    // Backoff key at attempt START — also makes reinit recursion a no-op.
    ctx.store.setSetting(VECTOR_AUTOSETUP_ATTEMPTED_KEY, String(Date.now()));
  } catch {
    return false; // store unavailable — never heal without backoff protection
  }

  logSidecar("sidecar: vector deps missing — attempting automatic setup");

  let exitCode: number;
  try {
    // process.execPath = the RUNNING binary, never a possibly-stale BIN_PATH.
    exitCode = await (opts.spawner ?? defaultSpawner)(process.execPath, [
      "memory",
      "setup",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSidecar(
      `sidecar: automatic setup spawn failed — ${message}. ${SETUP_HINT}`,
    );
    return true;
  }

  if (exitCode !== 0) {
    logSidecar(
      `sidecar: automatic setup exited with code ${exitCode}. ${SETUP_HINT}`,
    );
    return true;
  }

  try {
    await opts.reinit?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSidecar(
      `sidecar: vector re-init after setup failed — ${message}. ${SETUP_HINT}`,
    );
    return true;
  }

  if (ctx.vectorState?.status === "ready") {
    try {
      ctx.store.insertNotification({
        type: "info",
        title: "Semantic search enabled",
        message:
          "Missing native dependencies were installed automatically; semantic vector search is now active.",
        source: "self-heal",
      });
    } catch {
      /* notification is best-effort */
    }
    logSidecar("sidecar: automatic setup succeeded — vector search ready");
  } else {
    logSidecar(
      `sidecar: setup completed but vector search is still unavailable — ${ctx.vectorState?.error ?? "unknown"}. ${SETUP_HINT}`,
    );
  }
  return true;
}
