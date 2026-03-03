import { describe, expect, it } from "bun:test";
import { isAngularFile, runAngularChecks } from "./angular";

describe("angular checker", () => {
  describe("isAngularFile", () => {
    it("should detect component files", () => {
      expect(isAngularFile("user.component.ts")).toBe(true);
    });
    it("should detect directive files", () => {
      expect(isAngularFile("highlight.directive.ts")).toBe(true);
    });
    it("should detect pipe files", () => {
      expect(isAngularFile("date-format.pipe.ts")).toBe(true);
    });
    it("should detect module files", () => {
      expect(isAngularFile("app.module.ts")).toBe(true);
    });
    it("should not detect service files", () => {
      expect(isAngularFile("user.service.ts")).toBe(false);
    });
  });
});
