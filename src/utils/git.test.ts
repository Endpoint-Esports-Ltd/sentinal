import { describe, expect, it } from "bun:test";
import { findGitRoot, isInsideGitRepo } from "./git";

describe("git utilities", () => {
  // Use the actual project directory (which is a git repo) for positive tests
  const projectRoot = process.cwd();

  describe("findGitRoot", () => {
    it("should find git root from project directory", async () => {
      const root = await findGitRoot(projectRoot);
      expect(root).toBe(projectRoot);
    });

    it("should return null for non-git directory", async () => {
      const root = await findGitRoot("/tmp");
      expect(root).toBeNull();
    });
  });

  describe("isInsideGitRepo", () => {
    it("should return true inside a git repo", async () => {
      expect(await isInsideGitRepo(projectRoot)).toBe(true);
    });

    it("should return false outside a git repo", async () => {
      expect(await isInsideGitRepo("/tmp")).toBe(false);
    });
  });
});
