/**
 * spec/ownership — Session-aware stop-guard decision matrix tests
 *
 * These tests encode the behavior contract from:
 * docs/plans/2026-06-10-multi-plan-session-tracking.md
 *
 * RED phase: all tests fail until src/spec/ownership.ts is implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { resolveProjectIdentity } from "../project/identity.js";
import { SpecStore } from "./store.js";
import { resolveStopDecision } from "./ownership.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function writePlan(dir: string, filename: string, extraHeaders = ""): void {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, filename),
    `# Test Plan\nStatus: IN_PROGRESS\nType: Feature\nApproved: Yes\n${extraHeaders}`,
  );
}

/**
 * Register a plan the way production does: keyed by the CANONICAL project
 * identity, never by the raw `dir`. Every real caller (spec_register, the
 * hooks, the plugin) canonicalizes before writing, so a test that wrote the
 * raw path would be testing a row shape that cannot exist in the field.
 */
function registerPlan(
  store: MemoryStore,
  dir: string,
  filename: string,
  sessionId?: string,
): void {
  const planFile = join(dir, "docs", "plans", filename);
  const specStore = new SpecStore(store);
  specStore.syncFromPlanFile(planFile, resolveProjectIdentity(dir), sessionId);
}

function makeSession(
  store: MemoryStore,
  id: string,
  projectPath: string,
  opts: { alive?: boolean; lastActiveOffsetMs?: number } = {},
): void {
  const { alive = true, lastActiveOffsetMs = -60_000 } = opts;
  store.insertSession({
    id,
    startTime: Date.now() - 3_600_000,
    endTime: alive ? null : Date.now() - 3_600_000,
    projectPath,
    assistant: "claude-code",
    summary: null,
    transcriptPath: null,
  });
  if (alive) {
    // touch so last_active is fresh (within the liveness window)
    store.touchSession(id, Date.now() + lastActiveOffsetMs);
  }
}

// ─── Decision Matrix ─────────────────────────────────────────────────────────

describe("resolveStopDecision — decision matrix", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ── No active plan ────────────────────────────────────────────────────────

  it("should ALLOW when no active plan exists", () => {
    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    expect(result.block).toBe(false);
  });

  // ── Own plan ──────────────────────────────────────────────────────────────

  it("should BLOCK when the plan is owned by the current session", () => {
    writePlan(tmpDir, "2026-06-10-my-plan.md");
    registerPlan(store, tmpDir, "2026-06-10-my-plan.md");
    makeSession(store, "session-A", tmpDir);

    // Stamp ownership so session-A owns the plan
    store.stampPlanOwner("2026-06-10-my-plan", "session-A");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("IN_PROGRESS");
  });

  // ── Unowned (orphaned) plan ───────────────────────────────────────────────

  it("should BLOCK when the plan has no owner (unowned → claimable)", () => {
    writePlan(tmpDir, "2026-06-10-unowned-plan.md");
    // No session stamped → session_id IS NULL in specs row

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(true);
  });

  // ── Other-live plan ───────────────────────────────────────────────────────

  it("should ALLOW when the plan is owned by a DIFFERENT LIVE session", () => {
    writePlan(tmpDir, "2026-06-10-other-plan.md");
    registerPlan(store, tmpDir, "2026-06-10-other-plan.md");
    makeSession(store, "session-A", tmpDir, { alive: true });
    store.stampPlanOwner("2026-06-10-other-plan", "session-A");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(false);
  });

  // ── Other-stale plan ─────────────────────────────────────────────────────

  it("should BLOCK when the plan is owned by a DIFFERENT STALE session", () => {
    writePlan(tmpDir, "2026-06-10-stale-plan.md");
    registerPlan(store, tmpDir, "2026-06-10-stale-plan.md");
    // Session-A's last_active is 2 hours ago — outside 45-min window
    makeSession(store, "session-A", tmpDir, {
      alive: true,
      lastActiveOffsetMs: -2 * 3_600_000,
    });
    store.stampPlanOwner("2026-06-10-stale-plan", "session-A");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(true);
  });

  // ── Concurrent-orphan race: both sessions see unowned plan ────────────────

  it("should BLOCK deterministically when two sessions both see an unowned plan", () => {
    writePlan(tmpDir, "2026-06-10-race-plan.md");
    // Neither session has stamped ownership yet

    const resultA = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    const resultB = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });

    // Both see orphan → both block (safe; no claim write happens inside the guard)
    expect(resultA.block).toBe(true);
    expect(resultB.block).toBe(true);
  });

  // ── Cross-worktree: different searchDir + project_path ───────────────────

  it("should NOT cross-block when sessions use different searchDirs (worktree isolation)", () => {
    const worktreeDir = makeTmpDir("sentinal-wt-test");
    try {
      // Main checkout has an active plan owned by session-A
      writePlan(tmpDir, "2026-06-10-main-plan.md");
      makeSession(store, "session-A", tmpDir, { alive: true });
      store.stampPlanOwner("2026-06-10-main-plan", "session-A");

      // Worktree has its OWN docs/plans (different dir) — no plans there
      // session-B (worktree) should NOT be blocked by the main-checkout plan
      const result = resolveStopDecision({
        searchDir: worktreeDir,
        currentSessionId: "session-B",
        store,
      });
      expect(result.block).toBe(false);
    } finally {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ── Fail-safe: store throws → block ──────────────────────────────────────

  it("should BLOCK (fail-safe) when store throws during ownership check", () => {
    writePlan(tmpDir, "2026-06-10-plan.md");
    // Pass null store to simulate unavailable store
    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store: null,
    });
    expect(result.block).toBe(true);
  });
});

