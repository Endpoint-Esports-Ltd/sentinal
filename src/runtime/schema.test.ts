/**
 * Runtime contract schema + strict interpolator tests (Phase 3, Task 2).
 *
 * The load-bearing assertions here are the NEGATIVE ones:
 *   - a `${SENTINAL_*}` typo must be a named validation error, never an empty
 *     substitution;
 *   - an ordinary shell `${PORT:-3000}` must pass through UNCHANGED, because
 *     `up`/`down` are shell command strings that already exist in projects;
 *   - absence of an `isolation` key must be `unknown`, which is NOT `"shared"`.
 */

import { describe, it, expect } from "bun:test";
import {
  RuntimeConfigSchema,
  interpolateStrict,
  unknownSentinalTokens,
  isolationOf,
  sharedResourceNames,
  SLOT_TOKEN,
  SENTINAL_TOKENS,
  RESOURCE_CLASSES,
  ISOLATION_STATES,
  RUNTIME_CONFIG_RELATIVE_PATH,
  RUNTIME_LOG_RELATIVE_PATH,
  RUNTIME_PIDFILE_RELATIVE_PATH,
  RUNTIME_LOG_TAIL_LINES,
  INTERPOLATED_FIELDS,
} from "./schema.js";

const parse = (v: unknown) => RuntimeConfigSchema.parse(v);
const err = (v: unknown): string => {
  const r = RuntimeConfigSchema.safeParse(v);
  if (r.success) throw new Error("expected a validation failure, got success");
  return r.error.issues.map((i) => i.message).join("\n");
};

// ─── Constants ──────────────────────────────────────────────────────────────

describe("constants", () => {
  it("names the config, log and pidfile paths as worktree-local conventions", () => {
    expect(RUNTIME_CONFIG_RELATIVE_PATH).toBe(".sentinal/runtime.json");
    expect(RUNTIME_LOG_RELATIVE_PATH).toBe(".sentinal/runtime.log");
    // Phase 4: the ownership record lives beside the other two, so it is
    // hidden by the same `.sentinal/.gitignore` and dies with the worktree.
    expect(RUNTIME_PIDFILE_RELATIVE_PATH).toBe(".sentinal/runtime.pid");
  });

  it("documents a fixed log tail length for failure messages", () => {
    expect(RUNTIME_LOG_TAIL_LINES).toBe(50);
  });

  it("exposes a CLOSED Sentinal token namespace of exactly one token", () => {
    expect(SLOT_TOKEN).toBe("SENTINAL_WORKTREE_SLOT");
    expect([...SENTINAL_TOKENS]).toEqual(["SENTINAL_WORKTREE_SLOT"]);
  });

  it("interpolates exactly up, down and readiness.target", () => {
    expect([...INTERPOLATED_FIELDS]).toEqual([
      "up",
      "down",
      "readiness.target",
    ]);
  });

  it("has a closed resource vocabulary including browser (D11)", () => {
    expect(RESOURCE_CLASSES).toContain("ports");
    expect(RESOURCE_CLASSES).toContain("database");
    expect(RESOURCE_CLASSES).toContain("browser");
    expect([...ISOLATION_STATES]).toEqual(["isolated", "shared", "none"]);
    // "unknown" is the ABSENCE of a key, never a value.
    expect(ISOLATION_STATES as readonly string[]).not.toContain("unknown");
  });
});

// ─── Happy path + defaults ──────────────────────────────────────────────────

