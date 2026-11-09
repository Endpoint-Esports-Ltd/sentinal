import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  findMasterWorkspace,
  resolveForeignChild,
  resolveSeedRepo,
} from "./master-audit-foreign.js";
import { parsePlanFile } from "./parser.js";

const MASTER = "2026-11-05-ops";
const CHILD = `${MASTER}-phase-1`;

let root: string;
let masterRepo: string;
let apiRepo: string;

function plan(file: string, headers: string): string {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `# Plan\n\n${headers}\n\n## Summary\n`);
  return file;
}

function seed(headers: string): string {
  return plan(
    join(masterRepo, "docs", "plans", `${CHILD}.md`),
    `${headers.includes("Status:") ? "" : "Status: PENDING\n"}Type: Feature\nParent: ${MASTER}\n${headers}`,
  );
}

function resolveSeed(file: string) {
  return resolveForeignChild({
    planFile: file,
    spec: parsePlanFile(file),
    masterSlug: MASTER,
    masterWorkspace: masterRepo,
  });
}

beforeEach(() => {
  root = makeTmpDir();
  masterRepo = join(root, "ops");
  apiRepo = join(root, "api");
  mkdirSync(join(masterRepo, ".git"), { recursive: true });
  mkdirSync(join(apiRepo, ".git"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveSeedRepo", () => {
  it("should resolve an absolute Repo, a relative Repo and a related.json name", () => {
    expect(resolveSeedRepo(apiRepo, masterRepo)).toBe(apiRepo);
    expect(resolveSeedRepo("../api", masterRepo)).toBe(apiRepo);
    mkdirSync(join(masterRepo, ".sentinal"), { recursive: true });
    writeFileSync(
      join(masterRepo, ".sentinal", "related.json"),
      JSON.stringify({ projects: [{ name: "backend", path: "../api" }] }),
    );
    expect(resolveSeedRepo("backend", masterRepo)).toContain("api");
  });

  // Regression (2026-11-09): from a linked worktree nested in the master repo
  // (`.orca/worktrees/x`), a relative Repo is still relative to the main checkout.
  it("should resolve a relative Repo against the main checkout from a nested linked worktree", () => {
    const wt = join(masterRepo, ".orca", "worktrees", "x");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: elsewhere\n");
    expect(
      resolveSeedRepo("../api", wt, { mainCheckout: () => masterRepo }),
    ).toBe(apiRepo);
  });
});

describe("findMasterWorkspace", () => {
  it("should find the nearest ancestor holding .git", () => {
    expect(findMasterWorkspace(join(masterRepo, "docs", "plans", "x.md"))).toBe(
      masterRepo,
    );
  });
});

describe("resolveForeignChild", () => {
  it("should read the Location status and report the repo when the copy links back", () => {
    plan(
      join(apiRepo, "docs", "plans", `${CHILD}.md`),
      `Status: VERIFIED\nParent: ${MASTER}\nMaster: docs/plans/${MASTER}.md`,
    );
    const r = resolveSeed(
      seed(
        `Status: VERIFIED\nRepo: ${apiRepo}\nLocation: docs/plans/${CHILD}.md`,
      ),
    );
    expect(r.status).toBe("VERIFIED");
    expect(r.repo).toBe(apiRepo);
    expect(r.location).toBe(join(apiRepo, "docs", "plans", `${CHILD}.md`));
    expect(r.findings).toEqual([]);
  });

  it("should accept an absolute Location inside a worktree", () => {
    const wt = join(root, "wt");
    const copy = plan(
      join(wt, "docs", "plans", `${CHILD}.md`),
      `Status: IN_PROGRESS\nParent: ${MASTER}`,
    );
    const r = resolveSeed(
      seed(`Status: IN_PROGRESS\nRepo: ../api\nLocation: ${copy}`),
    );
    expect(r.status).toBe("IN_PROGRESS");
    expect(r.location).toBe(copy);
    expect(r.findings).toEqual([]);
  });

  it("should fail a VERIFIED seed without Location (foreign-location-missing)", () => {
    const r = resolveSeed(seed(`Status: VERIFIED\nRepo: ${apiRepo}`));
    expect(r.findings.map((f) => f.kind)).toEqual(["foreign-location-missing"]);
  });

  it("should use the seed status, with no finding, for a seed not started", () => {
    const r = resolveSeed(seed(`Repo: ${apiRepo}`));
    expect(r.status).toBe("PENDING");
    expect(r.findings).toEqual([]);
  });

  it("should report foreign-location-missing when the Location file does not exist", () => {
    const r = resolveSeed(
      seed(`Status: VERIFIED\nRepo: ../api\nLocation: docs/plans/nope.md`),
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["foreign-location-missing"]);
  });

  it("should name the missing repo directory when Repo: does not exist", () => {
    const r = resolveSeed(
      seed(`Status: VERIFIED\nRepo: ../nope\nLocation: docs/plans/${CHILD}.md`),
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["foreign-location-missing"]);
    expect(r.findings[0].message).toContain("does not exist");
    expect(r.findings[0].message).toContain(join(root, "nope"));
  });

  it("should report foreign-link-mismatch when the copy's Parent differs", () => {
    plan(
      join(apiRepo, "docs", "plans", `${CHILD}.md`),
      "Status: VERIFIED\nParent: some-other-master",
    );
    const r = resolveSeed(
      seed(`Status: VERIFIED\nRepo: ../api\nLocation: docs/plans/${CHILD}.md`),
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["foreign-link-mismatch"]);
  });

  it("should report foreign-status-disagrees when seed and copy differ", () => {
    plan(
      join(apiRepo, "docs", "plans", `${CHILD}.md`),
      `Status: VERIFIED\nParent: ${MASTER}`,
    );
    const r = resolveSeed(
      seed(
        `Status: IN_PROGRESS\nRepo: ../api\nLocation: docs/plans/${CHILD}.md`,
      ),
    );
    expect(r.status).toBe("VERIFIED");
    expect(r.findings.map((f) => f.kind)).toEqual(["foreign-status-disagrees"]);
  });

  it("should keep a CANCELLED seed CANCELLED with no finding", () => {
    plan(
      join(apiRepo, "docs", "plans", `${CHILD}.md`),
      `Status: IN_PROGRESS\nParent: ${MASTER}`,
    );
    const r = resolveSeed(
      seed(`Status: CANCELLED\nRepo: ../api\nLocation: docs/plans/${CHILD}.md`),
    );
    expect(r.status).toBe("CANCELLED");
    expect(r.findings).toEqual([]);
  });

  it("should resolve a relative Location against a related.json Repo name", () => {
    mkdirSync(join(masterRepo, ".sentinal"), { recursive: true });
    writeFileSync(
      join(masterRepo, ".sentinal", "related.json"),
      JSON.stringify({ projects: [{ name: "backend", path: "../api" }] }),
    );
    plan(
      join(apiRepo, "docs", "plans", `${CHILD}.md`),
      `Status: VERIFIED\nParent: ${MASTER}`,
    );
    const r = resolveSeed(
      seed(`Status: VERIFIED\nRepo: backend\nLocation: docs/plans/${CHILD}.md`),
    );
    expect(r.status).toBe("VERIFIED");
    expect(r.findings).toEqual([]);
  });
});
