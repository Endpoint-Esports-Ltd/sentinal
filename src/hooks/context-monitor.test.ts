import { describe, expect, it } from "bun:test";
import { getContextWarning } from "./context-monitor";

describe("context-monitor", () => {
  it("should return null below 65%", () => { expect(getContextWarning(50)).toBeNull(); });
  it("should warn at 65%", () => { const r = getContextWarning(65); expect(r).not.toBeNull(); expect(r).toContain("80%"); });
  it("should strongly warn at 75%", () => { const r = getContextWarning(75); expect(r).not.toBeNull(); expect(r).toContain("90%"); });
  it("should urge completion at 85%+", () => { const r = getContextWarning(85); expect(r).not.toBeNull(); expect(r!.toLowerCase()).toContain("complete"); });
});
