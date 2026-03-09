# PLAN: Spec Workflow Orchestration

## Overview

Implement a comprehensive spec-driven development workflow that orchestrates planning, implementation, and verification phases. The `/spec` command becomes a full state machine that manages the entire lifecycle of a feature or bugfix -- from exploration through verified completion.

## Goals

1. **Structured workflow** -- Plan -> Approve -> Implement -> Verify cycle
2. **State management** -- Track progress, handle interruptions, survive compaction
3. **Quality gates** -- Approval points and verification checks at each transition
4. **TDD enforcement** -- RED-GREEN-REFACTOR methodology during implementation
5. **Auto-detection** -- Distinguish features from bugfixes automatically
6. **Dual-target** -- Works identically on Claude Code and OpenCode

## Architecture

### Components

```
src/spec/
  engine.ts           # State machine, phase transitions, orchestration
  store.ts            # Spec persistence (SQLite + markdown files)
  types.ts            # Interfaces, enums, Zod schemas
  phases/
    planning.ts       # Codebase exploration, spec generation
    implementation.ts # TDD cycle management, task sequencing
    verification.ts   # Test execution, quality checks, completion
  detect.ts           # Feature vs bugfix auto-detection

templates/commands/
  spec.md             # Updated: orchestration-aware entry point
  spec-plan.md        # Updated: integrated with engine
  spec-implement.md   # Updated: TDD cycle tracking
  spec-verify.md      # Updated: verification with loop-back
```

### State Machine

```
                ┌──────────────┐
                │    DRAFT     │
                └──────┬───────┘
                       │ /spec "description"
                       v
                ┌──────────────┐
                │   PLANNING   │ AI explores codebase, writes spec
                └──────┬───────┘
                       │ spec complete
                       v
                ┌──────────────┐
                │   PENDING    │ Awaiting user approval
                └──────┬───────┘
                       │ user approves
                       v
                ┌──────────────┐
           ┌───>│ IMPLEMENTING │ TDD cycle per task
           │    └──────┬───────┘
           │           │ all tasks done
           │           v
           │    ┌──────────────┐
           │    │  VERIFYING   │ Tests, lint, type-check, review
           │    └──────┬───────┘
           │           │
           │     ┌─────┴─────┐
           │     │           │
           │   FAIL        PASS
           │     │           │
           │     v           v
           └─────┘    ┌──────────────┐
                      │   COMPLETE   │ Ready for user confirmation
                      └──────┬───────┘
                             │ user confirms
                             v
                      ┌──────────────┐
                      │   VERIFIED   │ Done
                      └──────────────┘
```

### Spec Document Format

Stored in `docs/plans/YYYY-MM-DD-<slug>.md`:

```markdown
# Spec: Add user authentication with JWT

**ID:** spec_01JFGH...
**Created:** 2026-03-09
**Status:** IMPLEMENTING
**Type:** feature
**Phase:** implementation
**Current Task:** 3 of 5

## Overview

Add JWT-based authentication with login, registration, and token refresh endpoints.

## Scope

**In scope:**
- Login/register API endpoints
- JWT token generation and validation
- Auth guard middleware
- Token refresh mechanism

**Out of scope:**
- OAuth providers (GitHub, Google)
- Password reset flow
- Email verification

**Assumptions:**
- Using NestJS with TypeORM
- PostgreSQL database
- bcrypt for password hashing

## Tasks

### 1. Create User entity and migration
- **Status:** complete
- **Test Strategy:** Unit test entity validation, integration test migration
- **Definition of Done:** Entity created, migration runs, tests pass

### 2. Create AuthModule with JWT strategy
- **Status:** complete
- **Test Strategy:** Unit test JWT service, mock strategy
- **Definition of Done:** Module registers, JWT signs and verifies

### 3. Implement login/register endpoints
- **Status:** in-progress
- **Test Strategy:** Integration test with supertest, happy + error paths
- **Definition of Done:** POST /auth/login and POST /auth/register work

### 4. Add AuthGuard to protected routes
- **Status:** pending
- **Test Strategy:** Unit test guard, integration test protected endpoints
- **Definition of Done:** Unauthorized requests return 401

### 5. Token refresh endpoint
- **Status:** pending
- **Test Strategy:** Integration test refresh flow, expired token handling
- **Definition of Done:** POST /auth/refresh rotates tokens

## Verification Criteria

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Type checking passes (tsc --noEmit)
- [ ] Linting passes (no errors)
- [ ] Test coverage >= 80% for new code
- [ ] No security vulnerabilities in auth flow

## Implementation Log

### Task 1 (2026-03-09 10:30)
Created User entity with email, passwordHash, createdAt fields.
Migration 1710000000000-CreateUser.ts applied successfully.

### Task 2 (2026-03-09 11:15)
AuthModule with JwtModule.register(), JwtStrategy, and AuthService.
Used passport-jwt for strategy implementation.
```

