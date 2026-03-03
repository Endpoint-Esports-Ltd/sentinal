import { describe, expect, it } from "bun:test";
import { findGitRoot, isInsideGitRepo } from "./git";

describe("git utilities", () => {
  describe("findGitRoot", () => {
    it("should find git root from project directory", async () => {
      const root = await findGitRoot("/home/adam/dev/sentinal");
      expect(root).toBe("/home/adam/dev/sentinal");
    });

    it("should return null for non-git directory", async () => {
      const root = await findGitRoot("/tmp");
      expect(root).toBeNull();
    });
  });

  describe("isInsideGitRepo", () => {
    it("should return true inside a git repo", async () => {
      expect(await isInsideGitRepo("/home/adam/dev/sentinal")).toBe(true);
    });

    it("should return false outside a git repo", async () => {
      expect(await isInsideGitRepo("/tmp")).toBe(false);
    });
  });
});
