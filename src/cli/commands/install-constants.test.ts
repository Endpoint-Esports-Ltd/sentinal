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
  AGENTS_MD_GLOBAL,
} from "./install-constants.js";

describe("AGENTS_MD_LOCAL_TEMPLATE", () => {
  it("does not reference .opencode/rules/", () => {
    expect(AGENTS_MD_LOCAL_TEMPLATE).not.toContain(".opencode/rules/");
  });

  it("references .sentinal/rules/ instead", () => {
    expect(AGENTS_MD_LOCAL_TEMPLATE).toContain(".sentinal/rules/");
  });
});

describe("AGENTS_MD_GLOBAL", () => {
  // Edit hooks run no formatters and no tsc (src/hooks/file-checker.ts); the
  // global AGENTS.md must not tell agents otherwise.
  it("does not claim formatters or tsc run on every edit", () => {
    expect(AGENTS_MD_GLOBAL).not.toContain("handled automatically");
    expect(AGENTS_MD_GLOBAL).not.toContain(
      "Run tsc --noEmit for type checking",
    );
  });

  it("tells agents to pass `file` to quality_report", () => {
    expect(AGENTS_MD_GLOBAL).toContain("`quality_report` with `file:`");
    expect(AGENTS_MD_GLOBAL).toContain("report-only");
  });

  it("keeps the header uninstall uses to recognise its own file", () => {
    expect(AGENTS_MD_GLOBAL).toContain("Sentinal Global Standards");
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
