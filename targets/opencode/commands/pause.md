---
description: Pause current spec workflow with context handoff for cross-session resumption
---

# /pause - Pause Spec Workflow

**Create a handoff file** that preserves complete work state for resumption in a new session. The `/spec` command automatically detects the handoff file and offers to resume.

---

## Process

### Step 1: Read Current State

Use `spec_init` MCP tool to get the active plan state.

If no active plan found: report "No active spec to pause." and stop.

### Step 2: Gather Context

Ask the user for handoff context:

```
AskUserQuestion(
  header: "Pause Context",
  question: "What should the next session know?",
  options: [
    { label: "Just save current position", description: "Auto-generate context from plan state" },
  ]
)
```

If user provides custom text, use it for the Next Action and Context sections.
If "Just save current position", auto-generate from the plan's current task and progress.

### Step 3: Write Handoff File

Write to `.sentinal/continue-here.md`:

```markdown
# Continue Here

Created: [ISO timestamp]
Plan: [plan file path]
Status: [current plan status]
Current Task: Task [N]: [title]
Progress: [X]% ([completed]/[total] tasks)

## Next Action

[What to do next — e.g., "Implement Task 3: Add validation", "Run spec-verify"]

## Context

[Key decisions made, files being modified, patterns being followed]

## Blockers

[Any open questions or blockers, or "None"]
```

### Step 4: WIP Commit

```bash
git add -A && git commit -m "wip: pause at Task [N] of [plan-title]" --no-verify
```

### Step 5: Confirm

Report to user:
```
Paused: [plan title]
  Position: Task [N] of [total]
  Handoff: .sentinal/continue-here.md
  
  To resume: start a new session and run /spec
  The dispatcher will detect the handoff file and offer to resume.
```

ARGUMENTS: $ARGUMENTS
