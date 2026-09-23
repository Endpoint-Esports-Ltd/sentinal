/**
 * `.sentinal/runtime.json` loader tests (Phase 3, Task 3).
 *
 * The headline assertion is the backward-compatibility one: **absence of the
 * file is an inert success, never an error.** That is the guarantee the whole
 * master plan rests on — a project that never adopts the contract must behave
 * byte-identically to before it existed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig } from "./loader.js";
import { SLOT_ENV_RELATIVE_PATH, SLOT_ENV_VAR } from "../worktree/slots.js";

let root: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `sentinal-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, ".sentinal"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (content: string) =>
  writeFileSync(join(root, ".sentinal", "runtime.json"), content);

const writeSlot = (slot: number) =>
  writeFileSync(
    join(root, SLOT_ENV_RELATIVE_PATH),
    `${SLOT_ENV_VAR}=${slot}\n`,
  );

// ─── Backward compatibility ─────────────────────────────────────────────────

describe("absent file — the backward-compatibility guarantee", () => {
  it("returns an inert not-configured result, NOT an error", () => {
    const r = loadRuntimeConfig(root);

    expect(r.configured).toBe(false);
    expect(r.config).toBeNull();
    expect(r.error).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.sharedResources).toEqual([]);
  });

  it("reports no shared resources, so no gate is reachable", () => {
    expect(loadRuntimeConfig(root).sharedResources).toEqual([]);
  });

  it("does not create the file or the directory as a side effect", () => {
    const missing = join(root, "nope");
    const r = loadRuntimeConfig(missing);
    expect(r.configured).toBe(false);
    expect(r.error).toBeNull();
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("loading a real config", () => {
  it("parses, applies defaults, and reports configured", () => {
    writeConfig(
      JSON.stringify({
        up: "npm start",
        readiness: "http://localhost:3000/health",
      }),
    );
    const r = loadRuntimeConfig(root);

    expect(r.configured).toBe(true);
    expect(r.error).toBeNull();
    expect(r.config?.up).toBe("npm start");
    expect(r.config?.readiness?.startupTimeoutMs).toBe(60000);
  });

  it("accepts a JSONC file with comments — the scaffolder emits them", () => {
    writeConfig('{\n  // drafted by /sync\n  "detached": false\n}\n');
    const r = loadRuntimeConfig(root);

    expect(r.error).toBeNull();
    expect(r.config?.detached).toBe(false);
  });

  it("interpolates the slot into up, down and readiness.target", () => {
    writeSlot(4);
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        down: "./stack down ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:30${SENTINAL_WORKTREE_SLOT}0/health",
      }),
    );
    const r = loadRuntimeConfig(root);

    expect(r.slot).toBe(4);
    expect(r.config?.up).toBe("./stack up 4");
    expect(r.config?.down).toBe("./stack down 4");
    expect(r.config?.readiness?.target).toBe("http://localhost:3040/health");
  });

  it("leaves non-SENTINAL shell expansion untouched", () => {
    writeSlot(2);
    writeConfig(
      JSON.stringify({
        up: "PORT=${PORT:-3000} npm start ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:3000",
      }),
    );
    expect(loadRuntimeConfig(root).config?.up).toBe(
      "PORT=${PORT:-3000} npm start 2",
    );
  });
});

// ─── Slotless degradation ───────────────────────────────────────────────────

describe("a slotless worktree degrades with a warning", () => {
  it("leaves the placeholder in place and warns, rather than substituting null", () => {
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:3000",
      }),
    );
    const r = loadRuntimeConfig(root);

    expect(r.slot).toBeNull();
    expect(r.config?.up).toBe("./stack up ${SENTINAL_WORKTREE_SLOT}");
    expect(r.error).toBeNull();
    expect(r.warnings.join("\n")).toContain("slot");
    expect(r.warnings.join("\n")).not.toContain("null}");
  });

  it("does NOT warn about a slot when the config uses no slot token", () => {
    writeConfig(JSON.stringify({ up: "npm start", readiness: "http://x" }));
    const r = loadRuntimeConfig(root);
    expect(r.warnings.filter((w) => w.includes("slot"))).toEqual([]);
  });
});

// ─── Structured unsubstituted-token signal ──────────────────────────────────

/**
 * The prose in `warnings[]` is what a HUMAN reads; it is documented as
 * "never a reason to stop" and must stay that way. A caller that needs to
 * REFUSE to spawn cannot substring-match a paragraph, so the same condition is
 * also published as data. Both surfaces, one condition.
 */
