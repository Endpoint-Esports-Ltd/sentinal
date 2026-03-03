import { describe, expect, it } from "bun:test";
import { processToolRedirect } from "./tool-redirect";

describe("tool-redirect hook", () => {
  it("should deny WebSearch", () => {
    const result = processToolRedirect("WebSearch", {});
    expect(result).not.toBeNull();
    expect((result as any).permissionDecision).toBe("deny");
  });
  it("should deny WebFetch", () => {
    const result = processToolRedirect("WebFetch", {});
    expect(result).not.toBeNull();
    expect((result as any).permissionDecision).toBe("deny");
  });
  it("should deny EnterPlanMode", () => {
    const result = processToolRedirect("EnterPlanMode", {});
    expect(result).not.toBeNull();
    expect((result as any).permissionDecision).toBe("deny");
  });
  it("should deny ExitPlanMode", () => {
    const result = processToolRedirect("ExitPlanMode", {});
    expect(result).not.toBeNull();
    expect((result as any).permissionDecision).toBe("deny");
  });
  it("should return null for allowed tools", () => {
    expect(processToolRedirect("Read", {})).toBeNull();
  });
  it("should hint about Vexor for vague Grep", () => {
    const result = processToolRedirect("Grep", { pattern: "how authentication works" });
    expect(result).not.toBeNull();
  });
  it("should not hint for specific Grep", () => {
    expect(processToolRedirect("Grep", { pattern: "class UserService" })).toBeNull();
  });
});
