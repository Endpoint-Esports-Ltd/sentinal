import { describe, it, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MISSING_PROJECT_PATH,
  normalizeProjectFilter,
  normalizeProjectKey,
} from "./project-key.js";
import { resolveProjectIdentity } from "../project/identity.js";

describe("normalizeProjectKey (write variant)", () => {
  it("returns null for non-string, empty and whitespace-only values", () => {
    for (const raw of [undefined, null, 42, {}, "", "   ", "\t\n"]) {
      expect(normalizeProjectKey(raw)).toBeNull();
    }
  });

  it("never substitutes the sidecar's own cwd for a blank value", () => {
    expect(normalizeProjectKey("")).not.toBe(process.cwd());
  });

  it("canonicalizes a supplied path via resolveProjectIdentity", () => {
    const dir = mkdtempSync(join(tmpdir(), "project-key-"));
    try {
      const expected = resolveProjectIdentity(dir);
      expect(normalizeProjectKey(dir)).toBe(expected);
      // macOS tmpdir is a symlink — the key must be the realpath.
      expect(normalizeProjectKey(dir)).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a stable key for a non-existent path", () => {
    expect(normalizeProjectKey("/test/project")).toBe("/test/project");
  });
});

describe("normalizeProjectFilter (read variant)", () => {
  it("returns undefined for absent, non-string and blank values (= all projects)", () => {
    for (const raw of [undefined, null, 42, "", "   "]) {
      expect(normalizeProjectFilter(raw)).toBeUndefined();
    }
  });

  it("canonicalizes a supplied path via resolveProjectIdentity", () => {
    const dir = mkdtempSync(join(tmpdir(), "project-filter-"));
    try {
      expect(normalizeProjectFilter(dir)).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MISSING_PROJECT_PATH", () => {
  it("keeps the exact 400 message the routes have always returned", () => {
    expect(MISSING_PROJECT_PATH).toBe(
      "Missing or empty 'projectPath' — the sidecar cannot infer it from its own " +
        "cwd, and refuses to store an empty project key",
    );
  });
});

// ─── Task 10: memoized canonicalization + D4 inference ───────────────────────

import * as identityModule from "../project/identity.js";
import { afterEach, spyOn } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { canonicalProjectKey, inferProjectFromFile } from "./project-key.js";

function gitFixture(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const r = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  if (r.exitCode !== 0) throw new Error("git init failed");
  return root;
}

describe("canonicalProjectKey (store-side canonicalization)", () => {
  afterEach(() => {
    (identityModule.resolveProjectIdentity as any).mockRestore?.();
  });

  it("leaves a blank value untouched — never the process cwd", () => {
    expect(canonicalProjectKey("")).toBe("");
    expect(canonicalProjectKey("   ")).toBe("   ");
  });

  it("keeps a non-existent synthetic key stable", () => {
    expect(canonicalProjectKey("/test/project")).toBe("/test/project");
  });

  it("maps a symlinked subdirectory of a repo to the repo's canonical root", () => {
    const root = gitFixture("pk-canon-");
    const alias = realpathSync(mkdtempSync(join(tmpdir(), "pk-alias-")));
    try {
      mkdirSync(join(root, "src"));
      symlinkSync(root, join(alias, "link"));
      expect(canonicalProjectKey(join(alias, "link", "src"))).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(alias, { recursive: true, force: true });
    }
  }, 30_000);

  it("memoizes: a repeat and its own canonical output spawn no further resolution", () => {
    const root = gitFixture("pk-memo-");
    try {
      const spy = spyOn(identityModule, "resolveProjectIdentity");
      const first = canonicalProjectKey(join(root, "."));
      const calls = spy.mock.calls.length;
      expect(calls).toBe(1);
      expect(canonicalProjectKey(join(root, "."))).toBe(first);
      expect(canonicalProjectKey(first)).toBe(first);
      expect(spy.mock.calls.length).toBe(calls);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("inferProjectFromFile (D4)", () => {
  it("returns null for a relative or blank file path", () => {
    expect(inferProjectFromFile("src/foo.ts")).toBeNull();
    expect(inferProjectFromFile("")).toBeNull();
    expect(inferProjectFromFile(undefined)).toBeNull();
  });

  it("resolves the identity of the nearest EXISTING ancestor of the file's directory", () => {
    const root = gitFixture("pk-infer-");
    try {
      // `src/deep/` does not exist yet — the walk must climb to the repo root.
      expect(inferProjectFromFile(join(root, "src", "deep", "x.ts"))).toBe(
        root,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
