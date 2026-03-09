import { describe, expect, it } from "bun:test";
import { getContextWarning } from "./context-monitor";

describe("context-monitor", () => {
  it("should return null below 80%", () => { expect(getContextWarning(70)).toBeNull(); });
  it("should return null at exactly 79%", () => { expect(getContextWarning(79)).toBeNull(); });
  it("should warn at 80%", () => { const r = getContextWarning(80); expect(r).not.toBeNull(); expect(r).toContain("80%"); });
  it("should strongly warn at 90%", () => { const r = getContextWarning(90); expect(r).not.toBeNull(); expect(r).toContain("90%"); });
  it("should urge completion at 95%+", () => { const r = getContextWarning(95); expect(r).not.toBeNull(); expect(r!.toLowerCase()).toContain("complete"); });
  it("should urge completion at 100%", () => { const r = getContextWarning(100); expect(r).not.toBeNull(); expect(r).toContain("100%"); });
});
