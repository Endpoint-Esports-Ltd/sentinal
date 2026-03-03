import { describe, expect, it } from "bun:test";
import { checkFileLength } from "./file-length";

describe("checkFileLength", () => {
  it("should return null for files under 400 lines", () => {
    const result = checkFileLength("/src/app.ts", 200);
    expect(result).toBeNull();
  });

  it("should return warn for files between 400-599 lines", () => {
    const result = checkFileLength("/src/app.ts", 450);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warn");
    expect(result!.message).toContain("450 lines");
  });

  it("should return block for files at or above 600 lines", () => {
    const result = checkFileLength("/src/app.ts", 600);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("block");
    expect(result!.message).toContain("600 lines");
  });

  it("should exempt .spec.ts test files from blocking", () => {
    const result = checkFileLength("/src/app.spec.ts", 700);
    expect(result).toBeNull();
  });

  it("should exempt .test.ts files from blocking", () => {
    const result = checkFileLength("/src/app.test.ts", 700);
    expect(result).toBeNull();
  });

  it("should exempt e2e test files from blocking", () => {
    const result = checkFileLength("/e2e/app.e2e-spec.ts", 700);
    expect(result).toBeNull();
  });
});
