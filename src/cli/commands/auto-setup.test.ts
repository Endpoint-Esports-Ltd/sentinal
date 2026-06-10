import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { runAutoSetup } from "./auto-setup.js";

const ENV_KEY = "SENTINAL_NO_AUTO_SETUP";

describe("runAutoSetup", () => {
  let savedEnv: string | undefined;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    logs = [];
    errs = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.join(" "));
    });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    mock.restore();
  });

  test("runs the setup runner and prints its report", async () => {
    let ran = 0;
    await runAutoSetup("install", async () => {
      ran++;
      return { ok: true, report: "REPORT-LINE-12345" };
    });

    expect(ran).toBe(1);
    expect(logs.join("\n")).toContain("REPORT-LINE-12345");
    // Success path must not tell the user to run setup manually
    expect([...logs, ...errs].join("\n")).not.toContain(
      "Run 'sentinal memory setup' manually",
    );
  });

  test("skips with a single line when SENTINAL_NO_AUTO_SETUP=1", async () => {
    process.env[ENV_KEY] = "1";
    let ran = 0;
    await runAutoSetup("install", async () => {
      ran++;
      return { ok: true, report: "should-not-appear" };
    });

    expect(ran).toBe(0);
    const all = [...logs, ...errs];
    const skipLines = all.filter((l) => l.includes("SENTINAL_NO_AUTO_SETUP"));
    expect(skipLines).toHaveLength(1);
    expect(all.join("\n")).not.toContain("should-not-appear");
  });

  test("does not skip when SENTINAL_NO_AUTO_SETUP is unset", async () => {
    let ran = 0;
    await runAutoSetup("update", async () => {
      ran++;
      return { ok: true, report: "ok" };
    });
    expect(ran).toBe(1);
  });

  test("failed setup is non-fatal and prints report + manual hint", async () => {
    await runAutoSetup("update", async () => ({
      ok: false,
      report: "FAIL-REPORT-99",
    }));

    expect(logs.join("\n")).toContain("FAIL-REPORT-99");
    expect([...logs, ...errs].join("\n")).toContain(
      "Run 'sentinal memory setup' manually",
    );
  });

  test("a throwing setup runner is non-fatal", async () => {
    // Must NOT reject — installs never fail because of semantic search
    await runAutoSetup("update", async () => {
      throw new Error("kaboom-setup");
    });

    expect(errs.join("\n")).toContain("kaboom-setup");
    expect(errs.join("\n")).toContain("Run 'sentinal memory setup' manually");
  });
});
