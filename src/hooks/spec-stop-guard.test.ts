import { describe, expect, it } from "bun:test";
import { shouldBlockStop } from "../spec/detect";

describe("spec-stop-guard", () => {
  it("should block PENDING", () => {
    const r = shouldBlockStop("PENDING");
    expect(r).not.toBeNull();
    expect(r).toContain("PENDING");
  });
  it("should block COMPLETE", () => {
    const r = shouldBlockStop("COMPLETE");
    expect(r).not.toBeNull();
    expect(r).toContain("COMPLETE");
  });
  it("should not block VERIFIED", () => {
    expect(shouldBlockStop("VERIFIED")).toBeNull();
  });
  it("should not block null", () => {
    expect(shouldBlockStop(null)).toBeNull();
  });
});
