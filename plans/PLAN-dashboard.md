# PLAN: Web Dashboard

## Overview

Create a local web dashboard for monitoring Sentinal sessions, browsing persistent memory, tracking spec workflow progress, and managing configuration. The dashboard provides better visibility than CLI-only output and enables real-time notifications when the AI needs user input.

## Goals

1. **Session visibility** -- Track active sessions, context usage, and progress
2. **Memory browsing** -- Search and explore captured observations
3. **Workflow monitoring** -- Spec progress, task status, verification results
4. **Real-time updates** -- Live status changes and notifications
5. **Configuration UI** -- Settings, preferences, and quality thresholds

## Architecture

### Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Backend | Fastify + Node.js | Lightweight, fast, TypeScript-native |
| API | REST + WebSocket | REST for CRUD, WebSocket for live updates |
| Frontend | React 19 + TypeScript | Component model, ecosystem, SSR optional |
| Styling | Tailwind CSS + shadcn/ui | Consistent with Angular/NestJS standards |
| Database | SQLite (shared) | Same DB as memory/spec systems |
| Build | Vite | Fast dev server, optimized production build |
| Bundling | Embedded in `sentinal` binary | Single command to start |

### Components

```
src/dashboard/
  server.ts             # Fastify server, route registration, WebSocket
  routes/
    sessions.ts         # GET /api/sessions, GET /api/sessions/:id
    memory.ts           # GET /api/memory/search, CRUD endpoints
    workflows.ts        # GET /api/workflows, GET /api/workflows/:id
    stats.ts            # GET /api/stats
    settings.ts         # GET/PUT /api/settings
  middleware/
    auth.ts             # Local token authentication
    cors.ts             # CORS configuration
  events/
    emitter.ts          # Event bus for real-time updates
    watcher.ts          # SQLite change detection

src/dashboard/client/   # React SPA
  src/
    App.tsx
    pages/
      Dashboard.tsx     # Overview with widgets
      Sessions.tsx      # Session list and details
      Memory.tsx        # Memory browser with search
      Workflows.tsx     # Spec progress tracker
      Settings.tsx      # Configuration UI
    components/
      layout/
        Sidebar.tsx
        Header.tsx
        NotificationCenter.tsx
      widgets/
        ActiveSessions.tsx
        RecentMemory.tsx
        WorkflowProgress.tsx
        ContextUsage.tsx
        QuickStats.tsx
      memory/
        SearchBar.tsx
        ObservationCard.tsx
        TagFilter.tsx
        TimelineView.tsx
      workflows/
        SpecCard.tsx
        TaskList.tsx
        VerificationStatus.tsx
        ProgressBar.tsx
    hooks/
      useWebSocket.ts
      useApi.ts
      useNotifications.ts
    lib/
      api.ts            # API client
      types.ts          # Shared types
      websocket.ts      # WebSocket client
```

### API Endpoints

```
Sessions:
  GET    /api/sessions                # List sessions (filterable)
  GET    /api/sessions/:id            # Session details
  GET    /api/sessions/active         # Currently active sessions

Memory:
  GET    /api/memory/search?q=&type=&tags=&from=&to=  # Search observations
  GET    /api/memory/:id              # Single observation
  POST   /api/memory                  # Create observation manually
  DELETE /api/memory/:id              # Delete observation
  GET    /api/memory/tags             # All unique tags
  GET    /api/memory/stats            # Memory statistics

Workflows:
  GET    /api/workflows               # List all specs
  GET    /api/workflows/:id           # Spec details with tasks
  GET    /api/workflows/active        # Currently active specs
  GET    /api/workflows/:id/events    # Spec event log

Stats:
  GET    /api/stats                   # Aggregate statistics
  GET    /api/stats/daily             # Daily activity breakdown

Settings:
  GET    /api/settings                # Current configuration
  PUT    /api/settings                # Update configuration

WebSocket Events:
  session.started       # New session began
  session.ended         # Session completed
  session.context       # Context usage update
  memory.created        # New observation captured
  workflow.updated      # Spec status changed
  workflow.task         # Task status changed
  notification          # User attention needed
```

### Real-time Architecture

```
┌──────────────┐    SQLite     ┌──────────────┐    WebSocket    ┌──────────────┐
│  Claude Code │───changes───> │   Dashboard  │───events──────> │   Browser    │
│  / OpenCode  │               │   Server     │                 │   Client     │
│  (hooks)     │               │   (Fastify)  │ <──requests──── │   (React)    │
└──────────────┘               └──────────────┘    REST API     └──────────────┘
```