// ─── Ownership class (for background-work suppression, Task 2) ────────────────

describe("resolveStopDecision — ownership class", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("tags a self-owned block with ownership 'self'", () => {
    writePlan(tmpDir, "2026-06-10-self.md");
    registerPlan(store, tmpDir, "2026-06-10-self.md");
    makeSession(store, "session-A", tmpDir);
    store.stampPlanOwner("2026-06-10-self", "session-A");
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("self");
  });

  it("tags an unowned block with ownership 'orphaned'", () => {
    writePlan(tmpDir, "2026-06-10-orphan.md");
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  });

  it("tags a stale-owner block with ownership 'stale-owner'", () => {
    writePlan(tmpDir, "2026-06-10-stale.md");
    registerPlan(store, tmpDir, "2026-06-10-stale.md");
    makeSession(store, "session-A", tmpDir, {
      alive: true,
      lastActiveOffsetMs: -2 * 3_600_000,
    });
    store.stampPlanOwner("2026-06-10-stale", "session-A");
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("stale-owner");
  });
});

// ─── livenessProbe injection (Task 5 — backward-compat + SDK source) ─────────

describe("resolveStopDecision — injected livenessProbe", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
    writePlan(tmpDir, "2026-06-10-probe.md");
    registerPlan(store, tmpDir, "2026-06-10-probe.md");
    makeSession(store, "owner-X", tmpDir, {
      alive: false, // store says dead
      lastActiveOffsetMs: -5 * 3_600_000,
    });
    store.stampPlanOwner("2026-06-10-probe", "owner-X");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("uses the injected probe over store.isSessionAlive when provided", () => {
    // Store thinks owner-X is dead; probe says alive → ALLOW (different live owner)
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
      livenessProbe: (id) => id === "owner-X", // alive per SDK
    });
    expect(r.block).toBe(false);
  });

  it("is byte-identical to store.isSessionAlive when probe is omitted (CC path)", () => {
    // No probe → falls back to store (owner-X dead) → block as stale-owner
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("stale-owner");
  });
});

// ─── ownerLookup injection (store-free OpenCode path) ────────────────────────

describe("resolveStopDecision — injected ownerLookup (no store needed)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writePlan(tmpDir, "2026-07-17-owned.md");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("resolves ownership via ownerLookup + livenessProbe with store=null (no fail-safe block)", () => {
    // store is null, but ownerLookup + livenessProbe are supplied → full decision.
    // Owner is a DIFFERENT LIVE session → ALLOW.
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store: null,
      ownerLookup: () => "owner-live",
      livenessProbe: (id) => id === "owner-live",
    });
    expect(r.block).toBe(false);
  });

  it("blocks with ownership 'self' when ownerLookup returns the current session", () => {
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "me",
      store: null,
      ownerLookup: () => "me",
      livenessProbe: () => true,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("self");
  });

  it("blocks 'orphaned' when ownerLookup returns null (unowned)", () => {
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store: null,
      ownerLookup: () => null,
      livenessProbe: () => true,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  });

  it("still fail-safe blocks when store is null AND no ownerLookup provided", () => {
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store: null,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  });
});