### Database Schema

Extends the memory database at `~/.sentinal/memory.db`:

```sql
CREATE TABLE specs (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'feature' | 'bugfix' | 'refactor'
  status TEXT NOT NULL,        -- state machine status
  plan_file TEXT NOT NULL,     -- path to markdown plan
  worktree_id TEXT,            -- optional git worktree reference
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE spec_tasks (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  test_strategy TEXT,
  definition_of_done TEXT,
  status TEXT NOT NULL,        -- 'pending' | 'in-progress' | 'complete' | 'failed'
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE spec_events (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,    -- 'phase_change' | 'task_update' | 'verification' | 'note'
  details TEXT NOT NULL        -- JSON
);

CREATE INDEX idx_specs_project ON specs(project_path);
CREATE INDEX idx_specs_status ON specs(status);
CREATE INDEX idx_tasks_spec ON spec_tasks(spec_id);
CREATE INDEX idx_events_spec ON spec_events(spec_id);
```

### Key Interfaces

```typescript
enum SpecStatus {
  DRAFT = "DRAFT",
  PLANNING = "PLANNING",
  PENDING = "PENDING",
  IMPLEMENTING = "IMPLEMENTING",
  VERIFYING = "VERIFYING",
  COMPLETE = "COMPLETE",
  VERIFIED = "VERIFIED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

enum SpecType {
  FEATURE = "feature",
  BUGFIX = "bugfix",
  REFACTOR = "refactor",
}

interface Spec {
  id: string;
  projectPath: string;
  title: string;
  slug: string;
  type: SpecType;
  status: SpecStatus;
  planFile: string;
  worktreeId?: string;
  tasks: SpecTask[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface SpecTask {
  id: string;
  specId: string;
  position: number;
  title: string;
  description?: string;
  testStrategy?: string;
  definitionOfDone?: string;
  status: "pending" | "in-progress" | "complete" | "failed";
  startedAt?: number;
  completedAt?: number;
}

interface SpecEngine {
  create(title: string, type?: SpecType): Promise<Spec>;
  transition(specId: string, to: SpecStatus): Promise<Spec>;
  getCurrentTask(specId: string): Promise<SpecTask | null>;
  advanceTask(specId: string): Promise<SpecTask | null>;
  failTask(specId: string, reason: string): Promise<void>;
  getActiveSpec(projectPath: string): Promise<Spec | null>;
  resume(specId: string): Promise<Spec>;
  cancel(specId: string): Promise<void>;
}
```

## Feature vs Bugfix Detection

```typescript
const BUGFIX_SIGNALS = [
  /\bfix\b/i, /\bbug\b/i, /\bcrash\b/i, /\bbroken\b/i,
  /\berror\b/i, /\bfailing?\b/i, /\bregression\b/i,
  /\bincorrect\b/i, /\bwrong\b/i, /\bissue\b/i,
];

function detectSpecType(description: string): SpecType {
  const bugfixScore = BUGFIX_SIGNALS.filter(r => r.test(description)).length;
  return bugfixScore >= 2 ? SpecType.BUGFIX : SpecType.FEATURE;
}
```

**Feature mode:** Full exploration -> plan -> TDD implementation -> verification
**Bugfix mode:** Reproduce -> root cause analysis -> regression test -> fix -> verify

## Implementation Steps

### Phase 1: Core Engine (Week 1)

**Files to create:**
- `src/spec/types.ts` -- All interfaces, enums, Zod schemas
- `src/spec/store.ts` -- SQLite persistence for specs and tasks
- `src/spec/engine.ts` -- State machine with transition validation
- `src/spec/detect.ts` -- Feature vs bugfix auto-detection
- `src/spec/engine.test.ts` -- Engine unit tests
- `src/spec/store.test.ts` -- Store unit tests
- `src/spec/detect.test.ts` -- Detection tests

