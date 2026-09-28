/**
 * `.sentinal/skills/sentinal-live-smoke/scripts/check-versions.sh` — the
 * "is the new version running?" probe. Since D6 of
 * docs/plans/2026-09-28-deferred-items.md the Claude Code plugin.json carries
 * the release version, so its row is a real check: a mismatch fails the
 * script. `0.1.0` (every pre-bake install) and "not installed" stay
 * informational. Run against a fake HOME / SENTINAL_HOME with stubbed
 * `sentinal` and `curl` on PATH — never the user's real install.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(
  REPO_ROOT,
  ".sentinal",
  "skills",
  "sentinal-live-smoke",
  "scripts",
  "check-versions.sh",
);
const CC_REL =
  ".claude/plugins/sentinal-marketplace/plugins/sentinal/.claude-plugin/plugin.json";
const OC_REL = ".config/opencode/plugins/sentinal.mjs";

describe("check-versions.sh", () => {
  let home: string;
  let bin: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sentinal-check-versions-"));
    bin = join(home, "bin");
    mkdirSync(bin);
    mkdirSync(join(home, ".sentinal"));
    writeFileSync(join(home, ".sentinal", "sidecar.pid"), "4242\n");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function stub(name: string, body: string): void {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }

  function setup(opts: { cc?: string; oc?: string; side?: string }): void {
    const want = "1.40.0";
    stub("sentinal", `echo ${want}`);
    stub("curl", `echo '{"status":"ok","version":"${opts.side ?? want}"}'`);
    const oc = join(home, OC_REL);
    mkdirSync(dirname(oc), { recursive: true });
    writeFileSync(
      oc,
      `function getSentinalVersion() {\n  if (true) {\n    return "${opts.oc ?? want}";\n  }\n}\n`,
    );
    if (opts.cc !== undefined) {
      const cc = join(home, CC_REL);
      mkdirSync(dirname(cc), { recursive: true });
      writeFileSync(
        cc,
        `{\n  "name": "sentinal",\n  "version": "${opts.cc}"\n}\n`,
      );
    }
  }

  function run(): { code: number; out: string } {
    const r = Bun.spawnSync(["bash", SCRIPT], {
      env: {
        HOME: home,
        SENTINAL_HOME: join(home, ".sentinal"),
        PATH: `${bin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString() };
  }

  it("parses", () => {
    expect(Bun.spawnSync(["bash", "-n", SCRIPT]).exitCode).toBe(0);
  });

  it("passes when every part, the CC plugin included, reports the binary's version", () => {
    setup({ cc: "1.40.0" });
    const { code, out } = run();
    expect(out).toContain("ALL RUNNING 1.40.0");
    expect(out).toMatch(/cc plugin\.json\s+1\.40\.0\s+ok/);
    expect(code).toBe(0);
  });

  it("FAILS when the installed CC plugin carries a different real version", () => {
    setup({ cc: "1.39.2" });
    const { code, out } = run();
    expect(out).toMatch(/cc plugin\.json\s+1\.39\.2\s+<-/);
    expect(out).toContain("MISMATCH");
    expect(code).toBe(1);
  });

  it("treats the pre-bake 0.1.0 as informational, with a hint", () => {
    setup({ cc: "0.1.0" });
    const { code, out } = run();
    expect(out).toMatch(/cc plugin\.json\s+0\.1\.0\s+.*sentinal update/);
    expect(out).toContain("ALL RUNNING");
    expect(code).toBe(0);
  });

  it("treats a missing CC install as informational", () => {
    setup({});
    const { code, out } = run();
    expect(out).toMatch(/cc plugin\.json\s+<none>\s+\(not installed\)/);
    expect(code).toBe(0);
  });

  it("still fails on a stale sidecar (bad set outside the subshell)", () => {
    setup({ cc: "1.40.0", side: "1.39.2" });
    expect(run().code).toBe(1);
  });
});
