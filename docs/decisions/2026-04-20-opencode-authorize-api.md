# Decision: Defer OpenCode Plugin `authorize` API (OC-3)

**Date:** 2026-04-20
**Status:** Deferred
**Decided by:** Phase 3 plan-reviewer + planning session

---

## What is the `authorize` API?

OpenCode's plugin system exposes an `authorize` hook that allows plugins to approve or deny operations before they execute. Plugins can inspect the operation context and return a structured decision:

```typescript
// Hypothetical authorize usage
"authorize": async (input) => {
  if (input.operation === "memory.upload" && !userHasCloudPermission()) {
    return { allow: false, reason: "Cloud sync not configured" };
  }
  return { allow: true };
}
```

This provides a first-class plugin-level permission layer, distinct from the existing tool-blocking approach (which blocks specific tool calls, not higher-level operations).

---

## Why We're Deferring

**The `authorize` API is most valuable for gating cloud operations.** The primary use case Sentinal would have is gating cloud uploads/downloads of memory observations — allowing users to approve before their observations leave the local machine.

**Sentinal's memory system is currently local-only.** All observations are stored in SQLite at `~/.sentinal/sentinal.db`. There is no cloud sync feature, no remote memory endpoint, and no plans to add one in the near term. Without cloud operations to gate, `authorize` provides no meaningful value.

The existing MCP-based permission model (`opencode.json` permission rules) handles all current Sentinal operation types adequately.

---

## When to Revisit

Re-evaluate this decision **if and when**:

1. Cloud sync for Sentinal memory observations is prioritized (e.g., team-shared memory, cross-machine observation sharing)
2. Sentinal adds any operation that benefits from user confirmation at the plugin level (e.g., bulk memory deletion, project-wide TDD state resets)
3. The `authorize` API surface stabilizes and is documented as non-experimental

**Trigger to act:** Any issue or feature request involving "approve before sync" or "confirm before bulk operation" patterns.

---

## Current Alternative

The current approach for operation safety:
- **Tool-level blocking:** `tool.execute.before` handler can `throw new Error(reason)` to block tool calls
- **Permission rules:** `opencode.json` `permission:` section restricts which tools/files are accessible
- **MCP tool descriptions:** Destructive MCP tools are clearly labeled in their descriptions

These mechanisms cover all current Sentinal use cases.