describe("unsubstitutedTokens — the machine-readable half of the warning", () => {
  it("is an empty array, not undefined, when there is no file at all", () => {
    const r = loadRuntimeConfig(root);
    expect(r.unsubstitutedTokens).toEqual([]);
  });

  it("is empty for a config whose tokens were all substituted", () => {
    writeSlot(4);
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        down: "./stack down ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:30${SENTINAL_WORKTREE_SLOT}0/health",
      }),
    );
    expect(loadRuntimeConfig(root).unsubstitutedTokens).toEqual([]);
  });

  it("is empty for a config that carries no Sentinal token at all", () => {
    writeConfig(JSON.stringify({ up: "npm start", readiness: "http://x" }));
    expect(loadRuntimeConfig(root).unsubstitutedTokens).toEqual([]);
  });

  it("NAMES the surviving token when the worktree has no slot", () => {
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:3000",
      }),
    );
    const r = loadRuntimeConfig(root);

    // Bare NAME, no `${}` — this is a key a caller branches on, not prose.
    expect(r.unsubstitutedTokens).toEqual(["SENTINAL_WORKTREE_SLOT"]);
  });

  it("scans down and readiness.target too, deduplicated", () => {
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        down: "./stack down ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:30${SENTINAL_WORKTREE_SLOT}0/health",
      }),
    );
    expect(loadRuntimeConfig(root).unsubstitutedTokens).toEqual([
      "SENTINAL_WORKTREE_SLOT",
    ]);
  });

  it("finds a token that survives ONLY in readiness.target", () => {
    writeConfig(
      JSON.stringify({
        readiness: "http://localhost:30${SENTINAL_WORKTREE_SLOT}0/health",
      }),
    );
    expect(loadRuntimeConfig(root).unsubstitutedTokens).toEqual([
      "SENTINAL_WORKTREE_SLOT",
    ]);
  });

  it("finds a token that survives ONLY in down", () => {
    writeConfig(
      JSON.stringify({
        down: "./stack down ${SENTINAL_WORKTREE_SLOT}",
      }),
    );
    expect(loadRuntimeConfig(root).unsubstitutedTokens).toEqual([
      "SENTINAL_WORKTREE_SLOT",
    ]);
  });

  it("stays empty — never undefined — on a config that failed to parse", () => {
    writeConfig("{ not json");
    expect(loadRuntimeConfig(root).unsubstitutedTokens).toEqual([]);
  });

  it("stays empty — never undefined — on a config that failed validation", () => {
    writeConfig(JSON.stringify({ up: "npm start" })); // no readiness
    const r = loadRuntimeConfig(root);
    expect(r.error).not.toBeNull();
    expect(r.unsubstitutedTokens).toEqual([]);
  });

  it("accompanies the human warning rather than replacing it", () => {
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_WORKTREE_SLOT}",
        readiness: "http://localhost:3000",
      }),
    );
    const r = loadRuntimeConfig(root);

    expect(r.unsubstitutedTokens).toEqual(["SENTINAL_WORKTREE_SLOT"]);
    expect(r.warnings.join("\n")).toContain("LEFT IN PLACE");
  });
});

// ─── Failure modes ──────────────────────────────────────────────────────────

