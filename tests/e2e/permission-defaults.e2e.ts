// D4a permission-default round-trip E2E (Layer A, deterministic, CI-safe).
//
// Proves R12 empirically: what actually survives an in-place `sentinal install`
// after a user edits the shipped `pkill` / `killall` -> "ask" default out of
// their own installed config.
//
// A static presence test in targets/ proves nothing about this. The installer
// deep-merges ADDITIVELY (src/cli/commands/install-opencode-config.ts -> deepMergeAdditive
// at :919), so "delete the line" and "change the value" have OPPOSITE outcomes,
// and the user-facing documentation has to say which one is durable.
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default glob) never discovers it. Run explicitly:
//   bun test ./tests/e2e/permission-defaults.e2e.ts
//
// ⛔ Because bun's default glob cannot find this file, being listed by NAME is
// the only thing that makes it run at all. It is therefore pinned in BOTH
// `package.json`'s `e2e` script AND `scripts/pre-release.mjs`'s `GATE_FILES`.
// It was in neither for a while, which meant master DoD item 9 had no live
// proof despite this file existing. If you add another `*.e2e.ts`, add it to
// both lists in the same commit or it is dead weight.
//
// TDD note: this file IS the test — there is no separate implementation.

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./harness/sandbox.ts";

const INSTALL_TIMEOUT = 180_000;
const RESOLVE_TIMEOUT = 300_000;

type BashPolicy = Record<string, string> | string | undefined;
interface OcConfig {
  permission?: { bash?: BashPolicy; [k: string]: unknown };
  [k: string]: unknown;
}

let realBefore: Record<string, string>;
beforeAll(() => {
  realBefore = snapshotRealDirs();
});

describe("D4a opt-out default — install round-trip (R12)", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  const cfgPathFor = (home: string) =>
    join(home, ".config", "opencode", "opencode.json");

  const readCfg = (home: string): OcConfig =>
    JSON.parse(readFileSync(cfgPathFor(home), "utf-8")) as OcConfig;

  const writeCfg = (home: string, cfg: OcConfig) =>
    writeFileSync(cfgPathFor(home), JSON.stringify(cfg, null, 2) + "\n");

  const bashMap = (cfg: OcConfig): Record<string, string> =>
    (cfg.permission?.bash ?? {}) as Record<string, string>;

  it(
    "ships pkill/killall -> ask on a fresh install, at the global config path",
    () => {
      sb = createSandbox();
      expect(sb.install("opencode").exitCode).toBe(0);

      // The exact path it lands in (global install; `--local` would use
      // <cwd>/opencode.json instead — install-opencode.ts).
      expect(sb.exists(cfgPathFor(sb.home))).toBe(true);

      const bash = bashMap(readCfg(sb.home));
      expect(bash["pkill*"]).toBe("ask");
      expect(bash["killall*"]).toBe("ask");
    },
    INSTALL_TIMEOUT,
  );

  it(
    "RE-ADDS the entry when the user DELETES it — a deletion is NOT durable",
    () => {
      sb = createSandbox();
      expect(sb.install("opencode").exitCode).toBe(0);

      // User deletes the line.
      const cfg = readCfg(sb.home);
      const bash = bashMap(cfg);
      delete bash["pkill*"];
      delete bash["killall*"];
      cfg.permission = { ...cfg.permission, bash };
      writeCfg(sb.home, cfg);
      expect(bashMap(readCfg(sb.home))["pkill*"]).toBeUndefined();

      // In-place update.
      expect(sb.install("opencode").exitCode).toBe(0);

      // deepMergeAdditive copies keys that are ABSENT from the target, so a
      // deleted key comes straight back. This is why the shipped documentation
      // must NOT tell users to delete the line.
      const after = bashMap(readCfg(sb.home));
      expect(after["pkill*"]).toBe("ask");
      expect(after["killall*"]).toBe("ask");
    },
    INSTALL_TIMEOUT,
  );

  it(
    "PRESERVES a user's changed value — setting it to allow IS durable",
    () => {
      sb = createSandbox();
      expect(sb.install("opencode").exitCode).toBe(0);

      const cfg = readCfg(sb.home);
      cfg.permission = {
        ...cfg.permission,
        bash: { ...bashMap(cfg), "pkill*": "allow", "killall*": "allow" },
      };
      writeCfg(sb.home, cfg);

      expect(sb.install("opencode").exitCode).toBe(0);

      // Key is PRESENT with a scalar value -> target wins, source ignored.
      const after = bashMap(readCfg(sb.home));
      expect(after["pkill*"]).toBe("allow");
      expect(after["killall*"]).toBe("allow");
    },
    INSTALL_TIMEOUT,
  );
});

// ── Resolved-policy pin ──────────────────────────────────────────────────────
//
// The shipped `permission.bash` map has NO `"*"` key. Everything above only
// proves the two guarded keys are PRESENT in the file — nothing proved what
// OpenCode actually RESOLVES them to, and the difference matters enormously:
//
//   `Permission.evaluate` falls back to `{action:"ask"}` when NO rule matches.
//   If a wildcard-less bash map meant benign commands matched nothing, every
//   bash command would prompt, for every user, on upgrade. That is the single
//   worst blast radius in this change and it must not rest on inference.
//
// So: install into the sandbox, start the REAL `opencode serve`, read the
// FULLY RESOLVED `Agent.permission` from `GET /agent`, and assert the outcome.

/**
 * OpenCode's `Wildcard.match`, transcribed from the shipped binary
 * (1.18.15, minified symbol `ql`). Kept verbatim — a "close enough"
 * reimplementation would defeat the purpose of pinning real behaviour.
 */
