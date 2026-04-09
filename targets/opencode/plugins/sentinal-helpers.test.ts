/**
 * Sentinal Plugin Helpers Tests
 */

import { describe, it, expect } from "bun:test";
import {
  getGrepHint,
  getFetchHint,
  transitionTddState,
  resolveProjectRoot,
} from "./sentinal-helpers.js";

describe("getGrepHint", () => {
  it("should return hint for vague grep patterns", () => {
    expect(getGrepHint("how to use React")).not.toBeNull();
    expect(getGrepHint("what is the config")).not.toBeNull();
    expect(getGrepHint("find things that work")).not.toBeNull();
  });

  it("should return null for specific patterns", () => {
    expect(getGrepHint("useState")).toBeNull();
    expect(getGrepHint("class AppComponent")).toBeNull();
  });
});

describe("getFetchHint", () => {
  it("should return a hint string", () => {
    expect(getFetchHint()).toContain("web-fetch");
  });
});

describe("transitionTddState", () => {
  it("should call sidecar tddTransition with correct action", async () => {
    let calledWith: { action: string; specId?: string } | null = null;
    const mockSidecar = {
      tddTransition: async (
        action: "confirm_red" | "confirm_green",
        specId?: string,
      ) => {
        calledWith = { action, specId };
        return { count: 2 };
      },
    };

    await transitionTddState(mockSidecar, "confirm_red", "spec-1");

    expect(calledWith).not.toBeNull();
    expect(calledWith!.action).toBe("confirm_red");
    expect(calledWith!.specId).toBe("spec-1");
  });

  it("should not throw on sidecar error", async () => {
    const failingSidecar = {
      tddTransition: async () => {
        throw new Error("connection failed");
      },
    };

    // Should not throw
    await transitionTddState(failingSidecar, "confirm_green");
  });
});

// ─── resolveProjectRoot ───────────────────────────────────────────────────────

describe("resolveProjectRoot", () => {
  // Helpers for building injected fs fakes
  const makeOpts = (opts: {
    existing?: string[];
    writable?: string[];
    cwd?: string;
  }) => ({
    cwd: () => opts.cwd ?? "/default-cwd",
    exists: (p: string) => (opts.existing ?? []).includes(p),
    isWritable: (p: string) => (opts.writable ?? []).includes(p),
  });

  it("should return worktree when it exists and is writable", () => {
    const result = resolveProjectRoot("/repo", "/repo", makeOpts({
      existing: ["/repo"],
      writable: ["/repo"],
    }));
    expect(result).toEqual({ root: "/repo" });
  });

  it("should return null when all candidates resolve to filesystem root", () => {
    const result = resolveProjectRoot("/", "/", makeOpts({
      cwd: "/",
      existing: ["/"],
      writable: ["/"],
    }));
    expect(result.root).toBeNull();
    expect(result.reason).toMatch(/No writable project root found/);
  });

  it("should fall through to directory when worktree is filesystem root", () => {
    const result = resolveProjectRoot("/", "/home/user/myproj", makeOpts({
      existing: ["/", "/home/user/myproj"],
      writable: ["/", "/home/user/myproj"],
    }));
    expect(result).toEqual({ root: "/home/user/myproj" });
  });

  it("should fall through to cwd when worktree and directory are empty", () => {
    const result = resolveProjectRoot("", "", makeOpts({
      cwd: "/home/user",
      existing: ["/home/user"],
      writable: ["/home/user"],
    }));
    expect(result).toEqual({ root: "/home/user" });
  });

  it("should return null when worktree, directory, and cwd are all empty", () => {
    const result = resolveProjectRoot(undefined, undefined, makeOpts({
      cwd: "",
    }));
    expect(result.root).toBeNull();
    expect(result.reason).toMatch(/No project root candidates provided/);
  });

  it("should fall through to directory when worktree exists but is not writable", () => {
    const result = resolveProjectRoot("/readonly-path", "/writable-dir", makeOpts({
      existing: ["/readonly-path", "/writable-dir"],
      writable: ["/writable-dir"],
    }));
    expect(result).toEqual({ root: "/writable-dir" });
  });

  it("should fall through to directory when worktree does not exist", () => {
    const result = resolveProjectRoot("/no-exist", "/writable-dir", makeOpts({
      existing: ["/writable-dir"],
      writable: ["/writable-dir"],
    }));
    expect(result).toEqual({ root: "/writable-dir" });
  });

  it("should reject Windows drive root and fall through to directory", () => {
    const result = resolveProjectRoot("C:\\", "C:\\Users\\me\\proj", makeOpts({
      existing: ["C:\\", "C:\\Users\\me\\proj"],
      writable: ["C:\\", "C:\\Users\\me\\proj"],
    }));
    expect(result).toEqual({ root: "C:\\Users\\me\\proj" });
  });

  it("should deduplicate identical candidates", () => {
    // Both worktree and directory are same value — should only try once
    const callLog: string[] = [];
    const result = resolveProjectRoot("/repo", "/repo", {
      cwd: () => "/repo",
      exists: (p) => { callLog.push(`exists:${p}`); return true; },
      isWritable: (p) => { callLog.push(`writable:${p}`); return true; },
    });
    expect(result).toEqual({ root: "/repo" });
    // /repo should appear only once in exists/writable calls (deduplicated)
    expect(callLog.filter(c => c === "exists:/repo").length).toBe(1);
  });

  it("should return null with reason listing tried paths when all fail", () => {
    const result = resolveProjectRoot("/a", "/b", makeOpts({
      cwd: "/c",
      existing: ["/a", "/b", "/c"],
      writable: [], // nothing writable
    }));
    expect(result.root).toBeNull();
    expect(result.reason).toContain("/a");
    expect(result.reason).toContain("/b");
    expect(result.reason).toContain("/c");
  });
});
