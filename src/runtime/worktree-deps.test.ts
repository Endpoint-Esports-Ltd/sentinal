/**
 * The runtime → worktree dependency injection (Task 6).
 *
 * ⛔ Pre-Mortem #3 is "the injection silently no-ops because one of the
 * construction sites was missed". Behavioural tests cover the three sites that
 * seed; this file additionally asserts, **statically**, that all five sites
 * construct their manager through {@link runtimeWorktreeConfig}. A missed site
 * is otherwise invisible — the manager still works, it just never names a
 * shared resource and never stops a process group.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { makeTmpDir, captureTools } from "../test-helpers.js";
import { runtimeWorktreeConfig } from "./worktree-deps.js";
import { DEFAULT_WORKTREE_CONFIG } from "../worktree/types.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { WorktreeManager } from "../worktree/manager.js";
import { registerWorktreeTools } from "../worktree/mcp-tools.js";

const SRC = resolve(import.meta.dir, "..");

/** Every construction site outside `src/worktree/`, plus the one inside it. */
const SITES = [
  "sidecar/worktree-routes.ts",
  "cli/commands/worktree.ts",
  "mcp/server.ts",
];

describe("runtimeWorktreeConfig", () => {
  it("supplies all four injected deps", () => {
    const cfg = runtimeWorktreeConfig();
    expect(typeof cfg.sharedResourcesFor).toBe("function");
    expect(typeof cfg.stopOwnedRuntime).toBe("function");
    expect(typeof cfg.ownsLiveRuntime).toBe("function");
    expect(typeof cfg.unknownSentinalTokens).toBe("function");
  });

  it("wires the REAL token checker, not an inert stand-in", () => {
    // ⛔ `DEFAULT_WORKTREE_CONFIG` declares `NO_TOKEN_CHECK`, which returns []
    // for everything. A spread that failed to override it would look wired and
    // validate nothing — so assert on a token it must actually catch.
    const cfg = runtimeWorktreeConfig();
    expect(cfg.unknownSentinalTokens("DB=${SENTINAL_WORKTREE_SLOTT}")).toEqual([
      "${SENTINAL_WORKTREE_SLOTT}",
    ]);
    // D6 as shipped: the valid token, non-SENTINAL tokens and bare $VAR pass.
    expect(
      cfg.unknownSentinalTokens(
        "DB=${SENTINAL_WORKTREE_SLOT} P=${PORT:-3000} H=$DOCKER_HOST",
      ),
    ).toEqual([]);
  });

  it("preserves the base config it wraps", () => {
    const cfg = runtimeWorktreeConfig({
      ...DEFAULT_WORKTREE_CONFIG,
      maxActive: 9,
      branchPrefix: "custom/",
    });
    expect(cfg.maxActive).toBe(9);
    expect(cfg.branchPrefix).toBe("custom/");
  });

  describe("against a real temp worktree", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTmpDir();
      mkdirSync(join(tmpDir, ".sentinal"), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("sharedResourcesFor reads the worktree's own runtime.json", () => {
      writeFileSync(
        join(tmpDir, ".sentinal", "runtime.json"),
        JSON.stringify({ isolation: { database: "shared" } }),
      );
      expect(runtimeWorktreeConfig().sharedResourcesFor!(tmpDir)).toEqual([
        "database",
      ]);
    });

    it("sharedResourcesFor is empty (never throws) with no contract", () => {
      expect(runtimeWorktreeConfig().sharedResourcesFor!(tmpDir)).toEqual([]);
    });

    it("ownsLiveRuntime reports a worktree with no pidfile as not live", () => {
      expect(runtimeWorktreeConfig().ownsLiveRuntime!(tmpDir).live).toBe(false);
    });

    it("stopOwnedRuntime is a fast no-op with no pidfile", async () => {
      const started = Date.now();
      const r = await runtimeWorktreeConfig().stopOwnedRuntime!(tmpDir);
      expect(r.ok).toBe(true);
      expect(r.stopped).toBe(false);
      // ⛔ Pre-Mortem #2: `abandon` calls this on EVERY worktree, including ones
      // that never started a runtime. Paying `graceMs` (10s) there would make
      // the normal end-of-spec exit look broken.
      expect(Date.now() - started).toBeLessThan(500);
    });

    /**
     * ⛔ The **unmocked-call** half of the fast-path proof.
     *
     * A timing bound alone is a weak assertion: it passes on a fast machine
     * against an implementation that does real work, and flakes on a slow one
     * against a correct implementation. This declares a `down` command whose
     * only effect is to create a file. With no pidfile the fast path must
     * return *before* the contract is even loaded, so `down` never runs and the
     * file never appears — an exact, timing-independent observation.
     */
    it("does NOT run the declared `down` when there is no pidfile", async () => {
      const sentinel = join(tmpDir, "down-ran.marker");
      writeFileSync(
        join(tmpDir, ".sentinal", "runtime.json"),
        JSON.stringify({
          down: `touch ${sentinel}`,
          // Deliberately large: an implementation that reached signal
          // escalation would also blow the timing bound below.
          shutdown: { signal: "SIGTERM", graceMs: 20000 },
        }),
      );

      const started = Date.now();
      const r = await runtimeWorktreeConfig().stopOwnedRuntime!(tmpDir);

      expect(r.stopped).toBe(false);
      expect(existsSync(sentinel)).toBe(false);
      expect(r.actions.join(" ")).toContain("runtime.pid");
      expect(Date.now() - started).toBeLessThan(500);
    });
  });
});

