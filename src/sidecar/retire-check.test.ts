/**
 * Tests for retire-check.ts — binary staleness detection (Task 3).
 *
 * All seams are injected: no test stats or spawns the real installed binary.
 * Tests run from source, where `__SENTINAL_VERSION__` is undefined, so the
 * compiled gate is exercised via `forceCompiled` in BOTH polarities.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  utimesSync,
} from "node:fs";
import {
  detectBinaryStaleness,
  type BinaryStalenessOptions,
} from "./retire-check.js";

const BIN = "/fake/home/bin/sentinal";

/** Mutable fake filesystem + prober with call counters. */
function makeSeams(initial: {
  mtime: number | null;
  stdout?: string;
  proberError?: Error;
}) {
  const state = {
    mtime: initial.mtime,
    stdout: initial.stdout ?? "1.0.0\n",
    proberError: initial.proberError as Error | undefined,
    statCalls: 0,
    probeCalls: 0,
    probedPaths: [] as string[],
  };
  const opts: BinaryStalenessOptions = {
    binPath: BIN,
    runningVersion: "1.0.0",
    forceCompiled: true,
    statter: (p: string) => {
      state.statCalls++;
      if (p !== BIN) throw new Error(`unexpected path ${p}`);
      if (state.mtime === null) throw new Error("ENOENT");
      return state.mtime;
    },
    versionProber: async (p: string) => {
      state.probeCalls++;
      state.probedPaths.push(p);
      if (state.proberError) throw state.proberError;
      return state.stdout;
    },
  };
  return { state, opts };
}

