import { describe, expect, it } from "bun:test";
import { getExpectedTestPaths, isTrivialEdit, isTestFile } from "./tdd";

describe("tdd utilities", () => {
  describe("getExpectedTestPaths", () => {
    it("should generate .spec.ts path for a .ts file", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.ts");
      expect(paths).toContain("/src/app/user.service.spec.ts");
    });

    it("should generate .test.ts path for a .ts file", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.ts");
      expect(paths).toContain("/src/app/user.service.test.ts");
    });

    it("should return empty for test files themselves", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.spec.ts");
      expect(paths).toEqual([]);
    });

    it("should return empty for non-TypeScript files", () => {
      const paths = getExpectedTestPaths("/src/index.html");
      expect(paths).toEqual([]);
    });

    it("should return empty for module files", () => {
      const paths = getExpectedTestPaths("/src/app/app.module.ts");
      expect(paths).toEqual([]);
    });

    it("should return empty for DTOs", () => {
      const paths = getExpectedTestPaths("/src/users/create-user.dto.ts");
      expect(paths).toEqual([]);
    });

    it("should return empty for entities", () => {
      const paths = getExpectedTestPaths("/src/users/user.entity.ts");
      expect(paths).toEqual([]);
    });
  });

  describe("isTestFile", () => {
    it("should detect .spec.ts files", () => {
      expect(isTestFile("user.service.spec.ts")).toBe(true);
    });

    it("should detect .test.ts files", () => {
      expect(isTestFile("user.service.test.ts")).toBe(true);
    });

    it("should not detect regular .ts files", () => {
      expect(isTestFile("user.service.ts")).toBe(false);
    });
  });

  describe("isTrivialEdit", () => {
    it("should detect import-only changes", () => {
      expect(isTrivialEdit("import { Foo } from './foo';")).toBe(true);
    });

    it("should not detect function changes as trivial", () => {
      expect(isTrivialEdit("function doSomething() { return 1; }")).toBe(false);
    });
  });
});