**Change detection strategy:**
- SQLite WAL mode enables concurrent reads
- Poll-based change detection (500ms interval)
- Compare row counts and max timestamps
- Emit WebSocket events on detected changes

## Views

### 1. Dashboard (Home)

```
┌─────────────────────────────────────────────────────────────┐
│  Sentinal Dashboard                    [Notifications] [⚙]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐   │
│  │ Active        │  │ Today         │  │ Memory        │   │
│  │ Sessions: 2   │  │ Edits: 47     │  │ 234 total     │   │
│  │ CC:1  OC:1    │  │ Checks: 12    │  │ 8 this week   │   │
│  └───────────────┘  └───────────────┘  └───────────────┘   │
│                                                             │
│  Active Workflows                                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Add user authentication          IMPLEMENTING       │   │
│  │ ████████████░░░░░░░░  Task 3/5   60%               │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Fix login crash                  VERIFYING          │   │
│  │ ██████████████████░░  Verify     90%               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Recent Activity                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 10:32  [discovery] CDK scroll needs explicit height │   │
│  │ 10:28  [fix] Auth guard now checks token expiry     │   │
│  │ 10:15  [decision] Using repository pattern for DAL  │   │
│  │ 09:50  Session started (Claude Code)                │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2. Sessions View

- Table of all sessions (date, duration, assistant, observation count)
- Filter by assistant (Claude Code / OpenCode), date range
- Click into session for detail: timeline of events, observations, files touched

### 3. Memory View

- Full-text search bar with instant results
- Filter sidebar: type, tags, date range, project
- Results as cards with title, content preview, tags, timestamp
- Timeline toggle: chronological view of all observations
- Export button: JSON or Markdown

### 4. Workflows View

- Cards for each spec with status badge, progress bar, task list
- Click into spec for full detail: plan document, task status, event log
- Filter by status (active, complete, cancelled)
- Verification results with pass/fail indicators

### 5. Settings View

- Quality thresholds (file length warn/block limits)
- Memory retention (auto-prune age)
- Worktree configuration (enabled, max active, auto-cleanup)
- Notification preferences (browser notifications, sounds)
- Theme selection (light/dark/system)

## Implementation Steps

### Phase 1: Backend API (Week 1)

**Files to create:**
- `src/dashboard/server.ts` -- Fastify server setup
- `src/dashboard/routes/sessions.ts`
- `src/dashboard/routes/memory.ts`
- `src/dashboard/routes/workflows.ts`
- `src/dashboard/routes/stats.ts`
- `src/dashboard/routes/settings.ts`
- `src/dashboard/middleware/auth.ts`
- `src/dashboard/events/emitter.ts`
- `src/dashboard/events/watcher.ts`
- Tests for each route module

**Server setup:**
```typescript
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";

export async function createDashboardServer(port = 3847) {
  const app = Fastify({ logger: true });
  
  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(staticFiles, {
    root: join(__dirname, "client", "dist"),
    prefix: "/",
  });
  
  // Register routes
  await app.register(sessionRoutes, { prefix: "/api/sessions" });
  await app.register(memoryRoutes, { prefix: "/api/memory" });
  await app.register(workflowRoutes, { prefix: "/api/workflows" });
  await app.register(statsRoutes, { prefix: "/api/stats" });
  await app.register(settingsRoutes, { prefix: "/api/settings" });
  
  // WebSocket endpoint
  app.get("/ws", { websocket: true }, (socket) => {
    eventEmitter.addClient(socket);
    socket.on("close", () => eventEmitter.removeClient(socket));
  });
  
  return app;
}
```

**Dependencies to add:**
```json
{
  "fastify": "^5.0.0",
  "@fastify/cors": "^10.0.0",
  "@fastify/websocket": "^11.0.0",
  "@fastify/static": "^8.0.0"
}
```

### Phase 2: Frontend Shell (Week 2)

**Setup:**
```bash
# Create React app in src/dashboard/client/
npm create vite@latest client -- --template react-ts
cd client && npm install tailwindcss @tailwindcss/vite
npx shadcn@latest init
```

**Core components to build:**
- Application shell with sidebar navigation
- Responsive layout (sidebar collapses on mobile)
- WebSocket connection manager with auto-reconnect
- API client with error handling
- Notification center component
- Loading/error state components

**Routing:**
```typescript
const routes = [
  { path: "/", element: <Dashboard /> },
  { path: "/sessions", element: <Sessions /> },
  { path: "/sessions/:id", element: <SessionDetail /> },
  { path: "/memory", element: <Memory /> },
  { path: "/workflows", element: <Workflows /> },
  { path: "/workflows/:id", element: <WorkflowDetail /> },
  { path: "/settings", element: <Settings /> },
];
```

### Phase 3: Dashboard & Memory Views (Week 3)

**Dashboard widgets:**
- `ActiveSessions` -- Live count with assistant breakdown
- `QuickStats` -- Today's edits, checks, observations
- `WorkflowProgress` -- Active spec progress bars
- `RecentActivity` -- Timeline of recent events
- `ContextUsage` -- Effective context % for active sessions

**Memory browser:**
- `SearchBar` -- Debounced full-text search (300ms)
- `ObservationCard` -- Title, content preview, type badge, tags, timestamp
- `TagFilter` -- Clickable tag chips for filtering
- `TimelineView` -- Chronological view with date separators
- Pagination with virtual scrolling for large result sets

### Phase 4: Workflows, Settings & Polish (Week 4)

**Workflow components:**
- `SpecCard` -- Status badge, progress bar, task summary
- `TaskList` -- Ordered tasks with status indicators
- `VerificationStatus` -- Pass/fail for each check
- `EventLog` -- Chronological spec events

**Settings components:**
- Form-based configuration editing
- Save/reset with validation
- Theme switcher (light/dark/system)

**Polish:**
- Browser notifications API integration
- Keyboard shortcuts (Ctrl+K for search)
- Empty states with helpful messaging
- Error boundaries
- Loading skeletons

## CLI Integration

```bash
# Start dashboard server
sentinal dashboard                    # Start on default port 3847
sentinal dashboard --port 4000        # Custom port
sentinal dashboard --open             # Start and open browser