function wildcardMatch(value: string, pattern: string): boolean {
  const v = value.replaceAll("\\", "/");
  let p = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (p.endsWith(" .*")) p = p.slice(0, -3) + "( .*)?";
  return new RegExp("^" + p + "$", "s").test(v);
}

interface ResolvedRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

/**
 * OpenCode's `Permission.evaluate` (minified symbol `c`):
 *   `rules.findLast(r => match(permission, r.permission) && match(value, r.pattern))
 *      ?? { action: "ask" }`
 *
 * Note BOTH halves: `findLast` is what makes it last-match-wins, and the `??`
 * is the ask-by-default fallback this test exists to prove we never hit.
 */
function evaluateBash(command: string, rules: ResolvedRule[]): string {
  return (
    rules.findLast(
      (r) =>
        wildcardMatch("bash", r.permission) &&
        wildcardMatch(command, r.pattern),
    )?.action ?? "ask"
  );
}

function findOpencodeBinary(): string | null {
  const candidates = [join(homedir(), ".opencode", "bin", "opencode")];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = Bun.spawnSync(["which", "opencode"], { stdout: "pipe" });
  const p = (which.stdout?.toString() ?? "").trim();
  return p && existsSync(p) ? p : null;
}

/**
 * Resolved at module load so the gate below can use `it.skipIf`.
 *
 * ⛔ This is a PATH/stat lookup only — no sandbox is built and nothing is
 * spawned in the real HOME, so it does not violate the isolation contract the
 * rest of this file keeps.
 */
const OPENCODE_BINARY = findOpencodeBinary();

/** Start `opencode serve` inside the sandbox and return its resolved agents. */
async function resolveAgents(
  sb: Sandbox,
  binary: string,
): Promise<Array<{ name: string; permission: ResolvedRule[] }>> {
  const projectDir = join(sb.home, "oc-project");
  mkdirSync(projectDir, { recursive: true });
  // Random high port — parallel e2e runs must not collide on a fixed one.
  const port = 41000 + Math.floor(Math.random() * 20000);

  const proc = Bun.spawn([binary, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    env: {
      ...(sb.env as Record<string, string>),
      // opencode also keys off the data/cache/state dirs; keep every one of
      // them inside the sandbox so the real ~/.local/share/opencode is untouched.
      XDG_DATA_HOME: join(sb.home, ".local", "share"),
      XDG_CACHE_HOME: join(sb.home, ".cache"),
      XDG_STATE_HOME: join(sb.home, ".local", "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const url = `http://127.0.0.1:${port}/agent`;
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(1000);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return await res.json();
      } catch {
        /* not up yet */
      }
    }
    throw new Error(`opencode serve did not become ready on port ${port}`);
  } finally {
    proc.kill();
  }
}

describe("D4a opt-out default — RESOLVED policy (not just file presence)", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    assertNoRealEscape(realBefore);
  });

  /** Agents a user actually drives. `compaction`/`summary`/`title` are internal. */
  const USER_FACING = ["build", "plan", "general", "explore"];
  const BENIGN = ["ls -la", "git status", "bun test", "npm run build"];
  const GUARDED = ["pkill -f some-pattern", "killall node", "pkill", "killall"];

  /**
   * ⛔ `it.skipIf`, NOT an early `return` inside the body.
   *
   * This assertion is the ONLY live proof of master DoD item 9 — that the
   * shipped `permission.bash` map resolves benign commands to `allow` rather
   * than falling through to `Permission.evaluate`'s ask-by-default. An early
   * `return` made the run report **`(pass)`** on a machine with no `opencode`
   * installed, so the one thing that could have caught a wildcard-less map
   * prompting on every bash command reported green having asserted NOTHING.
   * `skipIf` reports it in bun's `N skip` count instead, which is the honest
   * signal and is visible in the pre-release gate output.
   *
   * Every other binary-gated e2e in this directory already uses `skipIf`
   * (`real-binary`, `release-identity`, `release-install`, `release-deps`);
   * this file was the sole holdout.
   */
  it.skipIf(!OPENCODE_BINARY)(
    "resolves benign bash to ALLOW and only pkill/killall to ASK, with no '*' key in the shipped map",
    async () => {
      const binary = OPENCODE_BINARY!;

      sb = createSandbox();
      expect(sb.install("opencode").exitCode).toBe(0);

      // Precondition: the map really is wildcard-less, so the assertions below
      // are testing the risky shape and not an accidentally-safe one.
      const installed = JSON.parse(
        readFileSync(
          join(sb.home, ".config", "opencode", "opencode.json"),
          "utf-8",
        ),
      ) as OcConfig;
      const bash = (installed.permission?.bash ?? {}) as Record<string, string>;
      expect(Object.keys(bash)).not.toContain("*");

      const agents = await resolveAgents(sb, binary);
      expect(agents.length).toBeGreaterThan(0);

      for (const name of USER_FACING) {
        const agent = agents.find((a) => a.name === name);
        if (!agent) continue; // agent set varies by version; don't invent a failure
        for (const cmd of BENIGN) {
          expect(`${name}: ${cmd} -> ${evaluateBash(cmd, agent.permission)}`).toBe(
            `${name}: ${cmd} -> allow`,
          );
        }
        for (const cmd of GUARDED) {
          expect(`${name}: ${cmd} -> ${evaluateBash(cmd, agent.permission)}`).toBe(
            `${name}: ${cmd} -> ask`,
          );
        }
      }
    },
    RESOLVE_TIMEOUT,
  );
});
