import { describe, it, expect } from "bun:test";
import { parsePlanContent, slugFromFilename } from "./parser.js";

describe("slugFromFilename", () => {
  it("should strip .md extension", () => {
    expect(slugFromFilename("my-plan.md")).toBe("my-plan");
  });

  it("should strip directory path", () => {
    expect(slugFromFilename("/docs/plans/2026-03-09-feature.md")).toBe("2026-03-09-feature");
  });

  it("should handle no extension", () => {
    expect(slugFromFilename("README")).toBe("README");
  });
});

describe("parsePlanContent — new format", () => {
  const newFormatContent = `# market research Feature Parity Implementation Plan

Created: 2026-03-09
Status: IN PROGRESS
Approved: No
Iterations: 1
Worktree: No
Type: Feature

## Summary

Some summary text.

## Progress Tracking

- [~] Task 1: CLI binary scaffold (partial — some done)
- [x] Task 2: Memory system
- [ ] Task 3: Session management
- [x] Task 4: Hook integration

**Total Tasks:** 4 | **Completed:** 2

## Implementation Tasks

### Task 1: CLI Binary Scaffold
`;

  it("should extract title", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/2026-03-09-market research-parity.md");
    expect(spec.title).toBe("market research Feature Parity Implementation Plan");
  });

  it("should extract slug from filename", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/2026-03-09-market research-parity.md");
    expect(spec.id).toBe("2026-03-09-market research-parity");
  });

  it("should extract status", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/test.md");
    expect(spec.status).toBe("IN_PROGRESS");
  });

  it("should extract type", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/test.md");
    expect(spec.type).toBe("feature");
  });

  it("should extract approved", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/test.md");
    expect(spec.approved).toBe(false);
  });

  it("should extract metadata", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/test.md");
    expect(spec.created).toBe("2026-03-09");
    expect(spec.metadata.iterations).toBe(1);
    expect(spec.metadata.worktree).toBeUndefined(); // "No" → undefined (falsy)
  });

  it("should extract tasks from Progress Tracking", () => {
    const spec = parsePlanContent(newFormatContent, "/plans/test.md");
    expect(spec.tasks).toHaveLength(4);
    expect(spec.tasks[0]).toEqual({ position: 1, title: "CLI binary scaffold", status: "in-progress" });
    expect(spec.tasks[1]).toEqual({ position: 2, title: "Memory system", status: "complete" });
    expect(spec.tasks[2]).toEqual({ position: 3, title: "Session management", status: "pending" });
    expect(spec.tasks[3]).toEqual({ position: 4, title: "Hook integration", status: "complete" });
  });
});

describe("parsePlanContent — old format", () => {
  const oldFormatContent = `# Sentinal Design Document

**Date:** 2026-03-03
**Status:** APPROVED

## Overview

Some design overview.
`;

  it("should extract title", () => {
    const spec = parsePlanContent(oldFormatContent, "/plans/2026-03-03-sentinal-design.md");
    expect(spec.title).toBe("Sentinal Design Document");
  });

  it("should extract status from bold format", () => {
    const spec = parsePlanContent(oldFormatContent, "/plans/2026-03-03-sentinal-design.md");
    expect(spec.status).toBe("APPROVED");
  });

  it("should mark APPROVED as approved", () => {
    const spec = parsePlanContent(oldFormatContent, "/plans/2026-03-03-sentinal-design.md");
    expect(spec.approved).toBe(true);
  });

  it("should extract created from Date field", () => {
    const spec = parsePlanContent(oldFormatContent, "/plans/2026-03-03-sentinal-design.md");
    expect(spec.created).toBe("2026-03-03");
  });

  it("should default to feature type when not specified", () => {
    const spec = parsePlanContent(oldFormatContent, "/plans/test.md");
    expect(spec.type).toBe("feature");
  });

  it("should have no tasks when none present", () => {
    const spec = parsePlanContent(oldFormatContent, "/plans/test.md");
    expect(spec.tasks).toEqual([]);
  });
});

describe("parsePlanContent — implementation tasks fallback", () => {
  const implContent = `# Implementation Plan

Status: PENDING
Type: Bugfix

## Implementation Tasks

### Task 1: Fix login bug

**Objective:** Fix the login redirect issue.

**Definition of Done:**
- [x] Login redirects correctly
- [x] Tests pass
- [ ] No regressions

### Task 2: Add error handling

**Objective:** Handle edge cases.

**Definition of Done:**
- [ ] Error boundary added
- [ ] Logging implemented

## Assumptions

Some assumptions.
`;

  it("should extract tasks from Implementation Tasks when no Progress Tracking", () => {
    const spec = parsePlanContent(implContent, "/plans/test.md");
    expect(spec.tasks).toHaveLength(2);
    expect(spec.tasks[0]).toEqual({ position: 1, title: "Fix login bug", status: "in-progress" });
    expect(spec.tasks[1]).toEqual({ position: 2, title: "Add error handling", status: "pending" });
  });

  it("should detect bugfix type", () => {
    const spec = parsePlanContent(implContent, "/plans/test.md");
    expect(spec.type).toBe("bugfix");
  });
});

describe("parsePlanContent — edge cases", () => {
  it("should handle empty content", () => {
    const spec = parsePlanContent("", "/plans/empty.md");
    expect(spec.title).toBe("Untitled");
    expect(spec.status).toBe("PENDING");
    expect(spec.tasks).toEqual([]);
  });

  it("should handle content with no metadata", () => {
    const spec = parsePlanContent("# Just a Title\n\nSome text.", "/plans/test.md");
    expect(spec.title).toBe("Just a Title");
    expect(spec.status).toBe("PENDING");
  });

  it("should handle VERIFIED status", () => {
    const content = "# Done Plan\n\nStatus: VERIFIED\n";
    const spec = parsePlanContent(content, "/plans/test.md");
    expect(spec.status).toBe("VERIFIED");
  });

  it("should handle CANCELLED status", () => {
    const content = "# Cancelled Plan\n\nStatus: CANCELLED\n";
    const spec = parsePlanContent(content, "/plans/test.md");
    expect(spec.status).toBe("CANCELLED");
  });
});