// ─── Project scoping of the ownership query ──────────────────────────────────
//
// `specs.id` is the BARE plan filename (src/spec/parser.ts) — the directory is
// discarded. An unscoped `SELECT ... WHERE id = ?` therefore hands project B's
// stop-guard project A's owner whenever the two happen to name a plan the same
// way, and a LIVE owner there means ALLOW: the guard silently switches off.
//
// The fix binds `resolveProjectIdentity(searchDir)` — the CANONICAL key rows
// are written under — and NOT `searchDir`. Binding `searchDir` would match no
// row for any session running in a linked worktree, and `!ownerId` is the
// fail-safe `orphaned` BLOCK: a user-visible permanent stop-block on every
// worktree. The first test below is that regression guard.
describe("resolveStopDecision — project-scoped ownership", () => {
  let fixtureRoot: string;
  let mainRoot: string;
  let linkedRoot: string;
  let otherRepo: string;
  let store: MemoryStore;

  const PLAN = "2026-09-23-scoped-plan.md";
  const PLAN_ID = "2026-09-23-scoped-plan";

  function git(cwd: string, ...args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    }
  }

  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "fixture@example.com");
    git(dir, "config", "user.name", "Fixture");
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }

  beforeEach(() => {
    fixtureRoot = makeTmpDir("sentinal-ownership-scope");
    mainRoot = join(fixtureRoot, "main");
    linkedRoot = join(fixtureRoot, "linked");
    otherRepo = join(fixtureRoot, "other");

    initRepo(mainRoot);
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", linkedRoot);
    initRepo(otherRepo);

    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {}
  });

  // ── REGRESSION GUARD ──────────────────────────────────────────────────────
  // The whole risk of project-scoping lives here. Bind `searchDir` instead of
  // `resolveProjectIdentity(searchDir)` and this test fails with "orphaned".

  it("resolves the owner from a LINKED WORKTREE against a canonically-keyed row", () => {
    // Plan lives in the linked worktree; the row is keyed to the MAIN checkout
    // (what Task 8 made spec_register write).
    writePlan(linkedRoot, PLAN);
    registerPlan(store, linkedRoot, PLAN);
    makeSession(store, "session-A", resolveProjectIdentity(linkedRoot), {
      alive: true,
    });
    store.stampPlanOwner(PLAN_ID, "session-A");

    // Sanity: the row really IS keyed canonically, not by the worktree path.
    const row = store
      .getRawDb()
      .prepare("SELECT project_path FROM specs WHERE slug = ?")
      .get(PLAN_ID) as { project_path: string };
    expect(row.project_path).toBe(resolveProjectIdentity(mainRoot));
    expect(row.project_path).not.toBe(linkedRoot);

    const r = resolveStopDecision({
      searchDir: linkedRoot,
      currentSessionId: "session-A",
      store,
    });

    // The owner WAS resolved: self-owned, NOT a spurious orphan block.
    expect(r.ownership).not.toBe("orphaned");
    expect(r.ownership).toBe("self");
    expect(r.block).toBe(true);
  }, 30_000);

  it("ALLOWS from a linked worktree when a DIFFERENT LIVE session owns the canonical row", () => {
    writePlan(linkedRoot, PLAN);
    registerPlan(store, linkedRoot, PLAN);
    makeSession(store, "session-A", resolveProjectIdentity(linkedRoot), {
      alive: true,
    });
    store.stampPlanOwner(PLAN_ID, "session-A");

    const r = resolveStopDecision({
      searchDir: linkedRoot,
      currentSessionId: "session-B",
      store,
    });
    // Only reachable if the owner resolved — an orphan would BLOCK.
    expect(r.block).toBe(false);
  }, 30_000);

  // ── The bug being fixed ───────────────────────────────────────────────────

  it("does NOT return project A's owner for a same-named plan in project B", () => {
    // Project A: plan registered + owned by a LIVE session.
    writePlan(mainRoot, PLAN);
    registerPlan(store, mainRoot, PLAN);
    makeSession(store, "session-A", resolveProjectIdentity(mainRoot), {
      alive: true,
    });
    store.stampPlanOwner(PLAN_ID, "session-A");

    // Project B: an unrelated repo that happens to name its plan identically.
    // (`specs.id` is the PRIMARY KEY, so B cannot hold a second row for the
    // same filename — which is precisely why an unscoped lookup leaks A's.)
    writePlan(otherRepo, PLAN);

    const r = resolveStopDecision({
      searchDir: otherRepo,
      currentSessionId: "session-B",
      store,
    });

    // Unscoped: finds A's row, owner is alive → block:false (guard disabled).
    // Scoped: no row for B → documented fail-safe.
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  }, 30_000);

  it("still reports 'orphaned' for a genuinely absent row", () => {
    writePlan(mainRoot, PLAN); // never registered — no row at all
    const r = resolveStopDecision({
      searchDir: mainRoot,
      currentSessionId: "session-A",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  }, 30_000);

  // ── Dual-target: the injected ownerLookup must be scoped too ──────────────
  // `resolveStopDecision` PREFERS `ownerLookup` over the SQL path, so fixing
  // the SQL alone would leave OpenCode completely unscoped.

  it("passes the CANONICAL project path (not searchDir) to ownerLookup", () => {
    writePlan(linkedRoot, PLAN);
    const seen: Array<[string, string]> = [];

    const r = resolveStopDecision({
      searchDir: linkedRoot,
      currentSessionId: "session-B",
      store: null,
      ownerLookup: (specId, projectPath) => {
        seen.push([specId, projectPath]);
        return "owner-live";
      },
      livenessProbe: () => true,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(PLAN_ID);
    expect(seen[0]![1]).toBe(resolveProjectIdentity(mainRoot));
    expect(seen[0]![1]).not.toBe(linkedRoot);
    expect(r.block).toBe(false);
  }, 30_000);

  it("blocks 'orphaned' when a project-scoped ownerLookup declines the project (OpenCode shape)", () => {
    writePlan(otherRepo, PLAN);
    // The plugin's lambda only vouches for an owner when the project key the
    // decision resolved matches the project it prefetched the spec for.
    const prefetchedProject = resolveProjectIdentity(mainRoot);
    const ownerLookup = (specId: string, projectPath: string) =>
      specId === PLAN_ID && projectPath === prefetchedProject
        ? "owner-live"
        : null;

    const r = resolveStopDecision({
      searchDir: otherRepo,
      currentSessionId: "session-B",
      store: null,
      ownerLookup,
      livenessProbe: () => true,
    });

    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  }, 30_000);
});

// ─── Task 10 (#5 / #10a): raw-alias registration must not orphan the plan ───
//
// `register-plan` and Claude Code `pre-compact` used to store the RAW path
// (a `/var/…` macOS tmpdir, a symlink, a subdirectory). `resolveStopDecision`
// looks the owner up under the CANONICAL identity, so the row never matched
// and a DIFFERENT live session's Stop was blocked as "orphaned".

import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

describe("resolveStopDecision — raw-alias registration (Stop-guard bug)", () => {
  const PLAN = "2026-09-25-alias-plan.md";
  const PLAN_ID = "2026-09-25-alias-plan";
  let rawRoot: string; // NOT realpath'd — `/var/…` on macOS
  let canonicalRoot: string;
  let aliasHolder: string;
  let store: MemoryStore;

  beforeEach(() => {
    rawRoot = mkdtempSync(join(tmpdir(), "sentinal-alias-"));
    const r = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
      cwd: rawRoot,
    });
    if (r.exitCode !== 0) throw new Error("git init failed");
    canonicalRoot = realpathSync(rawRoot);
    mkdirSync(join(rawRoot, "src"));
    aliasHolder = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-link-")));
    symlinkSync(canonicalRoot, join(aliasHolder, "link"));
    writePlan(rawRoot, PLAN);
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(rawRoot, { recursive: true, force: true });
    rmSync(aliasHolder, { recursive: true, force: true });
  });

  function registerRaw(projectPath: string): void {
    // Exactly what register-plan / pre-compact do: the path as received.
    new SpecStore(store).syncFromPlanFile(
      join(rawRoot, "docs", "plans", PLAN),
      projectPath,
    );
    makeSession(store, "session-A", canonicalRoot, { alive: true });
    store.stampPlanOwner(PLAN_ID, "session-A");
  }

  for (const [label, aliasOf] of [
    ["the raw tmpdir path", () => rawRoot],
    ["a symlinked subdirectory", () => join(aliasHolder, "link", "src")],
  ] as const) {
    it(`ALLOWS a different live session's Stop after registering under ${label}`, () => {
      registerRaw(aliasOf());
      const r = resolveStopDecision({
        searchDir: canonicalRoot,
        currentSessionId: "session-B",
        store,
      });
      expect(r.ownership).not.toBe("orphaned");
      expect(r.block).toBe(false);
    }, 30_000);
  }
});