/**
 * `abandon`'s fast path, end to end through a REAL manager carrying the REAL
 * production resolvers.
 *
 * ⛔ This cannot live in `src/worktree/manager.test.ts`: that file is inside the
 * directory the no-module-cycle guard forbids from importing `src/runtime/`, so
 * the only stop hook available to it is a hand-written stub — and a stub proves
 * nothing about whether the real one short-circuits. Pre-Mortem #2 is precisely
 * "every `abandon` pays `graceMs`", which is a property of the real resolver.
 */
describe("abandon is a fast no-op on a worktree that never started a runtime", () => {
  let tmpDir: string;
  let repoDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoDir = join(tmpDir, "repo");
    mkdirSync(join(repoDir, ".sentinal"), { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    Bun.spawnSync(["git", "add", "-Af"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never executes `down`, and does not pay the grace period", async () => {
    const manager = new WorktreeManager(
      new WorktreeStore(store),
      runtimeWorktreeConfig(),
    );
    const wt = manager.create("2026-08-09-fastpath", repoDir);

    // The worktree declares a teardown command — but nothing was ever started
    // in it, so there is no pidfile and the command must never run.
    const sentinel = join(tmpDir, "abandon-down-ran.marker");
    mkdirSync(join(wt.worktreePath, ".sentinal"), { recursive: true });
    writeFileSync(
      join(wt.worktreePath, ".sentinal", "runtime.json"),
      JSON.stringify({
        down: `touch ${sentinel}`,
        shutdown: { signal: "SIGTERM", graceMs: 20000 },
      }),
    );

    const started = Date.now();
    await manager.abandon(wt.id);
    const elapsed = Date.now() - started;

    // The unmocked-call assertion — exact, and independent of machine speed.
    expect(existsSync(sentinel)).toBe(false);
    // The timing assertion — catches a hook that blocks for `graceMs` some
    // other way. 20s declared; anything near it is a regression.
    expect(elapsed).toBeLessThan(3000);
    expect(existsSync(wt.worktreePath)).toBe(false);
  }, 30_000);
});

/**
 * The `${SENTINAL_*}` typo check on the **seeding** path, end to end through a
 * REAL manager carrying the REAL checker.
 *
 * ⛔ Like `abandon`'s fast path above, this cannot live in
 * `src/worktree/worktree-config.test.ts`: that file is inside the directory the
 * no-module-cycle guard forbids from importing `src/runtime/`, so the only
 * checker available to it is a stub that reimplements the rule — and a stub
 * proves nothing about whether the SHIPPED rule is the one being applied.
 */
describe("a typo'd ${SENTINAL_*} token is never seeded into a worktree", () => {
  let tmpDir: string;
  let repoDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function commitExample(body: string): void {
    writeFileSync(join(repoDir, ".env.example"), body);
    Bun.spawnSync(["git", "add", "-Af"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });
  }

  it("refuses to write the .env, and the warning names the token", () => {
    commitExample("DATABASE_URL=postgres://localhost/app_${SENTINAL_SLOTT}\n");
    const manager = new WorktreeManager(
      new WorktreeStore(store),
      runtimeWorktreeConfig(),
    );
    const warnings: string[] = [];
    const wt = manager.create("2026-08-20-typo", repoDir, undefined, warnings);

    // Master DoD item 2, on the path that writes credentials config.
    expect(existsSync(join(wt.worktreePath, ".env"))).toBe(false);
    expect(warnings.join("\n")).toContain("${SENTINAL_SLOTT}");
  });

  it("still seeds a file whose only tokens are legitimate", () => {
    commitExample(
      "DB=app_${SENTINAL_WORKTREE_SLOT}\nPORT=${PORT:-3000}\nH=$DOCKER_HOST\n",
    );
    const manager = new WorktreeManager(
      new WorktreeStore(store),
      runtimeWorktreeConfig(),
    );
    const wt = manager.create("2026-08-20-valid", repoDir);
    const text = readFileSync(join(wt.worktreePath, ".env"), "utf-8");
    expect(text).toContain("DB=app_1");
    expect(text).toContain("PORT=${PORT:-3000}");
    expect(text).toContain("H=$DOCKER_HOST");
  });
});

describe("every WorktreeManager construction site injects the runtime deps", () => {
  it.each(SITES)("%s builds its config with runtimeWorktreeConfig", (rel) => {
    const text = readFileSync(join(SRC, rel), "utf-8");
    expect(text).toContain("runtimeWorktreeConfig");
    // No site may keep constructing straight from the inert default.
    expect(text).not.toContain(
      "new WorktreeManager(ctx.wtStore, DEFAULT_WORKTREE_CONFIG)",
    );
    expect(text).not.toContain(
      "new WorktreeManager(wtStore, DEFAULT_WORKTREE_CONFIG)",
    );
  });

  it("worktree-routes.ts injects at all THREE of its handlers", () => {
    const text = readFileSync(join(SRC, "sidecar/worktree-routes.ts"), "utf-8");
    const constructions = text.match(/new WorktreeManager\(/g) ?? [];
    const injections = text.match(/runtimeWorktreeConfig\(/g) ?? [];
    expect(constructions.length).toBe(3);
    expect(injections.length).toBe(constructions.length);
  });

  /**
   * The `worktree/mcp-tools.ts:62` construction site, end to end.
   *
   * ⛔ This assertion cannot live in `src/worktree/mcp-tools.test.ts` — that
   * file is inside the directory forbidden from importing `src/runtime/`, and
   * the no-module-cycle guard walks test files too. It belongs here, on the
   * runtime side of the boundary, where both halves are importable.
   */
  describe("worktree_create via the MCP tool names shared resources", () => {
    let tmpDir: string;
    let repoDir: string;
    let store: MemoryStore;

    beforeEach(() => {
      tmpDir = makeTmpDir();
      repoDir = join(tmpDir, "repo");
      mkdirSync(join(repoDir, ".sentinal"), { recursive: true });
      Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
      Bun.spawnSync(["git", "config", "user.email", "t@t.com"], {
        cwd: repoDir,
      });
      Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README.md"), "# t\n");
      // A seed source with NO slot placeholder is the only path that warns.
      writeFileSync(
        join(repoDir, ".env.example"),
        "DATABASE_URL=postgres://x\n",
      );
      writeFileSync(
        join(repoDir, ".sentinal", "runtime.json"),
        JSON.stringify({ isolation: { database: "shared", cache: "shared" } }),
      );
      Bun.spawnSync(["git", "add", "-Af"], { cwd: repoDir });
      Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });
      store = new MemoryStore(join(tmpDir, "test.db"));
    });

    afterEach(() => {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("names them when the config is threaded down from the server", async () => {
      const tools = captureTools(registerWorktreeTools, {
        store,
        worktreeConfig: runtimeWorktreeConfig(),
      });
      const result = await tools.get("worktree_create")!({
        plan_slug: "2026-08-09-tool-r11",
        project: repoDir,
      });
      expect(result.content[0]!.text).toContain(
        "Shared with the main checkout: database, cache.",
      );
    });

    it("falls back to the Phase 2 wording when no config is threaded", async () => {
      const tools = captureTools(registerWorktreeTools, { store });
      const result = await tools.get("worktree_create")!({
        plan_slug: "2026-08-09-tool-inert",
        project: repoDir,
      });
      expect(result.content[0]!.text).toContain("NOT isolated");
      expect(result.content[0]!.text).not.toContain(
        "Shared with the main checkout",
      );
    });
  });

  it("worktree/mcp-tools.ts receives the config as a dep it cannot import", () => {
    // ⛔ `src/worktree/mcp-tools.ts` is INSIDE the forbidden directory, so it
    // must not import the runtime helper — `src/mcp/server.ts` threads it down.
    // Prose mentioning `src/runtime/` is fine and in fact desirable; what must
    // never appear is an import SPECIFIER resolving there. (The recursive
    // version of this check is `no-module-cycle.test.ts`.)
    const tools = readFileSync(join(SRC, "worktree/mcp-tools.ts"), "utf-8");
    const specifiers = [...tools.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.filter((s) => s.includes("runtime/"))).toEqual([]);
    expect(tools).toContain("worktreeConfig");

    const server = readFileSync(join(SRC, "mcp/server.ts"), "utf-8");
    expect(server).toMatch(/worktreeConfig:\s*runtimeWorktreeConfig\(\)/);
  });
});
