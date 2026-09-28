import { describe, expect, it } from "bun:test";
import {
  createOrcaToolState,
  orcaFailure,
  orcaResponse,
} from "./mcp-tools-shared.js";

const jsonOf = (text: string) =>
  JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);

describe("orcaResponse", () => {
  it("renders markdown followed by ONE fenced JSON block of the structured result", () => {
    const r = orcaResponse("Title", ["- a", "- b"], { ok: true, id: "x" });
    const text = r.content[0]!.text;
    expect(text.startsWith("## Title\n")).toBe(true);
    expect(text).toContain("- a\n- b");
    expect(jsonOf(text)).toEqual({ ok: true, id: "x" });
    expect(text.match(/```json/g)!.length).toBe(1);
  });
});

describe("orcaFailure", () => {
  it("carries the code, message and extra fields", () => {
    const r = orcaFailure("Nope", { code: "c", message: "m" }, { run_id: "r" });
    const data = jsonOf(r.content[0]!.text);
    expect(data).toEqual({
      ok: false,
      error: { code: "c", message: "m" },
      run_id: "r",
    });
    expect(r.content[0]!.text).toContain("c: m");
  });
});

describe("createOrcaToolState", () => {
  it("gives each registration its own caches", () => {
    const a = createOrcaToolState();
    const b = createOrcaToolState();
    a.deliveries.set("d", "r");
    expect(b.deliveries.size).toBe(0);
  });
});