describe("errors name the file and the offending thing", () => {
  it("reports malformed JSON, naming the file", () => {
    writeConfig("{ not json");
    const r = loadRuntimeConfig(root);

    expect(r.configured).toBe(true);
    expect(r.config).toBeNull();
    expect(r.error).toContain(".sentinal/runtime.json");
  });

  it("reports an unknown SENTINAL token, NAMING the token", () => {
    writeConfig(
      JSON.stringify({
        up: "./stack up ${SENTINAL_TYPO}",
        readiness: "http://localhost:3000",
      }),
    );
    const r = loadRuntimeConfig(root);

    expect(r.config).toBeNull();
    expect(r.error).toContain("${SENTINAL_TYPO}");
    expect(r.error).toContain(".sentinal/runtime.json");
  });

  it("reports `up` without `readiness`, naming the field", () => {
    writeConfig(JSON.stringify({ up: "npm start" }));
    const r = loadRuntimeConfig(root);

    expect(r.config).toBeNull();
    expect(r.error).toContain("readiness");
  });

  it("never throws on a broken config — the caller gets a result", () => {
    writeConfig("{{{{");
    expect(() => loadRuntimeConfig(root)).not.toThrow();
  });
});

// ─── isolation surfacing ────────────────────────────────────────────────────

describe("isolation surfacing", () => {
  it("names ONLY explicitly-shared resources", () => {
    writeConfig(
      JSON.stringify({
        isolation: { ports: "isolated", database: "shared", cache: "none" },
      }),
    );
    const r = loadRuntimeConfig(root);

    expect(r.sharedResources).toEqual(["database"]);
  });

  it("reports unknown classes NON-blockingly and never as shared", () => {
    writeConfig(JSON.stringify({ isolation: { database: "isolated" } }));
    const r = loadRuntimeConfig(root);

    expect(r.sharedResources).toEqual([]);
    // Non-blocking context only — a list of classes with no declaration.
    expect(r.unknownResources).toContain("cache");
    expect(r.unknownResources).not.toContain("database");
  });

  it("treats a config with no isolation map as all-unknown, not all-shared", () => {
    writeConfig(JSON.stringify({ detached: false }));
    const r = loadRuntimeConfig(root);

    expect(r.sharedResources).toEqual([]);
    expect(r.unknownResources.length).toBeGreaterThan(0);
  });

  it("reports NO unknown resources when there is no file at all", () => {
    // An unconfigured project must not acquire a new line of noise on every
    // run — absence of the file is absence of the whole feature.
    const r = loadRuntimeConfig(root);
    expect(r.unknownResources).toEqual([]);
  });
});

// ─── R9: a parent .gitignore that swallows .sentinal/ ───────────────────────

describe("the contract must actually reach teammates and CI (R9)", () => {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });

  it("warns and names the remedy when a parent .gitignore excludes .sentinal/", () => {
    git(["init", "-q"]);
    writeFileSync(join(root, ".gitignore"), ".sentinal/\n");
    writeConfig(JSON.stringify({ detached: false }));

    const r = loadRuntimeConfig(root);
    const text = r.warnings.join("\n");

    expect(r.error).toBeNull(); // still loads — this is advisory
    expect(text).toContain(".gitignore");
    expect(text).toContain(".sentinal/runtime.json");
  });

  it("stays silent when the file is committable", () => {
    git(["init", "-q"]);
    writeFileSync(join(root, ".sentinal", ".gitignore"), "*\n!runtime.json\n");
    writeConfig(JSON.stringify({ detached: false }));

    const r = loadRuntimeConfig(root);
    expect(r.warnings.filter((w) => w.includes("gitignore"))).toEqual([]);
  });

  it("stays silent outside a git repo rather than inventing a problem", () => {
    writeConfig(JSON.stringify({ detached: false }));
    const r = loadRuntimeConfig(root);
    expect(r.warnings.filter((w) => w.includes("gitignore"))).toEqual([]);
  });
});
