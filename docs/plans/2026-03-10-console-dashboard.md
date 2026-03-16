# Console Dashboard Implementation Plan

Created: 2026-03-10
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: docs/plans/2026-03-09-market research-parity.md (Tasks 8 + 9)

## Summary

**Goal:** Build a console dashboard served by `sentinal serve` that provides a web UI for monitoring active sessions, viewing specifications, browsing memories, managing sessions, and configuring settings.

**Architecture:** `Bun.serve()` HTTP server with server-rendered HTML template strings, htmx (CDN + inline fallback) for partial page updates, Tailwind CSS (CDN) for styling. No framework, no build step, no WebSocket. htmx polling for live updates.

**Tech Stack:** Bun.serve(), HTML template strings, htmx 2.x, Tailwind CSS CDN, SQLite (existing `~/.sentinal/memory.db`)

## Scope

### In Scope

- V6 migration: `notifications` table in SQLite
- Notification CRUD methods on MemoryStore
- PID-based server lifecycle management (`~/.sentinal/server.pid`)
- HTTP server + router (`Bun.serve()`, `URL.pathname` switch)
- HTML layout shell (head, nav, footer, htmx, Tailwind)
- Dashboard (home) view: active sessions, spec progress, recent notifications
- `sentinal serve` CLI command
- JSON API routes for all data
- Specifications view with task progress
- Memories view with search and type filters
- Sessions view with active/past
- Settings view with model routing form
- Hook auto-lifecycle: auto-start dashboard on session-start, auto-stop on last session-end

### Out of Scope

- WebSocket / SSE (htmx polling is sufficient for v1)
- Authentication (localhost-only by default)
- React/Vue/Svelte (server-rendered HTML strings only)
- Build step for frontend assets

## Context for Implementer

**Patterns to follow:**

- Views are functions returning HTML strings: `function dashboardView(data: DashboardData): string`
- Fragment functions for htmx partial swaps: `function sessionsFragment(sessions: Session[]): string`
- Router is a simple `URL.pathname` switch in `src/dashboard/server.ts`
- API routes return JSON with `Content-Type: application/json`
- All CRUD on `MemoryStore` (consistent with settings, sessions, specs)
- Tests co-located as `*.test.ts` next to source files
- File length limit: 400 lines warn, 600 lines block

**Key files:**

- `src/memory/store.ts` (427 lines) — will gain notification CRUD methods
- `src/memory/migrations.ts` (200 lines) — will gain `migrateV6()`
- `src/memory/types.ts` (160 lines) — will gain `Notification` type, bump SCHEMA_VERSION to 6
- `src/cli/index.ts` (132 lines) — will register `serve` command
- `src/hooks/session-start.ts` (43 lines) — will gain auto-start dashboard
- `src/hooks/session-end.ts` (28 lines) — will gain auto-stop dashboard + notification

**Conventions:**

- Port 41778 (configurable via `--port`)
- Default bind: `127.0.0.1` (configurable via `--host 0.0.0.0` for network access)
- PID file: `~/.sentinal/server.pid`
- All API responses include `X-Sentinal-Version` header

## Implementation Tasks

### Task 8.1: V6 Migration — Notifications Table

**Objective:** Add `notifications` table to SQLite schema.

**Files:**

