import { describe, expect, it } from "bun:test";
import { mergeRoundRobin, searchRelated } from "./related-search.js";

describe("mergeRoundRobin", () => {
  it("should interleave ranked lists, dedupe by id and truncate", () => {
    const lists = [
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 2 }, { id: 4 }],
      [],
    ];
    expect(mergeRoundRobin(lists, 10).map((r) => r.id)).toEqual([1, 2, 4, 3]);
    expect(mergeRoundRobin(lists, 2).map((r) => r.id)).toEqual([1, 2]);
    expect(mergeRoundRobin([], 5)).toEqual([]);
  });
});

describe("searchRelated", () => {
  it("should search the base and each existing related project, labelling results", async () => {
    const seen: string[] = [];
    const out = await searchRelated({
      base: "/w/a",
      limit: 5,
      identityOf: () => "/main/a",
      workspaceOf: () => "/w/a",
      loadRelated: () => ({
        projects: [
          {
            name: "b",
            path: "/b",
            identity: "/b",
            exists: true,
            hasRules: false,
          },
          {
            name: "gone",
            path: "/g",
            identity: "/g",
            exists: false,
            hasRules: false,
          },
        ],
        warnings: ["w1"],
      }),
      search: async (project) => {
        seen.push(project);
        return [{ id: project === "/b" ? 2 : 1 }];
      },
    });
    expect(seen).toEqual(["/main/a", "/b"]);
    expect(out.results).toEqual([
      { id: 1, project: "a" },
      { id: 2, project: "b" },
    ]);
    expect(out.warnings).toEqual(["w1"]);
  });

  it("should survive a failing per-project search", async () => {
    const out = await searchRelated({
      base: "/a",
      limit: 5,
      identityOf: (p) => p,
      workspaceOf: (p) => p,
      loadRelated: () => ({
        projects: [
          {
            name: "b",
            path: "/b",
            identity: "/b",
            exists: true,
            hasRules: false,
          },
        ],
        warnings: [],
      }),
      search: async (project) => {
        if (project === "/b") throw new Error("boom");
        return [{ id: 1 }];
      },
    });
    expect(out.results.map((r) => r.id)).toEqual([1]);
    expect(out.warnings[0]).toContain("boom");
  });
});