describe("RuntimeConfigSchema — valid configs", () => {
  it("parses the full documented example and applies every default", () => {
    const cfg = parse({
      isolation: { ports: "isolated", database: "shared", cache: "none" },
      up: "./scripts/stack up ${SENTINAL_WORKTREE_SLOT}",
      down: "./scripts/stack down ${SENTINAL_WORKTREE_SLOT}",
      readiness: { type: "http", target: "http://localhost:3000/health" },
    });

    expect(cfg.detached).toBe(false);
    expect(cfg.readiness?.startupTimeoutMs).toBe(60000);
    expect(cfg.readiness?.pollIntervalMs).toBe(250);
    expect(cfg.shutdown.signal).toBe("SIGTERM");
    expect(cfg.shutdown.graceMs).toBe(10000);
  });

  it("parses an empty object — nothing is required", () => {
    const cfg = parse({});
    expect(cfg.up).toBeUndefined();
    expect(cfg.isolation).toBeUndefined();
  });

  it("desugars the bare-string readiness shorthand to an http probe", () => {
    const cfg = parse({
      up: "npm start",
      readiness: "http://localhost:3000/health",
    });
    expect(cfg.readiness).toMatchObject({
      type: "http",
      target: "http://localhost:3000/health",
      startupTimeoutMs: 60000,
      pollIntervalMs: 250,
    });
  });

  it("accepts an exec probe", () => {
    const cfg = parse({
      up: "npm start",
      readiness: { type: "exec", target: "nc -z localhost 3000" },
    });
    expect(cfg.readiness?.type).toBe("exec");
  });

  it("accepts a free-form `other` isolation entry", () => {
    const cfg = parse({
      isolation: {
        other: [{ name: "vendor sandbox account", state: "shared" }],
      },
    });
    expect(cfg.isolation?.other?.[0]).toEqual({
      name: "vendor sandbox account",
      state: "shared",
    });
  });

  it("rejects unknown top-level keys rather than silently dropping them", () => {
    expect(err({ bootstrap: "./setup.sh" })).toBeTruthy();
  });

  it("rejects a misspelled resource class rather than silently treating it as unknown", () => {
    // `db` would otherwise be an invisible no-op: the author believes they
    // declared the database, Sentinal sees nothing.
    expect(err({ isolation: { db: "shared" } })).toBeTruthy();
  });
});

// ─── Validation rules ───────────────────────────────────────────────────────

describe("RuntimeConfigSchema — validation rules", () => {
  it("rejects `up` without `readiness`", () => {
    const msg = err({ up: "npm start" });
    expect(msg).toContain("readiness");
  });

  it("rejects `detached: true` without `down`", () => {
    const msg = err({
      up: "npm start",
      readiness: "http://localhost:3000",
      detached: true,
    });
    expect(msg).toContain("down");
  });

  it("allows `down` to be absent when not detached", () => {
    expect(() =>
      parse({ up: "npm start", readiness: "http://localhost:3000" }),
    ).not.toThrow();
  });

  it("rejects `expectStatus` on a non-http probe", () => {
    const msg = err({
      up: "npm start",
      readiness: { type: "exec", target: "true", expectStatus: [200] },
    });
    expect(msg).toContain("expectStatus");
  });
});

// ─── Isolation: absence is `unknown`, and `unknown` is NOT `shared` ─────────

describe("isolation — absence is `unknown`, never `shared`", () => {
  it("reports `unknown` for a class with no key, distinct from `shared`", () => {
    const cfg = parse({ isolation: { database: "shared" } });
    expect(isolationOf(cfg, "database")).toBe("shared");
    expect(isolationOf(cfg, "cache")).toBe("unknown");
    expect(isolationOf(cfg, "ports")).toBe("unknown");
  });

  it("reports `unknown` for every class when the whole map is absent", () => {
    const cfg = parse({ up: "npm start", readiness: "http://x/health" });
    for (const cls of RESOURCE_CLASSES) {
      expect(isolationOf(cfg, cls)).toBe("unknown");
    }
  });

  it("names ONLY explicitly-shared resources — never unknown ones", () => {
    const cfg = parse({
      isolation: {
        ports: "isolated",
        database: "shared",
        cache: "none",
        other: [{ name: "stripe test account", state: "shared" }],
      },
    });
    const names = sharedResourceNames(cfg);
    expect(names).toContain("database");
    expect(names).toContain("stripe test account");
    expect(names).not.toContain("ports");
    expect(names).not.toContain("cache");
    // Classes with no key at all contribute nothing — `unknown` never blocks.
    expect(names).not.toContain("queue");
  });

  it("returns no shared names for a config with no isolation map", () => {
    expect(sharedResourceNames(parse({}))).toEqual([]);
  });

  it("returns no shared names for undefined (absent runtime.json)", () => {
    expect(sharedResourceNames(undefined)).toEqual([]);
  });
});