describe("detectBinaryStaleness", () => {
  let savedKill: string | undefined;
  beforeEach(() => {
    savedKill = process.env.SENTINAL_NO_AUTO_RETIRE;
    delete process.env.SENTINAL_NO_AUTO_RETIRE;
  });
  afterEach(() => {
    if (savedKill === undefined) delete process.env.SENTINAL_NO_AUTO_RETIRE;
    else process.env.SENTINAL_NO_AUTO_RETIRE = savedKill;
  });

  it("unchanged mtime → not stale and NO spawn occurs", async () => {
    const { state, opts } = makeSeams({ mtime: 1000 });
    const checker = detectBinaryStaleness(opts);
    for (let i = 0; i < 5; i++) {
      const r = await checker.check();
      expect(r.stale).toBe(false);
    }
    expect(state.probeCalls).toBe(0);
    expect(state.statCalls).toBe(6); // 1 snapshot + 5 polls
  });

  it("changed mtime + different version → stale, reporting both versions", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "1.1.0\n" });
    const checker = detectBinaryStaleness(opts);
    state.mtime = 2000;
    const r = await checker.check();
    expect(r.stale).toBe(true);
    expect(r.runningVersion).toBe("1.0.0");
    expect(r.installedVersion).toBe("1.1.0");
    expect(state.probeCalls).toBe(1);
    expect(state.probedPaths).toEqual([BIN]);
  });

  it("latches: once stale, stays stale without re-stat or re-spawn", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "1.1.0" });
    const checker = detectBinaryStaleness(opts);
    state.mtime = 2000;
    expect((await checker.check()).stale).toBe(true);
    const statsAfter = state.statCalls;
    // Even if the binary is rolled back, a confirmed-stale sidecar stays stale.
    state.stdout = "1.0.0";
    state.mtime = 3000;
    const r = await checker.check();
    expect(r.stale).toBe(true);
    expect(r.installedVersion).toBe("1.1.0");
    expect(state.probeCalls).toBe(1);
    expect(state.statCalls).toBe(statsAfter);
  });

  it("changed mtime + same version → not stale, and re-snapshots (no re-spawn next tick)", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "1.0.0" });
    const checker = detectBinaryStaleness(opts);
    state.mtime = 2000; // e.g. reinstall of the same version / touch
    expect((await checker.check()).stale).toBe(false);
    expect((await checker.check()).stale).toBe(false);
    expect((await checker.check()).stale).toBe(false);
    expect(state.probeCalls).toBe(1);
    // A later genuine upgrade is still detected.
    state.mtime = 3000;
    state.stdout = "2.0.0";
    expect((await checker.check()).stale).toBe(true);
    expect(state.probeCalls).toBe(2);
  });

  it("missing binary at poll time → not stale, no throw, no spawn", async () => {
    const { state, opts } = makeSeams({ mtime: 1000 });
    const checker = detectBinaryStaleness(opts);
    state.mtime = null; // mid-update: file removed
    const r = await checker.check();
    expect(r.stale).toBe(false);
    expect(state.probeCalls).toBe(0);
    // Binary reappears with the same mtime → still no spawn.
    state.mtime = 1000;
    expect((await checker.check()).stale).toBe(false);
    expect(state.probeCalls).toBe(0);
  });

  it("binary missing at boot, later installed with a new version → stale", async () => {
    const { state, opts } = makeSeams({ mtime: null, stdout: "1.2.0" });
    const checker = detectBinaryStaleness(opts);
    expect((await checker.check()).stale).toBe(false);
    expect(state.probeCalls).toBe(0);
    state.mtime = 5000;
    expect((await checker.check()).stale).toBe(true);
  });

  it("spawn failure → not stale, no throw; retried on the next tick (snapshot kept)", async () => {
    const { state, opts } = makeSeams({
      mtime: 1000,
      proberError: new Error("spawn EACCES"),
    });
    const checker = detectBinaryStaleness(opts);
    state.mtime = 2000;
    expect((await checker.check()).stale).toBe(false);
    expect(state.probeCalls).toBe(1);
    // Install finishes; next tick re-probes because the snapshot was not advanced.
    state.proberError = undefined;
    state.stdout = "1.1.0";
    expect((await checker.check()).stale).toBe(true);
    expect(state.probeCalls).toBe(2);
  });

  it("unparseable --version output (e.g. literal 'undefined') → not stale", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "undefined\n" });
    const checker = detectBinaryStaleness(opts);
    state.mtime = 2000;
    const r = await checker.check();
    expect(r.stale).toBe(false);
    expect(state.probeCalls).toBe(1);
  });

  it("a throwing statter at construction never throws", async () => {
    const opts: BinaryStalenessOptions = {
      binPath: BIN,
      runningVersion: "1.0.0",
      forceCompiled: true,
      statter: () => {
        throw new Error("boom");
      },
      versionProber: async () => "9.9.9",
    };
    const checker = detectBinaryStaleness(opts);
    expect((await checker.check()).stale).toBe(false);
  });

  it("SENTINAL_NO_AUTO_RETIRE=1 → never stale, no spawn", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "9.9.9" });
    const checker = detectBinaryStaleness(opts);
    process.env.SENTINAL_NO_AUTO_RETIRE = "1";
    state.mtime = 2000;
    const r = await checker.check();
    expect(r.stale).toBe(false);
    expect(state.probeCalls).toBe(0);
  });

  it("compiled gate ACTIVE (forceCompiled: true) detects staleness", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "1.1.0" });
    const checker = detectBinaryStaleness({ ...opts, forceCompiled: true });
    expect(checker.active).toBe(true);
    state.mtime = 2000;
    expect((await checker.check()).stale).toBe(true);
  });

  it("compiled gate INACTIVE (forceCompiled: false) → never stale, no stat, no spawn", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "1.1.0" });
    const checker = detectBinaryStaleness({ ...opts, forceCompiled: false });
    expect(checker.active).toBe(false);
    state.mtime = 2000;
    expect((await checker.check()).stale).toBe(false);
    expect(state.statCalls).toBe(0);
    expect(state.probeCalls).toBe(0);
  });

  it("source run (no forceCompiled, __SENTINAL_VERSION__ undefined) is inactive", () => {
    const { opts } = makeSeams({ mtime: 1000 });
    const { forceCompiled: _drop, ...rest } = opts;
    expect(detectBinaryStaleness(rest).active).toBe(false);
  });

  it("Pre-Mortem 2: a build WITH the __SENTINAL_VERSION__ define is ACTIVE (production polarity)", async () => {
    const dir = join(tmpdir(), `retire-define-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const entry = join(dir, "entry.ts");
      const out = join(dir, "out.js");
      const mod = join(import.meta.dir, "retire-check.ts");
      writeFileSync(
        entry,
        `import { detectBinaryStaleness } from ${JSON.stringify(mod)};\n` +
          `const c = detectBinaryStaleness({ binPath: "/nonexistent", statter: () => 1 });\n` +
          `console.log(JSON.stringify({ active: c.active }));\n`,
      );
      const build = Bun.spawnSync([
        process.execPath,
        "build",
        entry,
        "--target",
        "bun",
        "--define",
        `__SENTINAL_VERSION__="9.9.9"`,
        "--outfile",
        out,
      ]);
      expect(build.exitCode).toBe(0);
      const run = Bun.spawnSync([process.execPath, out]);
      expect(JSON.parse(run.stdout.toString().trim())).toEqual({
        active: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("concurrent checks share one in-flight probe", async () => {
    const { state, opts } = makeSeams({ mtime: 1000, stdout: "1.1.0" });
    const checker = detectBinaryStaleness(opts);
    state.mtime = 2000;
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    expect(a.stale).toBe(true);
    expect(b.stale).toBe(true);
    expect(state.probeCalls).toBe(1);
  });

  describe("default seams (real stat + async spawn against a temp script)", () => {
    const dir = join(tmpdir(), `retire-check-${process.pid}-${Date.now()}`);
    const bin = join(dir, "sentinal");
    beforeEach(() => mkdirSync(dir, { recursive: true }));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function writeBin(version: string, mtimeSec: number): void {
      writeFileSync(bin, `#!/bin/sh\necho "${version}"\n`);
      chmodSync(bin, 0o755);
      utimesSync(bin, mtimeSec, mtimeSec);
    }

    it("detects a replaced binary end-to-end", async () => {
      writeBin("1.0.0", 1_000_000);
      const checker = detectBinaryStaleness({
        binPath: bin,
        runningVersion: "1.0.0",
        forceCompiled: true,
      });
      expect((await checker.check()).stale).toBe(false);
      writeBin("1.4.2", 2_000_000);
      const r = await checker.check();
      expect(r.stale).toBe(true);
      expect(r.installedVersion).toBe("1.4.2");
    }, 10_000);

    it("a non-executable replacement → not stale, no throw", async () => {
      writeBin("1.0.0", 1_000_000);
      const checker = detectBinaryStaleness({
        binPath: bin,
        runningVersion: "1.0.0",
        forceCompiled: true,
      });
      writeFileSync(bin, "garbage");
      chmodSync(bin, 0o644);
      utimesSync(bin, 3_000_000, 3_000_000);
      expect((await checker.check()).stale).toBe(false);
    }, 10_000);

    it("defaults binPath to $SENTINAL_HOME/bin/sentinal", async () => {
      const saved = process.env.SENTINAL_HOME;
      process.env.SENTINAL_HOME = dir;
      try {
        mkdirSync(join(dir, "bin"), { recursive: true });
        const home = join(dir, "bin", "sentinal");
        writeFileSync(home, `#!/bin/sh\necho "1.0.0"\n`);
        chmodSync(home, 0o755);
        utimesSync(home, 1_000_000, 1_000_000);
        const checker = detectBinaryStaleness({
          runningVersion: "1.0.0",
          forceCompiled: true,
        });
        expect(checker.binPath).toBe(home);
        writeFileSync(home, `#!/bin/sh\necho "7.0.0"\n`);
        utimesSync(home, 2_000_000, 2_000_000);
        expect((await checker.check()).stale).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.SENTINAL_HOME;
        else process.env.SENTINAL_HOME = saved;
      }
    }, 10_000);
  });
});