**State transition rules:**
```typescript
const VALID_TRANSITIONS: Record<SpecStatus, SpecStatus[]> = {
  DRAFT: [PLANNING, CANCELLED],
  PLANNING: [PENDING, CANCELLED],
  PENDING: [IMPLEMENTING, CANCELLED],      // user approval
  IMPLEMENTING: [VERIFYING, CANCELLED],     // all tasks done
  VERIFYING: [COMPLETE, IMPLEMENTING],      // pass or loop back
  COMPLETE: [VERIFIED, CANCELLED],          // user confirms
  VERIFIED: [],                              // terminal
  FAILED: [IMPLEMENTING, CANCELLED],        // retry
  CANCELLED: [],                             // terminal
};
```

### Phase 2: Plan Document Management (Week 2)

**Files to create:**
- `src/spec/plan-writer.ts` -- Generate markdown plan from spec
- `src/spec/plan-parser.ts` -- Parse markdown plan back to spec state
- `src/spec/plan-writer.test.ts`
- `src/spec/plan-parser.test.ts`

**Files to modify:**
- `templates/commands/spec.md` -- Router that creates spec and delegates
- `templates/commands/spec-plan.md` -- Planning phase with engine integration

**Plan file lifecycle:**
1. Created in `docs/plans/YYYY-MM-DD-<slug>.md` during PLANNING
2. Updated with status changes during IMPLEMENTING
3. Implementation log appended after each task
4. Final verification results appended during VERIFYING
5. Archived when VERIFIED

### Phase 3: Implementation Orchestration (Week 3)

**Files to create:**
- `src/spec/phases/implementation.ts` -- TDD cycle manager
- `src/spec/phases/implementation.test.ts`

**Files to modify:**
- `templates/commands/spec-implement.md` -- Enhanced with task tracking

**TDD cycle per task:**
```
1. Read task from spec
2. RED: Write failing test(s) for the task
3. GREEN: Implement code until tests pass
4. REFACTOR: Clean up while tests still pass
5. Run full test suite
6. Mark task complete, advance to next
```

**Stop guard integration:**
- If spec is IMPLEMENTING or VERIFYING, block session stop
- Force verification to complete before ending
- Claude Code: existing `spec-stop-guard.ts` hook
- OpenCode: `event` handler for `session.idle`

### Phase 4: Verification & Loop-back (Week 4)

**Files to create:**
- `src/spec/phases/verification.ts` -- Verification runner
- `src/spec/phases/verification.test.ts`

**Files to modify:**
- `templates/commands/spec-verify.md` -- Enhanced with engine integration

**Verification checklist:**
1. Run full test suite
2. Run `tsc --noEmit` (TypeScript projects)
3. Run linter (ESLint/ruff/golangci-lint)
4. Check test coverage threshold
5. Review each task's definition of done
6. Generate verification report

**Loop-back on failure:**
- Identify which checks failed
- Transition back to IMPLEMENTING
- Focus on failed verification items
- Re-run verification after fixes

## Compaction Resilience

### Pre-compact capture
Save full spec state to both:
- SQLite database (structured)
- `.sentinal/compact-state.json` (quick restore)

### Post-compact restore
Inject into context:
```markdown
## Active Spec: Add user authentication with JWT

**Status:** IMPLEMENTING (Task 3 of 5)
**Current Task:** Implement login/register endpoints

Resume by reading the plan file and continuing implementation:
/spec docs/plans/2026-03-09-user-auth-jwt.md
```

## Integration with Other Plans

- **Persistent Memory:** Spec events are automatically captured as observations
- **Git Worktree:** Optional isolation via worktree (see PLAN-git-worktree.md)
- **Dashboard:** Spec progress visible in workflow view (see PLAN-dashboard.md)

## Success Metrics

| Metric | Target |
|--------|--------|
| Workflow completion rate | >80% of started specs reach VERIFIED |
| TDD compliance | >95% of tasks have tests written first |
| Verification pass rate | >70% pass on first attempt |
| Compaction recovery | 100% state preservation across compaction |
| Time savings | 30%+ faster than unstructured development |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Over-engineering plans | Keep planning phase time-boxed, simple templates |
| Rigid workflow | Allow quick mode bypass, cancel at any phase |
| State corruption | Dual persistence (SQLite + markdown), recovery mode |
| AI losing context | Compact state injection, plan file as source of truth |
| Slow verification | Parallel test runs, incremental checking |
