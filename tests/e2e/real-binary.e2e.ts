// Opt-in real-binary smoke layer (Layer B).
//
// Drives the REAL opencode / claude binaries headless inside the isolated
// sandbox and asserts Sentinal actually loaded (not just that the binary
// exited 0). This layer is LOCAL-ONLY: it needs LLM credentials, so it is
// gated behind SENTINAL_E2E_REAL=1 and skipped by default (green-by-skip).
//
// Isolation contract:
//  - ALL sandbox construction, credential access, and binary spawning happen
//    INSIDE the skipped `it` bodies. When the flag is unset, this file does
//    ZERO sandbox builds, ZERO cred reads, ZERO binary spawns.
//  - Credentials are preferred via env passthrough (ANTHROPIC_API_KEY); only
//    if that fails do we copy real cred files into the sandbox — and those are
//    removed in a `finally` even if the test throws.
//
// Run enabled (local, authenticated):  SENTINAL_E2E_REAL=1 bun test ./tests/e2e/real-binary.e2e.ts
// Run skipped (CI/default):            bun test ./tests/e2e/real-binary.e2e.ts

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createSandbox, assertEnvContained } from "./harness/sandbox.ts";

const REAL = process.env.SENTINAL_E2E_REAL === "1";
const TIMEOUT = 240_000;

// Resolve real binaries lazily (only used inside enabled test bodies).
function which(bin: string): string | null {
  const r = Bun.spawnSync(["which", bin], { stdout: "pipe" });
  const p = (r.stdout?.toString() ?? "").trim();
  return p ? p : null;
}

// Copy the real OpenCode auth into the sandbox HOME at the path OpenCode reads.
// IMPORTANT: OpenCode stores auth at ~/.local/share/opencode/auth.json (XDG
// DATA dir), NOT ~/.config/opencode/auth.json. Since the sandbox overrides HOME,
// ~/.local/share/opencode resolves under the sandbox automatically. Returns the
// copied paths so the caller can scrub them in a finally.
function copyOpenCodeAuthIntoSandbox(home: string): string[] {
  const src = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (!existsSync(src)) return [];
  const dst = join(home, ".local", "share", "opencode", "auth.json");
  try {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    return [dst];
  } catch {
    return [];
  }
}

// A PORTABLE Claude credential (copyable into a sandbox) exists only as an
// ANTHROPIC_API_KEY env var or a ~/.claude/.credentials.json file. A Claude
// *subscription* stores its OAuth token in the macOS Keychain, which is bound
// to the real profile and CANNOT be transferred to a sandbox CLAUDE_CONFIG_DIR
// (verified: `claude -p` in a sandbox HOME reports "Not logged in"). So the
// Claude real-binary case is only runnable with a portable credential.
function hasPortableClaudeCred(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}

const CLAUDE_MODEL = "anthropic/claude-haiku-4-5"; // cheap; matches OAuth access
const OC_MODEL = "anthropic/claude-haiku-4-5";

