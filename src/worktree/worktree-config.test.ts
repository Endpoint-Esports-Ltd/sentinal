/**
 * Isolated config seeding (Phase 2, Task 5 / D8).
 *
 * The incident behind issue #2 went: worktree created → no `.env` (git worktrees
 * correctly do not inherit gitignored files) → agent copied the **repo-root
 * `.env`** in → worktree pointed at LIVE databases. Seeding removes the motive.
 *
 * These tests use real temp git repos with real linked worktrees, because the
 * exclusion half of the feature is only meaningful against real git behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { readSlotFromWorktree, SLOT_ENV_RELATIVE_PATH } from "./slots.js";
import {
  seedWorktreeConfig,
  seedNonFatally,
  discoverSeedSources,
  interpolateSlot,
  notIsolatedWarning,
  SLOT_PLACEHOLDER,
} from "./worktree-config.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  return new TextDecoder().decode(r.stdout).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("worktree-config seeding", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtDir: string;

  function setup(rootGitignore?: string): void {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    wtDir = join(tmpDir, "wt");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "t@t.com"], repoDir);
    git(["config", "user.name", "T"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    if (rootGitignore !== undefined) {
      writeFileSync(join(repoDir, ".gitignore"), rootGitignore);
    }
    git(["add", "."], repoDir);
    git(["commit", "-m", "init"], repoDir);
    git(["worktree", "add", wtDir, "-b", "feat"], repoDir);
  }

  beforeEach(() => setup());
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Interpolation ────────────────────────────────────────────────────────

  describe("interpolateSlot", () => {
    it("substitutes EVERY occurrence, leaving no placeholder behind", () => {
      const src = `PORT=30${SLOT_PLACEHOLDER}0\nDB=app_${SLOT_PLACEHOLDER}\nR=${SLOT_PLACEHOLDER}\n`;
      const out = interpolateSlot(src, 3);
      expect(out).toBe("PORT=3030\nDB=app_3\nR=3\n");
      expect(out).not.toContain(SLOT_PLACEHOLDER);
    });

    it("leaves unrelated ${...} tokens alone", () => {
      expect(interpolateSlot("A=${OTHER}\n", 1)).toBe("A=${OTHER}\n");
    });
  });

  // ── The typo check on the SEEDING path ───────────────────────────────────
  //
  // ⛔ `unknownSentinalTokens` lives in `src/runtime/interpolate.ts` and was
  // only ever applied to `runtime.json`'s three interpolated fields. The
  // seeding path — the one that writes CREDENTIALS config — had nothing but
  // the generic "contains no placeholder" warning, so a `.env.example`
  // carrying `${SENTINAL_WORKTREE_SLOTT}` was copied through VERBATIM and the
  // shell later expanded it to the empty string, pointing the worktree at
  // slot-less (i.e. the main checkout's) resources.
  //
  // ⛔ The checker arrives as DATA, like `sharedResources`: `src/worktree/**`
  // may import NOTHING from `src/runtime/**`, and
  // `src/runtime/no-module-cycle.test.ts` walks THIS FILE too. The stub below
  // therefore exercises the plumbing only; the proof that the REAL checker is
  // wired end to end lives in `src/runtime/worktree-deps.test.ts`, on the
  // runtime side of the boundary where both halves are importable.

  describe("unknown ${SENTINAL_*} tokens in a seed source", () => {
    /** Structural stand-in for `unknownSentinalTokens`. */
    const stubChecker = (text: string): string[] =>
      [...text.matchAll(/\$\{(SENTINAL_[^}]*)\}/g)]
        .filter((m) => m[1] !== "SENTINAL_WORKTREE_SLOT")
        .map((m) => m[0]!);

    it("refuses to write the file, rather than seeding the typo verbatim", () => {
      write(
        join(repoDir, ".env.example"),
        "DB=app_${SENTINAL_WORKTREE_SLOTT}\n",
      );

      const r = seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 1,
        unknownTokens: stubChecker,
      });

      // Master DoD item 2: no unsubstituted ${SENTINAL_*} token survives.
      expect(existsSync(join(wtDir, ".env"))).toBe(false);
      expect(r.seeded).not.toContain(".env");
      const w = r.warnings.join("\n");
      expect(w).toContain("${SENTINAL_WORKTREE_SLOTT}");
      // Actionable, not merely disapproving.
      expect(w).toContain(SLOT_PLACEHOLDER);
    });

    it("does NOT downgrade to the generic not-isolated warning", () => {
      // The typo'd token means the file also has no VALID placeholder, so the
      // pre-existing rule-3 path would fire and quietly seed it. Naming a
      // missing placeholder while the real defect is a misspelt one sends the
      // reader to fix the wrong thing.
      write(
        join(repoDir, ".env.example"),
        "DB=app_${SENTINAL_WORKTREE_SLOTT}\n",
      );
      const r = seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 1,
        unknownTokens: stubChecker,
      });
      expect(r.warnings.join("\n")).not.toContain("NOT isolated");
    });

    it("passes non-SENTINAL and bare-$ tokens through verbatim (D6 as shipped)", () => {
      write(
        join(repoDir, ".env.example"),
        `PORT=\${PORT:-3000}\nHOST=$DOCKER_HOST\nDB=app_${SLOT_PLACEHOLDER}\n`,
      );
      const r = seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 2,
        unknownTokens: stubChecker,
      });
      expect(r.seeded).toContain(".env");
      const text = readFileSync(join(wtDir, ".env"), "utf-8");
      expect(text).toBe("PORT=${PORT:-3000}\nHOST=$DOCKER_HOST\nDB=app_2\n");
    });

    it("still writes the slot env file, so the worktree is not left slot-less", () => {
      write(join(repoDir, ".env.example"), "DB=app_${SENTINAL_NOPE}\n");
      const r = seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 4,
        unknownTokens: stubChecker,
      });
      expect(r.seeded).toContain(SLOT_ENV_RELATIVE_PATH);
      expect(readSlotFromWorktree(wtDir)).toBe(4);
    });

    it("is inert when no checker is injected (the pre-fix baseline)", () => {
      write(
        join(repoDir, ".env.example"),
        "DB=app_${SENTINAL_WORKTREE_SLOTT}\n",
      );
      const r = seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 1,
      });
      expect(r.seeded).toContain(".env");
    });
  });

  // ── Seed-source discovery ────────────────────────────────────────────────

  describe("discoverSeedSources", () => {
    it("finds the repo root", () => {
      write(join(repoDir, ".env.example"), "A=1\n");
      expect(discoverSeedSources(repoDir)).toEqual(["."]);
    });

    it("finds workspace package roots from package.json `workspaces`", () => {
      write(
        join(repoDir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      );
      write(join(repoDir, "packages/api/package.json"), "{}");
      write(join(repoDir, "packages/api/.env.example"), "A=1\n");
      write(join(repoDir, "packages/web/package.json"), "{}");

      // Only packages that actually HAVE a seed source are returned.
      expect(discoverSeedSources(repoDir)).toEqual(["packages/api"]);
    });

    it("finds workspace package roots from pnpm-workspace.yaml", () => {
      write(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
      write(join(repoDir, "apps/admin/package.json"), "{}");
      write(join(repoDir, "apps/admin/.env.example"), "A=1\n");

      expect(discoverSeedSources(repoDir)).toEqual(["apps/admin"]);
    });

    it("ignores node_modules", () => {
      write(
        join(repoDir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["**"] }),
      );
      write(join(repoDir, "node_modules/dep/package.json"), "{}");
      write(join(repoDir, "node_modules/dep/.env.example"), "A=1\n");

      expect(discoverSeedSources(repoDir)).toEqual([]);
    });

    it("does NOT descend into node_modules when expanding a `**` pattern", () => {
      // `packages/**` is legal in npm/pnpm workspaces and naively expands to
      // `packages/**/package.json`, which walks EVERY installed dependency's
      // package.json — on the `worktree create` hot path, in exactly the
      // monorepo shape issue #2's reporter describes.
      // The unreadable directory below is a probe: a scan that descends into
      // node_modules dies on it and loses the whole pattern; a scan that prunes
      // node_modules never sees it.
      if (process.getuid?.() === 0) return; // chmod is vacuous as root

      write(
        join(repoDir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
      );
      write(join(repoDir, "packages/api/package.json"), "{}");
      write(join(repoDir, "packages/api/.env.example"), "A=1\n");
      write(join(repoDir, "packages/api/node_modules/dep/package.json"), "{}");
      const landmine = join(repoDir, "packages/api/node_modules/dep/deep");
      mkdirSync(landmine, { recursive: true });
      chmodSync(landmine, 0o000);

      try {
        expect(discoverSeedSources(repoDir)).toEqual(["packages/api"]);
      } finally {
        chmodSync(landmine, 0o755);
      }
    });

    it("still finds a NESTED package under a `**` pattern", () => {
      write(
        join(repoDir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
      );
      write(join(repoDir, "packages/group/api/package.json"), "{}");
      write(join(repoDir, "packages/group/api/.env.example"), "A=1\n");

      expect(discoverSeedSources(repoDir)).toEqual(["packages/group/api"]);
    });

    it("returns [] when nothing is found", () => {
      expect(discoverSeedSources(repoDir)).toEqual([]);
    });
  });

  // ── Rule 1: seed from .env.example ───────────────────────────────────────

  it("seeds .env from .env.example with the slot substituted at every position", () => {
    // The repo root has a REAL .env with live-looking credentials — the thing
    // the agent must never be tempted to copy.
    write(join(repoDir, ".env"), "DATABASE_URL=postgres://prod/app\n");
    write(
      join(repoDir, ".env.example"),
      `PORT=30${SLOT_PLACEHOLDER}0\nDATABASE_URL=postgres://localhost/app_${SLOT_PLACEHOLDER}\n`,
    );

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 2,
    });

    expect(r.seeded).toContain(".env");
    const seeded = readFileSync(join(wtDir, ".env"), "utf-8");
    expect(seeded).toBe("PORT=3020\nDATABASE_URL=postgres://localhost/app_2\n");
    expect(seeded).not.toContain(SLOT_PLACEHOLDER);
    // Truth 6's real content: it is derived from the example, not the live file.
    expect(seeded).not.toBe(readFileSync(join(repoDir, ".env"), "utf-8"));
  });

  it("seeds a monorepo package's .env into the matching worktree package dir", () => {
    write(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    write(join(repoDir, "packages/api/package.json"), "{}");
    write(
      join(repoDir, "packages/api/.env.example"),
      `PORT=40${SLOT_PLACEHOLDER}0\n`,
    );

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 1,
    });

    expect(r.seeded).toContain("packages/api/.env");
    expect(readFileSync(join(wtDir, "packages/api/.env"), "utf-8")).toBe(
      "PORT=4010\n",
    );
  });

  // ── Rule 0: NEVER overwrite ──────────────────────────────────────────────

  it("NEVER overwrites an existing worktree .env — skips and reports", () => {
    write(join(repoDir, ".env.example"), `PORT=30${SLOT_PLACEHOLDER}0\n`);
    write(join(wtDir, ".env"), "HAND_EDITED=yes\n");

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 4,
    });

    expect(readFileSync(join(wtDir, ".env"), "utf-8")).toBe(
      "HAND_EDITED=yes\n",
    );
    expect(r.seeded).not.toContain(".env");
    expect(r.skipped).toContain(".env");
    expect(r.warnings.join("\n")).toContain(".env");
  });

  it("is safe to re-run: the second call overwrites nothing", () => {
    write(join(repoDir, ".env.example"), `PORT=30${SLOT_PLACEHOLDER}0\n`);

    seedWorktreeConfig({ repoRoot: repoDir, worktreePath: wtDir, slot: 1 });
    const first = readFileSync(join(wtDir, ".env"), "utf-8");
    const second = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 9,
    });

    expect(readFileSync(join(wtDir, ".env"), "utf-8")).toBe(first);
    expect(second.skipped).toContain(".env");
  });

  // ── Rule 2: missing .env.example warns LOUDLY ────────────────────────────

  it("warns loudly when NO .env.example exists anywhere", () => {
    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 1,
    });

    expect(r.seeded).not.toContain(".env");
    const w = r.warnings.join("\n");
    expect(w).toContain(".env.example");
    // The warning must name the RISK, not merely note the absence — silence is
    // what drives the agent back to copying the root .env.
    expect(w.toLowerCase()).toContain("live");
    expect(w).toContain(SLOT_PLACEHOLDER);
  });

  it("treats an UNREADABLE .env.example like a missing one — warns, continues, does NOT throw", () => {
    // `existsSync` finds it during discovery but the read fails: a directory
    // where a file is expected, a dangling symlink, a permissions problem, or a
    // TOCTOU delete between discovery and the loop are the same condition.
    // ⛔ Throwing here runs the caller's rollback and DESTROYS an otherwise
    // healthy worktree over a file Sentinal only ever wanted to COPY. The plan
    // scopes the throwing case to write failures.
    mkdirSync(join(repoDir, ".env.example"), { recursive: true });

    let r: ReturnType<typeof seedWorktreeConfig> | undefined;
    expect(() => {
      r = seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 1,
      });
    }).not.toThrow();

    expect(r!.seeded).not.toContain(".env");
    const w = r!.warnings.join("\n");
    expect(w).toContain(".env.example");
    // Names the specific path, and the same risk a missing source names.
    expect(w.toLowerCase()).toContain("live");
    // Everything that does NOT depend on the seed source still happened.
    expect(r!.seeded).toContain(SLOT_ENV_RELATIVE_PATH);
    expect(readSlotFromWorktree(wtDir)).toBe(1);
  });

  // ── Rule 3: slot-free example is NOT isolated ────────────────────────────

  it("seeds a slot-free .env.example verbatim but says plainly it is NOT isolated", () => {
    write(
      join(repoDir, ".env.example"),
      "DATABASE_URL=postgres://localhost/app\n",
    );

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 2,
    });

    expect(readFileSync(join(wtDir, ".env"), "utf-8")).toBe(
      "DATABASE_URL=postgres://localhost/app\n",
    );
    const w = r.warnings.join("\n");
    expect(w.toLowerCase()).toContain("not isolated");
    expect(w).toContain(SLOT_PLACEHOLDER);
  });

  // ── R11 (Phase 3): the warning can NAME the shared resources ─────────────
  //
  // The enrichment travels as DATA on SeedOptions, not as an import:
  // `src/worktree/` importing `src/runtime/loader.ts` would close a
  // worktree → runtime → worktree cycle (see runtime/no-module-cycle.test.ts).

  it("names the specific shared resources when the caller supplies them", () => {
    write(join(repoDir, ".env.example"), "DATABASE_URL=postgres://x/app\n");

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 2,
      sharedResources: ["database", "cache"],
    });

    const w = r.warnings.join("\n");
    expect(w).toContain("database, cache");
    expect(w.toLowerCase()).toContain("not isolated");
  });

  it("emits the BYTE-IDENTICAL Phase 2 warning when none are supplied", () => {
    // ⛔ The backward-compatibility guarantee: a project with no
    // `.sentinal/runtime.json` supplies nothing, and must see exactly the
    // string Phase 2 shipped — not "shared with the main checkout: ." and not
    // a reworded variant.
    write(join(repoDir, ".env.example"), "DATABASE_URL=postgres://x/app\n");

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 2,
    });

    expect(r.warnings).toContain(notIsolatedWarning(".env.example"));
    expect(r.warnings.join("\n")).not.toContain("Shared with the main checkout");
  });

  it("treats an explicitly EMPTY list the same as omitting it", () => {
    expect(notIsolatedWarning(".env.example", [])).toBe(
      notIsolatedWarning(".env.example"),
    );
  });

  // ── Rule 4: the sourceable slot env file ─────────────────────────────────

  it("writes a sourceable slot env file that readSlotFromWorktree can read back", () => {
    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 3,
    });

    expect(r.seeded).toContain(SLOT_ENV_RELATIVE_PATH);
    const content = readFileSync(join(wtDir, SLOT_ENV_RELATIVE_PATH), "utf-8");
    expect(content).toContain("SENTINAL_WORKTREE_SLOT=3");
    expect(readSlotFromWorktree(wtDir)).toBe(3);
  });

  it("a SLOTLESS worktree skips the slot env file and warns — never SLOT=null", () => {
    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: null,
    });

    expect(existsSync(join(wtDir, SLOT_ENV_RELATIVE_PATH))).toBe(false);
    expect(r.seeded).not.toContain(SLOT_ENV_RELATIVE_PATH);
    const w = r.warnings.join("\n");
    expect(w).toContain("slot");
    expect(w).not.toContain("SENTINAL_WORKTREE_SLOT=null");
  });

  it("a SLOTLESS worktree does not write a bogus slot into .env either", () => {
    write(join(repoDir, ".env.example"), `DB=app_${SLOT_PLACEHOLDER}\n`);

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: null,
    });

    const seeded = readFileSync(join(wtDir, ".env"), "utf-8");
    expect(seeded).not.toContain("null");
    expect(seeded).not.toContain("DB=app_\n");
    expect(r.warnings.join("\n")).toContain(SLOT_PLACEHOLDER);
  });

  // ── Rule 5: exclusion ────────────────────────────────────────────────────

  it("leaves `git status` clean inside the worktree and the main checkout untouched", () => {
    write(join(repoDir, ".env.example"), `PORT=30${SLOT_PLACEHOLDER}0\n`);
    git(["add", "."], repoDir);
    git(["commit", "-m", "add example"], repoDir);
    const excludePath = join(repoDir, ".git", "info", "exclude");
    const before = existsSync(excludePath)
      ? readFileSync(excludePath)
      : Buffer.alloc(0);

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 1,
    });

    expect(r.unexcluded).toEqual([]);
    expect(git(["status", "--porcelain"], wtDir)).toBe("");
    const after = existsSync(excludePath)
      ? readFileSync(excludePath)
      : Buffer.alloc(0);
    expect(after.equals(before)).toBe(true);
    expect(git(["status", "--porcelain"], repoDir)).toBe("");
  });

  it("with a TRACKED root .gitignore it reports .env as visible, but still hides the slot file", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    setup("node_modules/\n");
    write(join(repoDir, ".env.example"), `PORT=30${SLOT_PLACEHOLDER}0\n`);

    const r = seedWorktreeConfig({
      repoRoot: repoDir,
      worktreePath: wtDir,
      slot: 1,
    });

    // Honest: the root .env IS visible, and we say so rather than dirty a
    // tracked .gitignore.
    expect(r.unexcluded).toContain(".env");
    expect(git(["status", "--porcelain"], wtDir)).toContain("?? .env");
    expect(r.warnings.join("\n")).toContain(".gitignore");
    // But the sentinal-owned file is directory-scoped, so it is ALWAYS hidden.
    expect(r.unexcluded).not.toContain(SLOT_ENV_RELATIVE_PATH);
    expect(git(["status", "--porcelain"], wtDir)).not.toContain(".sentinal");
  });

  // ── I/O failure is fatal (the caller rolls back) ─────────────────────────

  it("THROWS on an I/O failure so the caller can roll the worktree back", () => {
    write(join(repoDir, ".env.example"), "A=1\n");

    expect(() =>
      seedWorktreeConfig({
        repoRoot: repoDir,
        worktreePath: wtDir,
        slot: 1,
        writeFile: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      }),
    ).toThrow(/ENOSPC/);
  });

  // ── The read-path variant must NOT throw ─────────────────────────────────

  describe("seedNonFatally", () => {
    it("downgrades an I/O failure to a warning, for read-shaped paths", () => {
      write(join(repoDir, ".env.example"), "A=1\n");
      const warnings: string[] = [];

      const r = seedNonFatally(
        {
          repoRoot: repoDir,
          worktreePath: wtDir,
          slot: 1,
          writeFile: () => {
            throw new Error("ENOSPC: no space left on device");
          },
        },
        warnings,
      );

      // `worktree_detect` must never hard-fail because seeding hit a bad disk.
      expect(r).toBeNull();
      const w = warnings.join("\n");
      expect(w).toContain("ENOSPC");
      // ...and it must still name the trap it is trying to keep the agent out of.
      expect(w).toContain(".env");
    });

    it("collects the normal warnings on the success path", () => {
      const warnings: string[] = [];
      const r = seedNonFatally(
        { repoRoot: repoDir, worktreePath: wtDir, slot: 1 },
        warnings,
      );

      expect(r).not.toBeNull();
      expect(warnings.join("\n")).toContain(".env.example");
    });
  });
});
