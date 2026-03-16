/**
 * Sentinal Plugin Helpers Tests
 */

import { describe, it, expect } from "bun:test";
import {
  getGrepHint,
  getFetchHint,
  transitionTddState,
} from "./sentinal-helpers.js";

describe("getGrepHint", () => {
  it("should return hint for vague grep patterns", () => {
    expect(getGrepHint("how to use React")).not.toBeNull();
    expect(getGrepHint("what is the config")).not.toBeNull();
    expect(getGrepHint("find things that work")).not.toBeNull();
  });

  it("should return null for specific patterns", () => {
    expect(getGrepHint("useState")).toBeNull();
    expect(getGrepHint("class AppComponent")).toBeNull();
  });
});

describe("getFetchHint", () => {
  it("should return a hint string", () => {
    expect(getFetchHint()).toContain("web-fetch");
  });
});

describe("transitionTddState", () => {
  it("should call sidecar tddTransition with correct action", async () => {
    let calledWith: { action: string; specId?: string } | null = null;
    const mockSidecar = {
      tddTransition: async (
        action: "confirm_red" | "confirm_green",
        specId?: string,
      ) => {
        calledWith = { action, specId };
        return { count: 2 };
      },
    };

    await transitionTddState(mockSidecar, "confirm_red", "spec-1");

    expect(calledWith).not.toBeNull();
    expect(calledWith!.action).toBe("confirm_red");
    expect(calledWith!.specId).toBe("spec-1");
  });

  it("should not throw on sidecar error", async () => {
    const failingSidecar = {
      tddTransition: async () => {
        throw new Error("connection failed");
      },
    };

    // Should not throw
    await transitionTddState(failingSidecar, "confirm_green");
  });
});
