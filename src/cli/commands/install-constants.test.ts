/**
 * Install Constants Tests — AGENTS.md template path regression guards
 *
 * The AGENTS_MD_LOCAL_TEMPLATE and AGENTS_MD_APPEND constants are injected into
 * user project AGENTS.md files at install time. They must reference `.sentinal/rules/`
 * (the canonical location), never `.opencode/rules/` (a legacy path that only existed
 * before the .sentinal/ unification).
 */

import { describe, it, expect } from "bun:test";
import {
  AGENTS_MD_LOCAL_TEMPLATE,
  AGENTS_MD_APPEND,
} from "./install-constants.js";

describe("AGENTS_MD_LOCAL_TEMPLATE", () => {
  it("does not reference .opencode/rules/", () => {
    expect(AGENTS_MD_LOCAL_TEMPLATE).not.toContain(".opencode/rules/");
  });

  it("references .sentinal/rules/ instead", () => {
    expect(AGENTS_MD_LOCAL_TEMPLATE).toContain(".sentinal/rules/");
  });
});

describe("AGENTS_MD_APPEND", () => {
  it("does not reference .opencode/rules/", () => {
    expect(AGENTS_MD_APPEND).not.toContain(".opencode/rules/");
  });

  it("references .sentinal/rules/ instead", () => {
    expect(AGENTS_MD_APPEND).toContain(".sentinal/rules/");
  });
});
