# Bug Report: Sentinal MCP — intermittent connectivity failures with unhelpful error message

**Date:** 2026-06-09
**Reporter:** (session via opencode)
**Component:** Sentinal MCP server (spec workflow + worktree tools)
**Severity:** Medium (workflow-blocking when it occurs, but transient; safe manual fallbacks exist)
**Affected tools:** `spec_register`, `spec_notify`, `worktree_diff`, `worktree_sync`, `worktree_detect`, `worktree_cleanup`
**NOT affected:** all `memory_*` tools (`memory_save`, `memory_search`, `memory_get`, `memory_stats`, `memory_share`)

---

## Summary

Several Sentinal MCP tools intermittently fail with the generic error:

```
Was there a typo in the url or port?
```

The same tool, called later in the same session with **identical arguments**, succeeds.
This indicates an **intermittent transport/connection failure** to the Sentinal backend
(sidecar/daemon), not a per-tool logic bug. The error message is unhelpful: it hides the
real cause (target host/port, HTTP status, or socket errno), making the failure hard to
diagnose.

A secondary issue: the worktree index can report "not found" while the worktree still
exists on disk (state/index drift).

---

## Impact

- During an active `/spec` bugfix workflow, `spec_register`, `spec_notify`, and the
  `worktree_*` tools failed mid-flow. Work continued only because each step had a manual
  fallback (`git` directly for worktree merge/cleanup; plan file is the source of truth
  for registration). Without those fallbacks the workflow would have stalled.
- Because the error text is generic, it is impossible to tell from the tool output whether
  the cause is a wrong config (URL/port), a backend that is down, a timeout, or a transient
  network blip.

---

## Error signatures observed

### 1. Generic connectivity error (the primary bug)

These calls returned the generic message during the session:

| Tool               | Error returned during session                                       | Re-test result (same session, later)                                                 |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `spec_register`    | `Error registering plan: Was there a typo in the url or port?`      | ✅ Succeeded: `Registered: 2026-06-09-embed-form-csp-path-acl (VERIFIED, 0/2 tasks)` |
| `spec_notify`      | `Error creating notification: Was there a typo in the url or port?` | ✅ Succeeded: `Notification created: Probe`                                          |
| `worktree_diff`    | `Error getting diff: Was there a typo in the url or port?`          | ⚠️ Now returns `No active worktree found for slug: ...` (worktree since removed)     |
| `worktree_cleanup` | `Error ... Was there a typo in the url or port?`                    | ✅ Succeeded: `Cleaned up 2 stale worktrees.`                                        |

The shared phrasing — **"Was there a typo in the url or port?"** — strongly suggests an
underlying `fetch`/`undici` connection error (e.g. `ECONNREFUSED` / `ETIMEDOUT` /
`ENOTFOUND`) being caught and re-surfaced as a generic hint, with the real error discarded.

### 2. Worktree index / disk drift (secondary bug)

- Earlier in the session, `worktree_sync` returned
  `No active worktree found for slug: 2026-06-09-twilio-sms-integration-9566ba4b`
  **while the worktree directory still existed on disk** — so the merge had to be done
  manually via `git merge --squash`.
- Similarly `worktree_detect` intermittently returned "not found" for a slug whose
  worktree was present.

This is an index/state-tracking issue: the tool's view of active worktrees can diverge
from what is actually on disk.

---

## What is NOT a bug (verified working as designed)

Included so the report is accurate and reviewers don't chase non-issues:

- **`memory_save` with `shared: true`** on a `fix`-type observation returned:
  `Saved observation #111 ... (shared skipped: only decision/discovery/pattern types can be shared)`
  → **By design.** Only `decision` / `discovery` / `pattern` observations can be shared.
- **`memory_share`** of the same `fix` observation returned:
  `Promoted 0 observation(s) ... Rejected 1 (only decision/discovery/pattern types allowed).`
  → **By design**, same rule.
- All other memory tools (`memory_stats`, `memory_search`, `memory_get`, `memory_save`)
  functioned correctly throughout the session. **The memory subsystem shows no errors.**

---

## Steps to reproduce

The failure is intermittent, so it is not deterministically reproducible, but the pattern is:

1. During an active session, invoke `spec_register` / `spec_notify` / `worktree_diff` /
   `worktree_cleanup` with valid arguments.
2. Intermittently the call returns `... Was there a typo in the url or port?`.
3. Re-invoke the same tool later with identical arguments → it succeeds.

For the worktree drift issue:

1. Create a worktree via `worktree_create` (or have one on disk).
2. Call `worktree_sync` / `worktree_detect` for that slug.
3. Observe "No active worktree found" returned even though the directory exists on disk.

---

## Expected behaviour

1. **Reliability:** Transient backend-connection failures should be retried (with backoff)
   before surfacing an error to the caller, or the connection to the Sentinal backend
   should be kept healthy across the session.
2. **Diagnosability:** When a connection genuinely fails, the error should include:
   - the target URL and port that was attempted,
   - the underlying error code (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, HTTP status, …),
   - which backend operation failed.
     e.g. `spec_register failed: POST http://127.0.0.1:<port>/register — ECONNREFUSED`
3. **Worktree state:** `worktree_detect` / `worktree_sync` / `worktree_diff` should
   reconcile against the actual filesystem (self-heal) so they don't report "not found"
   for a worktree that exists on disk.

---

## Actual behaviour

- Intermittent generic error `Was there a typo in the url or port?` with no actionable
  detail; same call succeeds on retry.
- Worktree tools can report "not found" while the worktree exists on disk.

---

## Environment

- Project where observed: `/home/evan/Projects/k8s/clusters/hcd-external/flux`
  (also seen earlier against `/home/evan/Projects/autonexus/platform`).
- OS: linux
- Sentinal memory DB at time of report: 111 observations, 678 sessions, 944.0 KB,
  date range 2026-03-10 → 2026-06-09 (memory subsystem healthy).

---

## Suggested fixes / investigation

1. In the MCP client→backend HTTP layer, **do not swallow the original error** — wrap and
   include `err.code`, the URL, and the port in the message.
2. Add a **short retry with backoff** on `ECONNREFUSED`/`ETIMEDOUT` for idempotent calls
   (`spec_register`, `spec_notify`, `worktree_detect`, `worktree_diff`).
3. Investigate why the backend connection drops intermittently within a session
   (sidecar restart? socket idle timeout? port re-bind?).
4. Make `worktree_detect`/`worktree_sync` reconcile the index with on-disk worktrees before
   answering, and treat an on-disk worktree as authoritative.
