# PLAN: Git Worktree Integration

**Status:** VERIFIED

## Overview

Implement git worktree support so each `/spec` task runs in an isolated branch and directory. This enables safe experimentation, parallel feature development, and clean git history via squash merges.

## Goals

1. **Isolation** -- Each spec runs in its own worktree, main branch stays clean
2. **Parallel development** -- Multiple features can be developed simultaneously
3. **Clean history** -- Squash merge produces a single commit per feature
4. **Safety** -- Discard failed attempts without affecting main
5. **Transparency** -- Clear status of all active worktrees

## Architecture

### Components

```
src/git/
  worktree-manager.ts   # Create, remove, list, status
  worktree-store.ts     # SQLite persistence for worktree state
  worktree-merge.ts     # Squash merge, conflict detection, cleanup
  worktree-types.ts     # Interfaces and enums
  worktree-manager.test.ts
  worktree-merge.test.ts
```

### Worktree Lifecycle

```
/spec "Add auth"
      │
      v
┌─────────────────────────────────────────────────────────┐
│  1. Detect base branch (main/master/develop)            │
│  2. Create branch: sentinal/spec-add-auth               │
│  3. Create worktree: .sentinal/worktrees/spec-add-auth  │
│  4. Copy necessary config files                         │
│  5. Install dependencies (if needed)                    │
└────────────────────────┬────────────────────────────────┘
                         │
                         v
              ┌──────────────────┐
              │  IMPLEMENTATION  │  All edits happen in worktree
              │  (TDD per task)  │  Main branch untouched
              └────────┬─────────┘
                       │
                       v
              ┌──────────────────┐
              │  VERIFICATION    │  Tests run in worktree
              └────────┬─────────┘
                       │
                 ┌─────┴─────┐
                 │           │
               PASS        FAIL
                 │           │
                 v           v
          ┌────────┐   ┌─────────┐
          │ MERGE  │   │  RETRY  │ Loop back to implementation
          └───┬────┘   └─────────┘
              │
              v
┌─────────────────────────────────────────────────────────┐
│  1. Generate squash commit message from spec            │
│  2. Squash merge worktree branch into base              │
│  3. Delete worktree directory                           │
│  4. Delete branch                                       │
│  5. Update spec status to VERIFIED                      │
└─────────────────────────────────────────────────────────┘
```

### Database Schema

Extends `~/.sentinal/memory.db`:

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  spec_id TEXT REFERENCES specs(id),
  project_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL,       -- 'active' | 'ready-to-merge' | 'merged' | 'abandoned'
  created_at INTEGER NOT NULL,
  merged_at INTEGER,
  merge_commit TEXT
);

CREATE INDEX idx_wt_project ON worktrees(project_path);
CREATE INDEX idx_wt_status ON worktrees(status);
CREATE INDEX idx_wt_spec ON worktrees(spec_id);
```

### Key Interfaces

```typescript
interface Worktree {
  id: string;
  specId?: string;
  projectPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  status: WorktreeStatus;
  createdAt: number;
  mergedAt?: number;
  mergeCommit?: string;
}

enum WorktreeStatus {
  ACTIVE = "active",
  READY_TO_MERGE = "ready-to-merge",
  MERGED = "merged",
  ABANDONED = "abandoned",
}

interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    insertions: number;
    deletions: number;
  }>;
}

interface WorktreeManager {
  create(specId: string, baseBranch?: string): Promise<Worktree>;
  remove(worktreeId: string): Promise<void>;
  abandon(worktreeId: string): Promise<void>;
  list(projectPath?: string): Promise<Worktree[]>;
  status(worktreeId: string): Promise<Worktree>;
  diff(worktreeId: string): Promise<DiffSummary>;
  squashMerge(worktreeId: string, message?: string): Promise<string>;
  cleanup(): Promise<number>; // returns count of cleaned up worktrees
}
```

## Implementation Steps

### Phase 1: Core Worktree Operations (Week 1)

**Files to create:**

- `src/git/worktree-types.ts`
- `src/git/worktree-store.ts`
- `src/git/worktree-manager.ts`
- `src/git/worktree-manager.test.ts`
- `src/git/worktree-store.test.ts`

**Git operations (via child_process):**

```typescript
// Create worktree
git worktree add -b sentinal/spec-<slug> .sentinal/worktrees/<slug> <base-branch>