// ─── Token validation: scoped to the SENTINAL_ prefix ONLY ──────────────────

describe("token validation — SENTINAL_ prefix only", () => {
  it("errors on an unknown SENTINAL_ token, NAMING the token", () => {
    const msg = err({
      up: "./stack up ${SENTINAL_TYPO}",
      readiness: "http://localhost:3000",
    });
    expect(msg).toContain("${SENTINAL_TYPO}");
  });

  it("catches the realistic typo of the one known token", () => {
    const msg = err({
      up: "./stack up ${SENTINAL_WORKTREE_SLOTT}",
      readiness: "http://localhost:3000",
    });
    expect(msg).toContain("${SENTINAL_WORKTREE_SLOTT}");
  });

  it("ACCEPTS ordinary shell parameter expansion unchanged", () => {
    const cfg = parse({
      up: "PORT=${PORT:-3000} npm start",
      down: "kill ${PID}",
      readiness: "http://localhost:${PORT}/health",
    });
    expect(cfg.up).toBe("PORT=${PORT:-3000} npm start");
    expect(cfg.down).toBe("kill ${PID}");
  });

  it("ACCEPTS bare $VAR untouched — explicitly out of scope", () => {
    const cfg = parse({
      up: "bash -c 'echo $HOME && rm -rf $UNSET/tmp'",
      readiness: "http://localhost:3000",
    });
    expect(cfg.up).toBe("bash -c 'echo $HOME && rm -rf $UNSET/tmp'");
  });

  it("does NOT fall through to process.env within the SENTINAL_ prefix", () => {
    process.env.SENTINAL_MADE_UP = "surprise";
    try {
      const msg = err({
        up: "./stack up ${SENTINAL_MADE_UP}",
        readiness: "http://localhost:3000",
      });
      expect(msg).toContain("${SENTINAL_MADE_UP}");
    } finally {
      delete process.env.SENTINAL_MADE_UP;
    }
  });

  it("rejects a shell-defaulted Sentinal token — the prefix is Sentinal's", () => {
    const msg = err({
      up: "./stack up ${SENTINAL_WORKTREE_SLOT:-0}",
      readiness: "http://localhost:3000",
    });
    expect(msg).toContain("SENTINAL_WORKTREE_SLOT:-0");
  });

  it("validates readiness.target too — a slot-aware probe port must resolve", () => {
    const msg = err({
      up: "npm start",
      readiness: "http://localhost:30${SENTINAL_SLOT}0/health",
    });
    expect(msg).toContain("${SENTINAL_SLOT}");
  });

  it("validates token names WITHOUT needing a slot", () => {
    // Validation and substitution are separate: the slot is unknown at parse
    // time (it comes from readSlotFromWorktree at load time).
    expect(() =>
      parse({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:3000",
      }),
    ).not.toThrow();
  });
});

// The namespace itself is covered by `interpolate.test.ts`. What matters HERE
// is only that `schema.ts` stays the single import surface the plan's artifact
// table promises — a broken re-export would send callers to two modules.
describe("re-exports the closed namespace", () => {
  it("exposes the interpolator and token helpers", () => {
    expect(typeof interpolateStrict).toBe("function");
    expect(typeof unknownSentinalTokens).toBe("function");
    expect(interpolateStrict("s${SENTINAL_WORKTREE_SLOT}", 4)).toBe("s4");
  });
});
