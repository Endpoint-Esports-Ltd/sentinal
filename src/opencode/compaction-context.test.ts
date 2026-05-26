import { describe, it, expect } from "bun:test";
import { buildCompactionContext } from "./compaction-context.js";

describe("buildCompactionContext", () => {
  it("should return both spec and memory when budget is large enough", () => {
    // budget=10000 → sentinal budget = floor(10000*0.3) = 3000 tokens
    // spec="spec content" = 12 chars → ceil(12/4) = 3 tokens → fits
    // memory="mem content" = 11 chars → ceil(11/4) = 3 tokens → fits
    const result = buildCompactionContext({
      specContext: "spec content",
      memoryContext: "mem content",
      reservedTokens: 10000,
    });
    expect(result).toContain("spec content");
    expect(result).toContain("mem content");
    expect(result.length).toBe(2);
  });

  it("should truncate spec and drop memory when budget is very small", () => {
    // budget=10 → sentinal budget = floor(10*0.3) = 3 tokens = 12 chars
    // spec="A".repeat(200) = 200 chars → 50 tokens → too big → truncate to 3*4=12 chars
    // memory="mem" = 3 chars → 1 token → no budget left after spec → dropped
    const result = buildCompactionContext({
      specContext: "A".repeat(200),
      memoryContext: "mem",
      reservedTokens: 10,
    });
    expect(result.length).toBe(1);
    expect(result[0]).toBe("A".repeat(12));
  });

  it("should return empty array when reservedTokens is 0", () => {
    const result = buildCompactionContext({
      specContext: "spec content",
      memoryContext: "mem content",
      reservedTokens: 0,
    });
    expect(result).toEqual([]);
  });

  it("should include only spec when memory is too large", () => {
    // budget=50 → sentinal budget = floor(50*0.3) = 15 tokens = 60 chars
    // spec="S".repeat(40) = 40 chars → ceil(40/4) = 10 tokens → fits in 15
    // memory="M".repeat(400) = 400 chars → ceil(400/4) = 100 tokens → remaining = 5 tokens, 100 > 5 → dropped
    const result = buildCompactionContext({
      specContext: "S".repeat(40),
      memoryContext: "M".repeat(400),
      reservedTokens: 50,
    });
    expect(result.length).toBe(1);
    expect(result[0]).toBe("S".repeat(40));
  });

  it("should handle null specContext", () => {
    const result = buildCompactionContext({
      specContext: null,
      memoryContext: "mem content",
      reservedTokens: 10000,
    });
    expect(result).toContain("mem content");
    expect(result.length).toBe(1);
  });

  it("should handle null memoryContext", () => {
    const result = buildCompactionContext({
      specContext: "spec content",
      memoryContext: null,
      reservedTokens: 10000,
    });
    expect(result).toContain("spec content");
    expect(result.length).toBe(1);
  });

  it("should return empty array when both contexts are null", () => {
    const result = buildCompactionContext({
      specContext: null,
      memoryContext: null,
      reservedTokens: 10000,
    });
    expect(result).toEqual([]);
  });
});
