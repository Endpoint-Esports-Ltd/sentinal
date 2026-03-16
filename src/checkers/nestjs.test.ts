import { describe, expect, it } from "bun:test";
import { isNestFile, checkNestPatterns } from "./nestjs";

describe("nestjs checker", () => {
  describe("isNestFile", () => {
    it("should detect controller files", () => {
      expect(isNestFile("user.controller.ts")).toBe(true);
    });
    it("should detect service files", () => {
      expect(isNestFile("user.service.ts")).toBe(true);
    });
    it("should detect module files", () => {
      expect(isNestFile("user.module.ts")).toBe(true);
    });
    it("should detect guard files", () => {
      expect(isNestFile("auth.guard.ts")).toBe(true);
    });
    it("should detect interceptor files", () => {
      expect(isNestFile("logging.interceptor.ts")).toBe(true);
    });
    it("should detect DTO files", () => {
      expect(isNestFile("create-user.dto.ts")).toBe(true);
    });
    it("should not detect plain files", () => {
      expect(isNestFile("helpers.ts")).toBe(false);
    });
  });

  describe("checkNestPatterns", () => {
    it("should warn about missing @ApiTags on controllers", () => {
      const content = `@Controller('users')\nexport class UsersController {}`;
      const results = checkNestPatterns("user.controller.ts", content);
      expect(results.some((r) => r.message.includes("@ApiTags"))).toBe(true);
    });

    it("should warn about missing class-validator on DTOs", () => {
      const content = `export class CreateUserDto { name: string; }`;
      const results = checkNestPatterns("create-user.dto.ts", content);
      expect(results.some((r) => r.message.includes("class-validator"))).toBe(
        true,
      );
    });

    it("should not warn for decorated DTOs", () => {
      const content = `import { IsString } from 'class-validator';\nexport class CreateUserDto { @IsString() name: string; }`;
      const results = checkNestPatterns("create-user.dto.ts", content);
      expect(
        results.filter((r) => r.message.includes("class-validator")),
      ).toEqual([]);
    });
  });
});
