/**
 * Process-ownership verification — the single gate in front of every signal.
 *
 * ⛔ The contract these tests pin down is "**refuse when unsure**". Every probe
 * failure, every unparsable `ps` output, every unavailable tool must resolve to
 * `false` (not owned), because the alternative is signalling a PID we cannot
 * prove is ours. That is the same error class as the `pkill -f` this whole
 * master plan exists to eliminate.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processBelongsToWorktree,
  verifiedGroupMembers,
  listGroupMembers,
  maySignalGroup,
  isProcessAlive,
} from "./ownership.js";

const spawned: { kill(): void }[] = [];

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
});

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "sentinal-own-")));
}

describe("processBelongsToWorktree", () => {
  it("is true when the command line references the worktree path", () => {
    const wt = tmp();
    const verdict = processBelongsToWorktree(1234, wt, {
      commandOf: () => `sh -c cd ${wt} && node server.js`,
      cwdOf: () => null,
    });
    expect(verdict).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  it("is true when the cwd is inside the worktree even if the cmdline is opaque", () => {
    // The realistic case: `up` is `npm run dev`, which execs into a `node`
    // whose argv mentions the worktree nowhere. cwd is the only proof left.
    const wt = tmp();
    const verdict = processBelongsToWorktree(1234, wt, {
      commandOf: () => "node /opt/homebrew/lib/node_modules/.bin/next dev",
      cwdOf: () => join(wt, "packages", "api"),
    });
    expect(verdict).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  it("is FALSE for a live process that references some other directory", () => {
    const wt = tmp();
    const other = tmp();
    const verdict = processBelongsToWorktree(1234, wt, {
      commandOf: () => `node ${other}/server.js`,
      cwdOf: () => other,
    });
    expect(verdict).toBe(false);
    rmSync(wt, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("is FALSE when ownership cannot be verified at all (no ps, no cwd)", () => {
    const wt = tmp();
    expect(
      processBelongsToWorktree(1234, wt, {
        commandOf: () => null,
        cwdOf: () => null,
      }),
    ).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  it("is FALSE when a probe throws — never 'assume ours'", () => {
    const wt = tmp();
    expect(
      processBelongsToWorktree(1234, wt, {
        commandOf: () => {
          throw new Error("ps: command not found");
        },
        cwdOf: () => {
          throw new Error("lsof: command not found");
        },
      }),
    ).toBe(false);
    rmSync(wt, { recursive: true, force: true });
  });

  it("does not match a sibling directory sharing a path prefix", () => {
    const wt = "/tmp/sentinal-wt-a";
    expect(
      processBelongsToWorktree(1234, wt, {
        commandOf: () => null,
        cwdOf: () => "/tmp/sentinal-wt-a-other",
      }),
    ).toBe(false);
  });

  it("verifies a REAL process by cwd against the real probes", () => {
    const wt = tmp();
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(proc);

    // `sleep 30` names the worktree nowhere — cwd is the whole proof.
    expect(processBelongsToWorktree(proc.pid, wt)).toBe(true);
    // ...and a different directory must NOT match.
    const other = tmp();
    expect(processBelongsToWorktree(proc.pid, other)).toBe(false);

    proc.kill();
    rmSync(wt, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
});

describe("isProcessAlive", () => {
  it("is true for this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for a PID that cannot exist", () => {
    expect(isProcessAlive(0x7ffffff0)).toBe(false);
  });
});

describe("verifiedGroupMembers", () => {
  it("returns only the live members whose ownership is provable", () => {
    const wt = tmp();
    const members = verifiedGroupMembers(4242, wt, {
      listGroup: () => [111, 222, 333],
      isAlive: () => true,
      commandOf: (pid) =>
        pid === 222 ? `sh -c cd ${wt} && npm start` : "sshd",
      cwdOf: () => null,
    });
    expect(members).toEqual([222]);
    rmSync(wt, { recursive: true, force: true });
  });

  it("excludes a member that is provably ours but no longer alive", () => {
    const wt = tmp();
    const members = verifiedGroupMembers(4242, wt, {
      listGroup: () => [111, 222],
      isAlive: (pid) => pid === 111,
      commandOf: () => `sh -c cd ${wt} && npm start`,
      cwdOf: () => null,
    });
    expect(members).toEqual([111]);
    rmSync(wt, { recursive: true, force: true });
  });

  it("returns EMPTY when no member can be proven — the refuse-to-signal case", () => {
    const wt = tmp();
    expect(
      verifiedGroupMembers(4242, wt, {
        listGroup: () => [111, 222],
        isAlive: () => true, // alive, but unprovable — must still refuse
        commandOf: () => "/usr/sbin/cupsd -l",
        cwdOf: () => null,
      }),
    ).toEqual([]);
    rmSync(wt, { recursive: true, force: true });
  });

  it("returns EMPTY when the group cannot be enumerated", () => {
    const wt = tmp();
    expect(
      verifiedGroupMembers(4242, wt, {
        listGroup: () => {
          throw new Error("ps unavailable");
        },
        isAlive: () => true,
        commandOf: () => `everything in ${wt}`,
        cwdOf: () => wt,
      }),
    ).toEqual([]);
    rmSync(wt, { recursive: true, force: true });
  });

  it("never reports the init/kernel group", () => {
    const wt = tmp();
    expect(
      verifiedGroupMembers(0, wt, {
        listGroup: () => [1],
        isAlive: () => true,
        commandOf: () => `anything ${wt}`,
        cwdOf: () => null,
      }),
    ).toEqual([]);
    rmSync(wt, { recursive: true, force: true });
  });

  it("finds a REAL detached child by its process group", () => {
    const wt = tmp();
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(proc);

    // On POSIX `detached` calls setsid(), so pgid === pid.
    const members = verifiedGroupMembers(proc.pid, wt);
    expect(members).toContain(proc.pid);

    proc.kill();
    rmSync(wt, { recursive: true, force: true });
  });
});

describe("listGroupMembers", () => {
  /**
   * ⛔ Why this exists ALONGSIDE `verifiedGroupMembers`.
   *
   * Teardown must distinguish two situations that `verifiedGroupMembers`
   * collapses into the same empty array:
   *
   *   - the group is genuinely **gone** → nothing to signal, that is a SUCCESS;
   *   - the group has **live members we cannot prove are ours** → REFUSE.
   *
   * Answering "success" to the second case would leave an orphan running and
   * report that it had been cleaned up. Answering "refuse" to the first would
   * wedge every teardown of an already-stopped runtime.
   */
  it("reports live members regardless of whether they can be proven ours", () => {
    expect(
      listGroupMembers(4242, {
        listGroup: () => [111, 222],
        isAlive: () => true,
        commandOf: () => "/usr/sbin/cupsd -l",
        cwdOf: () => null,
      }),
    ).toEqual({ kind: "members", members: [111, 222] });
  });

  it("filters out members that are no longer alive", () => {
    expect(
      listGroupMembers(4242, {
        listGroup: () => [111, 222],
        isAlive: (pid) => pid === 222,
      }),
    ).toEqual({ kind: "members", members: [222] });
  });

  it("is an EMPTY member list for a group with no members — the 'already gone' case", () => {
    expect(listGroupMembers(4242, { listGroup: () => [] })).toEqual({
      kind: "members",
      members: [],
    });
  });

  /**
   * ⛔ THE must_fix. "Enumerated, and the group is empty" and "could not
   * enumerate" are **different facts** and must not share an encoding.
   *
   * Collapsing them makes a broken `ps` read as "the runtime is already
   * stopped", which makes teardown report success and delete the ownership
   * record for a group that may still be running, and makes guard 5 authorise
   * a directory deletion. This module's stated rule is "refuse when unsure",
   * and `probeAlive`/`safeAlive` already default to ALIVE on probe failure for
   * exactly this reason — enumeration must follow the same rule.
   */
  it("⛔ reports UNKNOWN — not an empty group — when enumeration THROWS", () => {
    const r = listGroupMembers(4242, {
      listGroup: () => {
        throw new Error("ps unavailable");
      },
    });
    expect(r.kind).toBe("unknown");
    if (r.kind !== "unknown") throw new Error("unreachable");
    expect(r.reason).toContain("4242");
  });

  it("⛔ reports UNKNOWN when the probe itself answers `null` (ps exited non-zero)", () => {
    const r = listGroupMembers(4242, { listGroup: () => null });
    expect(r.kind).toBe("unknown");
  });

  it("never reports the init/kernel group", () => {
    expect(
      listGroupMembers(0, { listGroup: () => [1], isAlive: () => true }),
    ).toEqual({ kind: "members", members: [] });
    expect(
      listGroupMembers(1, { listGroup: () => [1], isAlive: () => true }),
    ).toEqual({ kind: "members", members: [] });
  });

  it("enumerates a REAL detached child, and EXCLUDES a sibling in a different group", () => {
    // ⛔ The portability regression canary. `ps -o pid= -g <pgid>` is not
    // portable process-group selection: Darwin's ps(1) documents `-g` as
    // "Ignored", and Linux/procps reads it as a SESSION id. Both `sleep`s
    // below are detached, so each is its own session AND its own group —
    // selecting by session would still separate them, but selecting by pgid
    // is exact on both platforms, which is what this asserts.
    const mine = Bun.spawn(["sleep", "30"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const theirs = Bun.spawn(["sleep", "30"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(mine, theirs);

    const r = listGroupMembers(mine.pid);
    expect(r.kind).toBe("members");
    if (r.kind !== "members") throw new Error("unreachable");
    expect(r.members).toContain(mine.pid);
    expect(r.members).not.toContain(theirs.pid);

    mine.kill();
    theirs.kill();
  }, 20_000);
});

describe("maySignalGroup", () => {
  /**
   * ⛔ The single decision in front of every `kill -- -$PGID`. It lives here
   * rather than in `teardown.ts` because the orphan-reap preflight in
   * `runtime_up` asks exactly the same question, and two copies of a rule this
   * dangerous is one copy too many.
   */
  it("ALLOWS when the verified leader IS the group (pgid === pid, the setsid case)", () => {
    const wt = tmp();
    const v = maySignalGroup({
      pgid: 4242,
      leaderPid: 4242,
      leaderVerified: true,
      worktreePath: wt,
      probes: {
        listGroup: () => {
          throw new Error("must not need to enumerate");
        },
      },
    });
    expect(v).toEqual({ kind: "allow", witness: null });
    rmSync(wt, { recursive: true, force: true });
  });

  it("still enumerates when a verified leader's pgid is NOT its own pid", () => {
    // A pgid we did not create with setsid() says nothing about provenance:
    // the leader may be a member of somebody else's group.
    const wt = tmp();
    const v = maySignalGroup({
      pgid: 100,
      leaderPid: 4242,
      leaderVerified: true,
      worktreePath: wt,
      probes: {
        listGroup: () => [4242, 555],
        isAlive: () => true,
        commandOf: () => "/usr/sbin/cupsd",
        cwdOf: () => "/",
      },
    });
    expect(v.kind).toBe("refuse");
    rmSync(wt, { recursive: true, force: true });
  });

  it("reports GONE — not refuse — when the group has no live members", () => {
    const wt = tmp();
    expect(
      maySignalGroup({
        pgid: 4242,
        leaderPid: 4242,
        leaderVerified: false,
        worktreePath: wt,
        probes: { listGroup: () => [] },
      }),
    ).toEqual({ kind: "gone" });
    rmSync(wt, { recursive: true, force: true });
  });

  it("⛔ REFUSES when live members exist but NONE references the worktree", () => {
    const wt = tmp();
    const v = maySignalGroup({
      pgid: 4242,
      leaderPid: 4242,
      leaderVerified: false,
      worktreePath: wt,
      probes: {
        listGroup: () => [111, 222],
        isAlive: () => true,
        commandOf: () => "/usr/sbin/cupsd -l",
        cwdOf: () => "/",
      },
    });
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") throw new Error("unreachable");
    expect(v.reason).toContain("4242");
    expect(v.reason).toContain("111");
    expect(v.reason.toLowerCase()).toContain("refus");
    rmSync(wt, { recursive: true, force: true });
  });

  it("⛔ REFUSES — never `gone` — when the group could not be ENUMERATED", () => {
    // A failed probe is not evidence of an empty group. `gone` is read by
    // `stopOwnedGroup` as SUCCESS and deletes the ownership record, so
    // answering `gone` here destroys the only record of a group that may
    // still be running.
    const wt = tmp();
    const v = maySignalGroup({
      pgid: 4242,
      leaderPid: 4242,
      leaderVerified: false,
      worktreePath: wt,
      probes: {
        listGroup: () => {
          throw new Error("ps: command not found");
        },
      },
    });
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") throw new Error("unreachable");
    expect(v.reason).toContain("4242");
    expect(v.reason.toLowerCase()).toContain("refus");
    // The remedy must say the record is being KEPT — an agent told only
    // "refused" will reach for the delete.
    expect(v.reason).toContain("runtime.pid");
    rmSync(wt, { recursive: true, force: true });
  });

  it("⛔ REFUSES when enumeration answers `null`, even for a VERIFIED leader whose pgid differs", () => {
    const wt = tmp();
    const v = maySignalGroup({
      pgid: 100,
      leaderPid: 4242,
      leaderVerified: true,
      worktreePath: wt,
      probes: { listGroup: () => null },
    });
    expect(v.kind).toBe("refuse");
    rmSync(wt, { recursive: true, force: true });
  });

  it("ALLOWS with a witness when at least one live member is provably ours", () => {
    const wt = tmp();
    const v = maySignalGroup({
      pgid: 4242,
      leaderPid: 4242,
      leaderVerified: false,
      worktreePath: wt,
      probes: {
        listGroup: () => [111, 222],
        isAlive: () => true,
        commandOf: (pid) => (pid === 222 ? `node server.js ${wt}` : "cupsd"),
        cwdOf: () => null,
      },
    });
    expect(v).toEqual({ kind: "allow", witness: 222 });
    rmSync(wt, { recursive: true, force: true });
  });
});