- Modify: `src/memory/migrations.ts` — Add `migrateV6()`
- Modify: `src/memory/types.ts` — Bump `SCHEMA_VERSION` to 6, add `Notification` and `NotificationType` types, add `RawNotification` row type
- Modify: `src/memory/migrations.test.ts` — Add V6 test

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,        -- 'info' | 'warning' | 'error' | 'success'
  title TEXT NOT NULL,
  message TEXT,
  source TEXT,               -- 'session-end' | 'compaction' | 'spec-complete' | etc.
  spec_id TEXT REFERENCES specs(id),
  session_id TEXT,
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);
```

**Definition of Done:**

- [x] `migrateV6()` creates notifications table
- [x] `SCHEMA_VERSION` is 6
- [x] Migration is idempotent
- [x] Test verifies notifications table exists after migration

### Task 8.2: Notification CRUD on MemoryStore

**Objective:** Add notification methods to MemoryStore.

**Files:**

- Modify: `src/memory/store.ts` — Add `insertNotification()`, `getNotifications()`, `markNotificationRead()`, `markAllNotificationsRead()`, `getUnreadCount()`, `deleteOldNotifications()`
- Modify: `src/memory/store.test.ts` — Add notification CRUD tests
- Modify: `src/index.ts` — Export notification types

**Definition of Done:**

- [x] All 6 notification methods work
- [x] Tests cover: insert, list, mark read, mark all read, unread count, delete old
- [x] Types exported from barrel

### Task 8.3: PID-Based Lifecycle Manager

**Objective:** Manage dashboard server lifecycle via PID file.

**Files:**

- Create: `src/dashboard/lifecycle.ts` — `writePidFile()`, `readPidFile()`, `isServerRunning()`, `removePidFile()`, `stopServer()`
- Create: `src/dashboard/lifecycle.test.ts`

**Definition of Done:**

- [x] PID file written on server start, removed on stop
- [x] `isServerRunning()` checks if PID process is alive
- [x] `stopServer()` sends SIGTERM to PID and removes PID file
- [x] Handles stale PID files (process no longer exists)
- [x] Tests cover: write/read/remove, stale PID, running check

### Task 8.4: HTTP Server + Router

**Objective:** Create the `Bun.serve()` HTTP server with URL routing.

**Files:**

- Create: `src/dashboard/server.ts` — `startServer()`, `createRouter()`, request handler
- Create: `src/dashboard/server.test.ts` — Integration tests

**Routes:**

- `GET /` → Dashboard view (HTML)
- `GET /specifications` → Specifications view (HTML)
- `GET /memories` → Memories view (HTML)
- `GET /sessions` → Sessions view (HTML)
- `GET /settings` → Settings view (HTML)
- `GET /api/health` → `{"status":"ok","version":"..."}`
- `GET /api/dashboard` → Dashboard data (JSON)
- `GET /api/sessions` → Sessions list (JSON)
- `GET /api/specs` → Specs list (JSON)
- `GET /api/memories` → Memories list (JSON)
- `GET /api/notifications` → Notifications list (JSON)
- `GET /api/settings` → Settings (JSON)
- `POST /api/settings` → Update settings (JSON)
- `POST /api/notifications/read` → Mark all read
- Fragment routes for htmx: `GET /fragments/*`

**Definition of Done:**

- [x] Server starts on configurable port
- [x] All routes return correct content types
- [x] 404 for unknown routes
- [x] `X-Sentinal-Version` header on all responses
- [x] CORS headers for localhost
- [x] Tests cover: health endpoint, 404 handling, content types

### Task 8.5: Layout View

**Objective:** Create the HTML shell that wraps all views.

**Files:**

- Create: `src/dashboard/views/layout.ts` — `layout()` function wrapping content in HTML shell

**Layout includes:**

- `<head>` with Tailwind CDN + htmx CDN (+ inline fallback)
- Navigation bar: Dashboard | Specifications | Memories | Sessions | Settings
- Active nav item highlighting
- Notification badge (unread count)
- Footer with version
- Dark mode support via Tailwind `dark:` classes
- Responsive: mobile-friendly nav

**Definition of Done:**

- [x] `layout(title, content, activePage)` returns complete HTML document
- [x] Navigation links to all pages
- [x] htmx and Tailwind loaded
- [x] Inline fallback for htmx (air-gapped environments)

### Task 8.6: Dashboard (Home) View

**Objective:** Create the main dashboard view showing workspace overview.

**Files:**

- Create: `src/dashboard/views/dashboard.ts` — `dashboardView()` and `dashboardFragment()`

**Displays:**

- Active session count with list (project, assistant, duration)
- Current/recent spec with task progress bar
- Recent notifications (last 10)
- Quick stats: total observations, total sessions, database size
- Auto-refresh via htmx `hx-trigger="every 5s"` on the main content area

**Definition of Done:**

- [x] Dashboard renders with real data
- [x] Session list shows active sessions
- [x] Spec progress bar accurate
- [x] Notifications displayed
- [x] Auto-refresh works via htmx polling

### Task 8.7: `sentinal serve` CLI Command

**Objective:** Wire up the `sentinal serve` command.

**Files:**

- Create: `src/cli/commands/serve.ts` — `registerServeCommand()`
- Modify: `src/cli/index.ts` — Register serve command

**Options:**

- `--port <port>` (default: 41778)
- `--host <host>` (default: 127.0.0.1)
- `--background` / `-d` (detach as background process)

**Definition of Done:**

- [x] `sentinal serve` starts the dashboard server
- [x] `sentinal serve --background` starts detached
- [x] Duplicate detection: exits if server already running
- [x] PID file lifecycle integrated
- [x] Graceful shutdown on SIGTERM/SIGINT

### Task 9.1: API Routes

**Objective:** Implement all JSON API endpoints.

**Files:**

- Create: `src/dashboard/routes/api.ts` — API route handlers
- Modify: `src/dashboard/server.ts` — Wire API routes

**Endpoints:**

- `GET /api/dashboard` — Active sessions, current spec, recent notifications, stats
- `GET /api/sessions?active=true&project=...` — Session list with filters
- `GET /api/specs` — All specs with task counts
- `GET /api/specs/:id` — Single spec detail with tasks
- `GET /api/memories?q=...&type=...&page=1` — Search/list observations
- `GET /api/notifications?unread=true` — Notification list
- `POST /api/notifications/read` — Mark all notifications read
- `POST /api/notifications/:id/read` — Mark single notification read
- `GET /api/settings` — All settings as JSON
- `POST /api/settings` — Upsert settings

**Definition of Done:**

- [x] All endpoints return correct JSON
- [x] Query param filters work
- [x] Pagination works for memories
- [x] Error responses use consistent format

### Task 9.2: Specifications View

**Objective:** Create the specifications browser view.

**Files:**

- Create: `src/dashboard/views/specifications.ts` — `specificationsView()` and fragments

**Displays:**

- List of all specs (from SQLite `specs` table)
- Status badge (approved, in-progress, complete, etc.)
- Task progress bar (tasks_done / task_count)
- Expandable detail: task list with checkmarks
- Filter by status
- Link to plan file path

**Definition of Done:**

- [x] Specs listed with status and progress
- [x] Task detail expandable
- [x] Status filter works via htmx
- [x] Empty state handled

### Task 9.3: Memories View

**Objective:** Create the memories browser with search.

**Files:**

- Create: `src/dashboard/views/memories.ts` — `memoriesView()` and fragments

**Displays:**

- Search bar with htmx `hx-get` on input
- Type filter chips (decision, discovery, error, fix, pattern)
- Observation cards: title, type badge, timestamp, snippet
- Expandable full content
- Pagination (20 per page)
- Project filter dropdown

**Definition of Done:**

- [x] Search returns results via htmx
- [x] Type filters work
- [x] Pagination works
- [x] Empty state handled

### Task 9.4: Sessions View

**Objective:** Create the sessions browser view.

**Files:**

- Create: `src/dashboard/views/sessions.ts` — `sessionsView()` and fragments

**Displays:**

- Table: session ID (truncated), project, assistant, start time, duration, status
- Active sessions highlighted (green dot)
- Sort by recency (default)
- Filter: active only, by project, by assistant
- Cleanup button: end stale sessions

**Definition of Done:**

- [x] Sessions listed with all fields
- [x] Active sessions visually distinct
- [x] Filters work via htmx
- [x] Cleanup button calls API

### Task 9.5: Settings View

**Objective:** Create the settings management view.

**Files:**

- Create: `src/dashboard/views/settings.ts` — `settingsView()` and fragments

**Displays:**

- Model routing form:
  - Planning model (text input, default: opus)
  - Implementation model (text input, default: sonnet)
  - Verification model (text input, default: sonnet)
- Save button (htmx POST to /api/settings)
- Success/error toast after save
- Display current database path and size
- Display current version

**Definition of Done:**

- [x] Settings form loads current values
- [x] Save updates SQLite settings
- [x] Success feedback displayed
- [x] Validation on required fields

### Task 9.6: Hook Auto-Lifecycle

**Objective:** Auto-start dashboard on first session, auto-stop when last session ends.

**Files:**

- Modify: `src/hooks/session-start.ts` — Auto-start dashboard if not running
- Modify: `src/hooks/session-end.ts` — Auto-stop dashboard if no active sessions remain, add session-end notification

**Behavior:**

- `session-start.ts`: After `insertSession()`, check `isServerRunning()`. If not, spawn `sentinal serve --background`.
- `session-end.ts`: After `endSession()`, check `getActiveSessions()`. If empty, call `stopServer()`. Also insert a notification: `{ type: 'info', title: 'Session ended', source: 'session-end', sessionId }`.

**Definition of Done:**

- [x] Dashboard auto-starts on first session
- [x] Dashboard auto-stops when last session ends
- [x] Session-end notification created
- [x] No errors if dashboard binary not found (graceful degradation)
- [x] Tests cover auto-lifecycle logic (mocked subprocess)

## Testing Strategy

- **Unit tests:** Migration test, notification CRUD test, lifecycle test
- **Integration tests:** Server routes tested via `fetch()` against test server
- **View tests:** Not tested (HTML string output — visual verification)
- **Hook tests:** Auto-lifecycle logic tested with mocked subprocess

## Risks and Mitigations

| Risk                                              | Likelihood | Impact | Mitigation                                              |
| ------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| CDN unavailable                                   | Low        | Low    | Inline htmx fallback bundled in layout                  |
| store.ts exceeds 600 lines with notification CRUD | Medium     | Medium | Extract notification methods to separate file if needed |
| PID file race conditions                          | Low        | Low    | Check-and-write is atomic enough for single-user tool   |