# Background mode
sentinal dashboard --daemon           # Run as background process
sentinal dashboard stop               # Stop background process
sentinal dashboard status             # Check if running
```

**Auto-start option:**
- Configure in `~/.sentinal/config.json`: `"dashboard": { "autoStart": true }`
- Starts on first `sentinal` invocation, stops when no sessions active

## Build & Distribution

**Production build pipeline:**
1. Build React SPA with Vite (`npm run build`)
2. Output to `src/dashboard/client/dist/`
3. Fastify serves static files from this directory
4. Single `sentinal dashboard` command serves everything

**Development mode:**
```bash
# Terminal 1: Backend with hot reload
npm run dashboard:dev

# Terminal 2: Frontend with HMR
npm run dashboard:client
```

**Package scripts:**
```json
{
  "dashboard:build": "cd src/dashboard/client && npm run build",
  "dashboard:dev": "tsx watch src/dashboard/server.ts",
  "dashboard:client": "cd src/dashboard/client && npm run dev"
}
```

## Technical Considerations

### Performance
- Virtual scrolling for large lists (>100 items)
- Debounced search input (300ms)
- Paginated API responses (default 50 items)
- WebSocket heartbeat (30s interval)
- Lazy-loaded route components

### Security
- Local-only by default (binds to 127.0.0.1)
- Optional token auth for network access
- CORS restricted to localhost
- No external API calls from dashboard
- XSS prevention via React's built-in escaping

### Browser Compatibility
- Modern browsers only (Chrome, Firefox, Safari, Edge)
- No IE11 support
- PWA manifest for "Add to Home Screen"
- Service worker for offline caching (settings, recent data)

### Accessibility
- WCAG 2.1 AA compliance
- Keyboard navigation for all interactions
- Screen reader labels on interactive elements
- High contrast mode support
- Reduced motion preference respected

## Future Enhancements

1. **Team features** -- Multi-user dashboards, shared views
2. **Analytics** -- Usage trends, quality scores, productivity metrics
3. **Integrations** -- Slack/Discord notifications, GitHub PR links
4. **Custom widgets** -- User-configurable dashboard layout
5. **Mobile app** -- React Native companion (stretch goal)
6. **Export reports** -- PDF/HTML quality reports for stakeholders

## Success Metrics

| Metric | Target |
|--------|--------|
| Page load time | <500ms (first contentful paint) |
| WebSocket latency | <100ms for event delivery |
| Search response | <200ms for full-text queries |
| Daily active usage | 80% of Sentinal users check dashboard |
| Feature coverage | All 5 views used by 60%+ of users |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Port conflicts | Configurable port, auto-detect available port |
| Bundle size | Code splitting, lazy loading, tree shaking |
| SQLite contention | WAL mode, read-only connections, retry logic |
| Browser notifications blocked | Fallback to in-app notification center |
| Frontend framework churn | Minimal dependencies, component isolation |
| Development overhead | shadcn/ui for pre-built components, Vite for fast iteration |