// List worktrees
git worktree list --porcelain

// Remove worktree
git worktree remove .sentinal/worktrees/<slug>

// Prune stale worktrees
git worktree prune

// Detect base branch
git symbolic-ref refs/remotes/origin/HEAD  // or check for main/master/develop
```

**Worktree directory structure:**

```
project-root/
  .sentinal/
    worktrees/
      spec-add-auth/          # Full checkout of the project
        src/
        package.json
        ...
      spec-fix-login-crash/   # Another parallel feature
        src/
        ...
```

**Base branch detection:**

```typescript
async function detectBaseBranch(projectPath: string): Promise<string> {
  // 1. Check for origin/HEAD
  // 2. Check for main, master, develop in order
  // 3. Fall back to current branch
  const candidates = ["main", "master", "develop"];
  for (const branch of candidates) {
    if (await branchExists(projectPath, branch)) return branch;
  }
  return getCurrentBranch(projectPath);
}
```

### Phase 2: Spec Integration (Week 2)

**Files to modify:**

- `src/spec/engine.ts` -- Create worktree on PENDING -> IMPLEMENTING transition
- `src/spec/phases/implementation.ts` -- Route file operations to worktree
- `src/spec/phases/verification.ts` -- Run verification in worktree context
- `templates/commands/spec.md` -- Add worktree awareness

**Automatic worktree creation:**

```typescript
// In spec engine, on transition to IMPLEMENTING
async function onImplementationStart(spec: Spec): Promise<void> {
  const config = loadConfig();
  if (config.worktree.enabled) {
    const worktree = await worktreeManager.create(spec.id);
    await specStore.update(spec.id, { worktreeId: worktree.id });

    // Notify AI of context change
    return `Working in isolated worktree: ${worktree.worktreePath}
All file operations should target this directory.
Base branch: ${worktree.baseBranch} (commit: ${worktree.baseCommit})`;
  }
}
```

**Path translation for hooks:**

```typescript
// In quality hooks, translate paths to worktree
function resolveFilePath(filePath: string, activeWorktree?: Worktree): string {
  if (!activeWorktree) return filePath;

  const projectRoot = activeWorktree.projectPath;
  if (filePath.startsWith(projectRoot)) {
    const relative = path.relative(projectRoot, filePath);
    return path.join(activeWorktree.worktreePath, relative);
  }
  return filePath;
}
```

### Phase 3: Merge Management (Week 3)

**Files to create:**

- `src/git/worktree-merge.ts`
- `src/git/worktree-merge.test.ts`

**Squash merge flow:**

```typescript
async function squashMerge(
  worktreeId: string,
  message?: string,
): Promise<string> {
  const wt = await store.get(worktreeId);

  // 1. Switch to base branch in main project
  await exec(`git checkout ${wt.baseBranch}`, { cwd: wt.projectPath });

  // 2. Squash merge
  const commitMsg = message || generateCommitMessage(wt);
  await exec(`git merge --squash ${wt.branchName}`, { cwd: wt.projectPath });
  await exec(`git commit -m "${commitMsg}"`, { cwd: wt.projectPath });

  // 3. Get merge commit hash
  const hash = await exec(`git rev-parse HEAD`, { cwd: wt.projectPath });

  // 4. Cleanup
  await exec(`git worktree remove ${wt.worktreePath}`, { cwd: wt.projectPath });
  await exec(`git branch -D ${wt.branchName}`, { cwd: wt.projectPath });

  // 5. Update state
  await store.update(worktreeId, {
    status: WorktreeStatus.MERGED,
    mergedAt: Date.now(),
    mergeCommit: hash.trim(),
  });

  return hash.trim();
}
```

**Commit message generation:**

```typescript
function generateCommitMessage(wt: Worktree, spec?: Spec): string {
  if (!spec) return `feat: ${wt.branchName.replace("sentinal/spec-", "")}`;

  const prefix = spec.type === "bugfix" ? "fix" : "feat";
  const taskSummary = spec.tasks
    .filter((t) => t.status === "complete")
    .map((t) => `- ${t.title}`)
    .join("\n");

  return `${prefix}: ${spec.title}\n\n${taskSummary}`;
}
```

**Conflict detection:**

```typescript
async function hasConflicts(worktreeId: string): Promise<boolean> {
  const wt = await store.get(worktreeId);
  try {
    // Dry-run merge to check for conflicts
    await exec(
      `git merge-tree $(git merge-base ${wt.baseBranch} ${wt.branchName}) ${wt.baseBranch} ${wt.branchName}`,
      { cwd: wt.projectPath },
    );
    return false;
  } catch {
    return true;
  }
}
```

### Phase 4: CLI & Configuration (Week 4)

**CLI commands:**

```bash
sentinal worktree list                  # List all active worktrees
sentinal worktree status <id|slug>      # Show worktree details + diff summary
sentinal worktree diff <id|slug>        # Show full diff
sentinal worktree merge <id|slug>       # Squash merge to base
sentinal worktree abandon <id|slug>     # Discard worktree
sentinal worktree cleanup               # Remove orphaned/stale worktrees
```

**Configuration (`~/.sentinal/config.json`):**

```json
{
  "worktree": {
    "enabled": true,
    "directory": ".sentinal/worktrees",
    "autoCreate": true,
    "autoMerge": false,
    "autoCleanup": true,
    "maxActive": 5,
    "branchPrefix": "sentinal/spec-"
  }
}
```

**Opt-in behavior:**

- Default: `enabled: false` (non-breaking for existing users)
- When enabled: worktrees created automatically for `/spec`
- Can be disabled per-spec: `/spec --no-worktree "quick fix"`

## Edge Cases

### Dependency installation

When creating a worktree, check for lock files and run install:

```typescript
async function setupWorktree(worktreePath: string): Promise<void> {
  const pm = detectPackageManager(worktreePath);
  if (existsSync(join(worktreePath, "package.json"))) {
    await exec(`${pm} install`, { cwd: worktreePath });
  }
}
```

### Stale worktrees

Auto-cleanup worktrees where:

- Associated spec is VERIFIED or CANCELLED
- Worktree is older than 30 days with no changes
- Branch has been deleted externally

### Multiple projects

Worktrees are scoped to the git repository root, not the cwd. Handle monorepos by detecting the repo root:

```typescript
const repoRoot = await exec("git rev-parse --show-toplevel");
```

### Submodules

```typescript
async function initSubmodules(worktreePath: string): Promise<void> {
  if (existsSync(join(worktreePath, ".gitmodules"))) {
    await exec("git submodule update --init --recursive", {
      cwd: worktreePath,
    });
  }
}
```

## Technical Considerations

### Performance

- Worktree creation: ~1-3s (git checkout)
- Dependency install: varies (cached if using lockfile)
- Squash merge: ~1s
- Disk usage: full copy of working tree (deduped by git)

### Git version requirements

- `git worktree` requires Git 2.5+
- `git worktree remove` requires Git 2.17+
- Detect and warn on older versions

### Disk space

- Each worktree is a full working copy
- Git objects are shared (not duplicated)
- `node_modules` can be large -- consider symlinking or `.gitignore` optimization
- Auto-cleanup helps manage disk usage

### CI/CD compatibility

- Worktrees are local-only, no impact on CI
- Squash merge produces standard commits
- Branch naming convention avoids conflicts with CI branches

## Success Metrics

| Metric                  | Target                                  |
| ----------------------- | --------------------------------------- |
| Isolation effectiveness | 100% of changes contained in worktree   |
| Merge success rate      | >95% automatic squash merge             |
| Conflict rate           | <5% of merges have conflicts            |
| Disk overhead           | <2x repository size per active worktree |
| Create/teardown time    | <10s including dependency install       |

## Risks & Mitigations

| Risk                  | Mitigation                                                           |
| --------------------- | -------------------------------------------------------------------- |
| Disk space exhaustion | Max worktree limit, auto-cleanup, size warnings                      |
| Git corruption        | Integrity checks, backup before merge, recovery procedures           |
| Merge conflicts       | Early conflict detection, user notification, manual resolution guide |
| Old Git version       | Version check on init, graceful degradation, clear error messages    |
| Orphaned worktrees    | Periodic cleanup, session end cleanup, manual prune command          |
| Large monorepos       | Sparse checkout option, selective dependency install                 |
