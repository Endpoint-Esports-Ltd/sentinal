---
description: Feature planning phase - explore codebase, design plan, get approval
model: anthropic/claude-sonnet-4-20250514
user-invocable: false
argument-hint: "<task description>" or "<path/to/existing-plan.md>"
---

# Feature Planning Phase

**You are the spec-plan skill. Your job: explore the codebase, understand the problem, write a detailed plan, and get user approval.**

ARGUMENTS: $ARGUMENTS

## Phase 1: Understand the Task

1. Parse ARGUMENTS — is it a task description or a path to an existing plan?
2. If existing plan: read it, understand current state, continue from where it left off
3. If new task: explore the codebase to understand the relevant architecture

## Phase 2: Codebase Exploration

Use Vexor (preferred), Grep, Glob, and Read to understand:

- **Angular structure:** What modules exist? What's the routing structure? Key components?
- **NestJS structure:** What modules, controllers, services exist? Database entities?
- **Existing patterns:** How are similar features implemented? What conventions are used?
- **Dependencies:** What libraries are already in use? What tools are available?

## Phase 3: Write the Plan

Create plan file at `docs/plans/YYYY-MM-DD-<slug>.md`:

```markdown
# [Feature Name] Implementation Plan

**Status:** PENDING
**Type:** Feature
**Approved:** No
**Worktree:** [Yes/No — from dispatcher]
**Date:** YYYY-MM-DD

## Goal
[One clear sentence]

## Scope
- **In scope:** [bulleted list]
- **Out of scope:** [bulleted list]

## Architecture
[2-3 paragraphs explaining the approach, which modules/components to create/modify]

## Tasks

Done: 0 | Left: N

### Task 1: [Name]
- [ ] Description of what to build/change
- **Files:** create/modify/test file paths
- **DoD:** Definition of Done for this task

### Task 2: ...

## Risks
[Known risks and mitigations]

## Goal Verification
[How to verify the feature works end-to-end after all tasks complete]
```

## Phase 4: Plan Review (Optional)

If the plan has more than 3 tasks: launch the `plan-reviewer` sub-agent in background.

## Phase 5: User Approval

Present the plan summary and ask for approval. This is the ONLY user interaction point in planning.

After approval: update plan header to `Approved: Yes`, then invoke Skill(skill='spec-implement', args='<plan-path>').
