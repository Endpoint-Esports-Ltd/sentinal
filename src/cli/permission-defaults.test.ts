/**
 * D4a — shipped permission defaults.
 *
 * Sentinal builds no destructive-command guard (D4: shell safety is user
 * configuration, not Sentinal's remit). Instead it ships an OPT-OUT default
 * that routes `pkill` / `killall` through the platform's native confirmation
 * prompt. This suite pins where that default must be present, where it must
 * deliberately be ABSENT, and the documentation invariants that make it usable.
 *
 * The empirical round-trip behaviour (what survives an in-place update) is
 * covered separately by `tests/e2e/permission-defaults.e2e.ts`, which is opt-in
 * because it runs real installs. This file is the fast CI guard.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const OC_CONFIG = join(REPO_ROOT, "targets", "opencode", "opencode.json");
const CC_SETTINGS = join(REPO_ROOT, "targets", "claude-code", "settings.json");
const RULE_FILES = [
  join(REPO_ROOT, "targets", "claude-code", "rules", "verification.md"),
  join(REPO_ROOT, "targets", "opencode", "rules", "verification.md"),
];

const GUARDED_PATTERNS = ["pkill*", "killall*"];

type PermissionBlock = {
  bash?: Record<string, string> | string;
  [k: string]: unknown;
};
type OcConfig = {
  permission?: PermissionBlock;
  agent?: Record<string, { permission?: PermissionBlock }>;
};

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf-8")) as T;

describe("OpenCode — permission.bash opt-out default", () => {
  const config = readJson<OcConfig>(OC_CONFIG);

  it("declares a top-level permission.bash block", () => {
    // Before this change there was NO `bash` key at all, so the shell policy
    // was entirely unset.
    expect(config.permission?.bash).toBeDefined();
    expect(typeof config.permission?.bash).toBe("object");
  });

  it.each(GUARDED_PATTERNS)(
    "routes %s through the native ask prompt",
    (pat) => {
      const bash = config.permission?.bash as Record<string, string>;
      expect(bash[pat]).toBe("ask");
    },
  );

  /**
   * ⛔ Ordering invariant — OpenCode resolves permissions to an ORDERED LIST
   * and the LAST match wins. (Established by OpenCode's own built-in defaults:
   * `read *`=allow, `read *.env`=ask, `read *.env.example`=allow — coherent
   * only under last-match-wins.) A broad `"*"` placed AFTER the specific
   * patterns would silently neuter them.
   */
  it("does not place a broad '*' pattern after the guarded patterns", () => {
    const bash = config.permission?.bash as Record<string, string>;
    const keys = Object.keys(bash);
    const star = keys.indexOf("*");
    if (star === -1) return; // no broad entry at all — fine
    for (const pat of GUARDED_PATTERNS) {
      const idx = keys.indexOf(pat);
      if (idx !== -1) expect(star).toBeLessThan(idx);
    }
  });

  /**
   * ⛔ The map must stay WILDCARD-LESS. This is the counter-intuitive one, and
   * it was settled by measurement, not reasoning.
   *
   * The worry: with no `"*"` key, does OpenCode synthesise a default for the
   * bash map? `Permission.evaluate` does fall back to `{action:"ask"}` when
   * NOTHING matches — so if the built-in catch-all did not apply, every bash
   * command would prompt for every user.
   *
   * Measured against OpenCode 1.18.15, isolated HOME/XDG, `opencode serve` +
   * `GET /agent`, using THIS exact file:
   *
   *   agent build/plan/general/explore
   *     ls -la, git status, bun test, rm -rf node_modules  -> allow
   *     pkill -f foo, killall node                         -> ask
   *
   * The built-in `{permission:"*", pattern:"*", action:"allow"}` sits at index
   * 0 of every resolved ruleset and catches everything the guarded patterns do
   * not, so the wildcard-less map is safe.
   *
   * Adding `"*": "allow"` was then measured too, and is strictly WORSE: it
   * changes nothing for the four user-facing agents but flips `compaction`,
   * `summary` and `title` from OpenCode's built-in `deny` to `allow` — handing
   * shell access to internal agents the platform deliberately denies. It would
   * also override a user's own narrower top-level bash policy.
   *
   * The live resolution is pinned end-to-end in
   * `tests/e2e/permission-defaults.e2e.ts`; this is the fast guard on the input.
   */
  it("declares NO broad '*' bash key (adding one widens OpenCode's own denies)", () => {
    const bash = config.permission?.bash as Record<string, string>;
    expect(Object.keys(bash)).not.toContain("*");
  });

  /**
   * Nothing in the shipped map may LOOSEN a policy. `ask` is the only action
   * this default is entitled to set — an `allow` here would silently override
   * a stricter policy the user set in a parent config, and a `deny` would take
   * away agency the D4a decision explicitly chose to preserve
   * ("warn-with-agency delivered by the platform").
   */
  it("sets only 'ask' — never allow or deny", () => {
    const bash = config.permission?.bash as Record<string, string>;
    for (const [pattern, action] of Object.entries(bash)) {
      expect(`${pattern}=${action}`).toBe(`${pattern}=ask`);
    }
  });

  /**
   * R16 — per-agent `permission` blocks MERGE with the top level rather than
   * replacing it (verified empirically against OpenCode 1.18.15 via
   * `GET /agent`; see the Phase 1 spike doc). So the top-level declaration is
   * sufficient TODAY. But because the per-agent block is appended AFTER the
   * top-level one, an agent that later declares its own `bash` map WOULD
   * override the default under last-match-wins. This guard makes that a
   * deliberate, visible choice instead of a silent regression.
   */
  it("no per-agent permission block overrides the guarded patterns", () => {
    for (const [name, agent] of Object.entries(config.agent ?? {})) {
      const bash = agent.permission?.bash;
      if (bash === undefined) continue;
      if (typeof bash === "string") {
        throw new Error(
          `agent.${name}.permission.bash is the scalar "${bash}", which overrides ` +
            `the top-level pkill/killall defaults for that agent. Either remove it ` +
            `or restate the guarded patterns inside it.`,
        );
      }
      for (const pat of GUARDED_PATTERNS) {
        expect(bash[pat] ?? "ask").toBe("ask");
      }
    }
  });
});