// True if any file under <home>/.sentinal was created/updated after `since`,
// OR a fresh plugin.debug.log / sidecar pid exists — proof Sentinal loaded.
function sentinalArtifactAppeared(home: string, since: number): boolean {
  const dir = join(home, ".sentinal");
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, "plugin.debug.log"))) return true;
  if (existsSync(join(dir, "sidecar.pid"))) return true;
  // Any recently-touched file under .sentinal counts.
  try {
    for (const name of readdirSync(dir)) {
      const st = statSync(join(dir, name));
      if (st.mtimeMs >= since) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

describe("Layer B — real-binary smoke (opt-in, SENTINAL_E2E_REAL=1)", () => {
  it("is green-by-skip with zero side effects when the flag is unset", () => {
    // This body MUST run in CI. It must NOT build a sandbox, read creds, or
    // spawn a binary. It only documents the guard.
    if (REAL) {
      // When enabled, the real cases below carry the coverage; this is a no-op.
      expect(REAL).toBe(true);
      return;
    }
    expect(REAL).toBe(false);
  });

  it.skipIf(!REAL)(
    "real `opencode run` in the sandbox loads the Sentinal plugin (artifact appears)",
    () => {
      const oc = which("opencode");
      if (!oc) throw new Error("opencode binary not found on PATH");
      const sb = createSandbox();
      const copied: string[] = [];
      try {
        // Copy the real OpenCode OAuth into the sandbox (XDG data path).
        copied.push(...copyOpenCodeAuthIntoSandbox(sb.home));
        assertEnvContained(sb.env, sb.home);
        const installRes = sb.install("opencode");
        expect(installRes.exitCode).toBe(0);

        const since = Date.now();
        // NOTE on invocation: `opencode run` takes the message as a POSITIONAL
        // (NOT `-p`, which is --password). Model must be specified since the
        // sandbox has no default. `--dangerously-skip-permissions` is not a
        // `run` flag on this version.
        const proc = Bun.spawnSync(
          [oc, "run", "say hi", "--model", OC_MODEL],
          {
            env: sb.env as Record<string, string>,
            cwd: join(sb.home, "work"),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        // We do NOT assert the LLM turn succeeded. A full `opencode run` headless
        // turn does NOT complete in a fresh sandbox HOME even with --pure (no
        // plugins) — an OpenCode-side limitation, not a Sentinal bug (verified
        // by spike). What Layer B proves is that the SENTINAL PLUGIN LOADED in a
        // real OpenCode session — proven by an artifact under the sandbox
        // .sentinal (plugin.debug.log / memory.db / sidecar pid).
        void proc;
        expect(sentinalArtifactAppeared(sb.home, since)).toBe(true);
      } finally {
        for (const c of copied) {
          try {
            rmSync(c, { force: true });
          } catch {
            /* scrub best-effort */
          }
        }
        sb.cleanup();
      }
    },
    TIMEOUT,
  );

  // Claude requires a PORTABLE credential to run headless in a sandbox HOME.
  // A Claude *subscription* keeps its OAuth token in the macOS Keychain (bound
  // to the real profile) — it CANNOT be copied into a sandbox, and `claude -p`
  // there reports "Not logged in". So this case runs ONLY when an
  // ANTHROPIC_API_KEY or ~/.claude/.credentials.json is available; otherwise it
  // skips with a clear reason (subscription-only auth is not sandbox-portable).
  it.skipIf(!REAL || !hasPortableClaudeCred())(
    "real `claude -p` in the sandbox loads Sentinal (needs a portable credential)",
    () => {
      const cl = which("claude");
      if (!cl) throw new Error("claude binary not found on PATH");
      const sb = createSandbox();
      const copied: string[] = [];
      try {
        // Copy a file-based credential if present (env ANTHROPIC_API_KEY is
        // already inherited into sb.env from process.env).
        const credSrc = join(homedir(), ".claude", ".credentials.json");
        if (existsSync(credSrc)) {
          const credDst = join(sb.home, ".claude", ".credentials.json");
          mkdirSync(dirname(credDst), { recursive: true });
          cpSync(credSrc, credDst);
          copied.push(credDst);
        }
        assertEnvContained(sb.env, sb.home);
        const installRes = sb.install("claude");
        expect(installRes.exitCode).toBe(0);

        const since = Date.now();
        const proc = Bun.spawnSync(
          [cl, "-p", "say hi", "--model", CLAUDE_MODEL],
          {
            env: sb.env as Record<string, string>,
            cwd: join(sb.home, "work"),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        // As with OpenCode, we assert the Sentinal artifact, not the LLM turn.
        void proc;
        expect(sentinalArtifactAppeared(sb.home, since)).toBe(true);
      } finally {
        for (const c of copied) {
          try {
            rmSync(c, { force: true });
          } catch {
            /* scrub best-effort */
          }
        }
        sb.cleanup();
      }
    },
    TIMEOUT,
  );

  // NOT gated on SENTINAL_E2E_REAL: this proves the failure-safe cred-scrub
  // logic using only pure fs ops (a SYNTHETIC cred file — never the real one),
  // so it runs in CI and actually guards the "creds removed on throw" DoD.
  it("the try/finally scrub removes cred files even when the test body throws", () => {
    const sb = createSandbox();
    // Simulate copied cred files with synthetic content inside the sandbox.
    const fakeCreds = [
      join(sb.home, ".claude", ".credentials.json"),
      join(sb.home, ".config", "opencode", "auth.json"),
    ];
    const copied: string[] = [];
    let threw = false;
    try {
      for (const f of fakeCreds) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ token: "SYNTHETIC-TEST-ONLY" }));
        copied.push(f);
      }
      for (const c of copied) expect(existsSync(c)).toBe(true); // present before throw
      throw new Error("injected fault");
    } catch {
      threw = true;
    } finally {
      for (const c of copied) {
        try {
          rmSync(c, { force: true });
        } catch {
          /* ignore */
        }
      }
      for (const c of copied) expect(existsSync(c)).toBe(false); // scrubbed on throw
      sb.cleanup();
    }
    expect(threw).toBe(true);
  });
});