describe("Claude Code — the default is deliberately NOT shipped (D-P1-a)", () => {
  const settings = readJson<{ permissions?: Record<string, unknown> }>(
    CC_SETTINGS,
  );

  /**
   * Claude Code reads ONLY the `agent` and `subagentStatusLine` keys out of a
   * plugin-root `settings.json` (plugins reference, "File locations reference").
   * A `permissions.ask` entry here would be INERT: it would satisfy a naive
   * presence test while changing nothing at runtime, which is worse than not
   * shipping it — it would look like the platform is covered when it is not.
   *
   * The user-facing manual opt-in snippet lives in `rules/verification.md`.
   * If Claude Code ever widens the supported key set, delete this test and
   * ship the default for real.
   */
  it("has no permissions.ask block (it would be inert, not merely redundant)", () => {
    expect(settings.permissions?.ask).toBeUndefined();
  });

  /**
   * Was: "still has an empty deny list — nothing was smuggled in there
   * instead", asserting `permissions.deny === []`. The whole `permissions`
   * block has since been REMOVED (2026-08-20) — the same two-key allowlist
   * that makes `ask` inert makes the ~45-entry `allow` list inert too, and an
   * allowlist containing a bare `"Bash"` and `Bash(rm:*)` reads as a shipped
   * security posture that Sentinal does not actually grant. Asserting the key
   * is absent entirely is the stronger form of the original intent: nothing
   * can be smuggled into a block that does not exist.
   *
   * See `target-assets.test.ts` → "no NEW inert keys" for the ratchet, and the
   * README "Recommended ~/.claude/settings.json" section for where the list
   * lives now.
   */
  it("ships no permissions block at all — nothing can be smuggled in", () => {
    expect(settings.permissions).toBeUndefined();
  });
});

describe("Both targets — opt-out documentation", () => {
  it.each(RULE_FILES)("%s documents the opt-out", (file) => {
    const content = readFileSync(file, "utf-8");

    // Names the mechanism.
    expect(content).toContain("pkill");
    expect(content).toContain("killall");

    /**
     * ⛔ The single most important wording invariant. `deepMergeAdditive`
     * (install-shared.ts) re-adds keys that are ABSENT from the user's config,
     * so telling a user to DELETE the line is telling them to do the one thing
     * that silently reverts on the next update. Changing the value survives.
     * Verified end-to-end in tests/e2e/permission-defaults.e2e.ts.
     */
    expect(content).toMatch(/Do not delete the line/i);
    expect(content).toMatch(/change the value to `"allow"`/i);

    // Claude Code's manual opt-in snippet must be present, since the default
    // cannot be shipped there.
    expect(content).toContain('"Bash(pkill:*)"');
  });
});
