# Sentinal MCP Server (Self-Hosted)

The only MCP server this repo configures at the project level is **`sentinal`** itself (see `targets/claude-code/.mcp.json` and `targets/opencode/opencode.json`). It's a single server exposing **47 tools across 8 domains**, all registered by `createSentinalServer()` in `src/mcp/server.ts:36`.

> ⚠️ This count was previously stated as "28 tools across 6 domains" and was already wrong before the runtime domain existed — the real pre-Phase-3 figure was **31 across 6** (the Memory table below was missing `memory_update`, `memory_delete` and `memory_share`). `src/mcp/server.test.ts` now asserts registration, so a domain that is never wired in is caught; the COUNT is still hand-maintained.

> **Note:** Sentinal _also_ ships global MCP server configurations for `context7`, `web-search`, `grep-mcp`, and `web-fetch` — those are installed once into the user's Claude Code / OpenCode config by the installer and are NOT documented here.

## Invocation

```jsonc
// targets/claude-code/.mcp.json
{
  "mcpServers": {
    "sentinal": {
      "command": "sentinal",
      "args": ["mcp-server"],
    },
  },
}
```

Equivalent to running `sentinal mcp-server` or `bun run mcp` locally.

## Tool Catalog

### Memory Domain (`src/memory/mcp-tools.ts`) — 9 tools

| Tool              | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `memory_search`   | Semantic + keyword search over SQLite-vec vector store      |
| `memory_timeline` | Chronological context around an anchor observation          |
| `memory_get`      | Fetch full observation details by ID                        |
| `memory_save`     | Save a decision/discovery/error/fix/pattern observation     |
| `memory_update`   | Correct/supersede an observation in place, refreshing it    |
| `memory_delete`   | Delete an observation (destructive, unrecoverable)          |
| `memory_share`    | Promote observations to `.sentinal/project-memory.json`     |
| `memory_maintain` | Maintenance ops (prune, reindex)                            |
| `memory_stats`    | Database statistics (observation counts, project breakdown) |

### Spec Workflow Domain (`src/spec/mcp-tools.ts`) — 10 tools

| Tool                | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `spec_init`         | Get all workflow context in one call                        |
| `spec_status`       | Current active plan, progress, remaining tasks              |
| `spec_register`     | Register/update a plan in the SQLite index                  |
| `spec_plan_parse`   | Parse a plan .md file into structured metadata              |
| `spec_config`       | Read `SENTINAL_*` env config snapshot                       |
| `spec_events`       | Recent lifecycle events for a spec                          |
| `spec_metrics`      | Per-task timing + plan duration (scoped by `project`)       |
| `spec_notify`       | Create a notification (optional `project`, default cwd)     |
| `spec_wait_file`    | Block until a reviewer-output file appears                  |
| `spec_master_audit` | Reconcile a master plan against its child plans (read-only) |

⛔ `spec_master_audit` is **direct-fs and takes no deps**, unlike every other tool in
this domain. It resolves a master's children by their `Parent:` back-link — never by
globbing `<master-slug>-phase-*.md`, which false-positives on spike files and misses
off-convention children. Only `VERIFIED` passes: `COMPLETE` means _implemented,
awaiting verification_, so a fail-list naming only `PENDING`/`IN_PROGRESS`/`DRAFT`
would let the very drift this tool exists to catch through. Do **not** give it a
sidecar route or a `store` dependency — `store` is `null` in production whenever the
sidecar runs, which would make it pass every test and do nothing in the field.

`spec_notify` takes an optional `project` (default: the MCP server's cwd), resolved with
`resolveProjectIdentity` and sent as `projectPath` with `source: "spec-notify"` (D5), so the notice
reaches that project's session-start digest. `spec_metrics` passes its `project` to
`client.getSpecMetrics(id, project)` → `GET /spec/metrics?spec_id=&project=`, which disambiguates a
plan slug that several projects share (D6 — `specs.id` is `<project>::<slug>`; tools accept either
the slug or the stored key).

### TDD Domain (`src/tdd/mcp-tools.ts`) — 3 tools

| Tool            | Purpose                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `tdd_status`    | Read TDD cycle state (per file, or all active **in the current project** — optional `project`) |
| `tdd_set_state` | Transition state: IDLE/TEST_WRITTEN/RED/GREEN                                                  |
| `tdd_clear`     | Clear state for a file or entire spec                                                          |

⛔ **`tdd_status`'s list mode is project-scoped, and fails OPEN (D6 of
`docs/plans/2026-09-23-signals-that-reach-nobody.md`).** `project` is optional and
defaults to `process.cwd()`; it is normalized with `resolveProjectIdentity`, so a
worktree or subdirectory lists its main checkout's cycles. It is scoped on **both**
paths: the store path filters in SQL (`listActiveTddStates(specId, projectPath)`,
which excludes NULL-project rows), while the sidecar path — the one production
actually takes, since `store` is `null` whenever the sidecar runs — now sends the
project too (`client.listActiveTddStates(specId, identity)` →
`GET /tdd-state/list?project=`, which also resolves a shared spec slug to this
project's key) **and still** filters the fetched rows client-side with
`scopeCyclesToProject` (`src/opencode/native-tdd-status.ts`), because a pre-hardening
sidecar ignores the param. That helper drops `projectPath: null` like the store does, but **keeps** a row whose
`projectPath` key is absent entirely (a pre-V13 sidecar cannot say), so an old
sidecar over-reports rather than going silently empty. The OpenCode native
`sentinal_tdd_status` tool scopes the same way from `context.directory`. Do not
make `project` required — that is the write-side rule (`bulkTddTransition`), not this one.

### Worktree Domain (`src/worktree/mcp-tools.ts` + `adopt-mcp-tool.ts`) — 7 tools

| Tool               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `worktree_detect`  | Find worktree for a plan slug                    |
| `worktree_create`  | Create a git worktree for a plan (runs `setup`)  |
| `worktree_ensure`  | Create-or-**adopt** a worktree (another tool's)  |
| `worktree_diff`    | Summarize file changes, insertions, deletions    |
| `worktree_sync`    | Squash-merge worktree back to base (destructive) |
| `worktree_abandon` | Remove (Sentinal-owned) or release (external)    |
| `worktree_cleanup` | Clean up all stale worktrees missing from disk   |

⛔ **A transport failure on a destructive route is NOT evidence the work did not happen** (issue #9).
`worktree_cleanup` and `worktree_abandon` take an optional `idempotency_key`: a repeat within 15
minutes replays the recorded outcome (`src/sidecar/idempotency.ts`) instead of acting again, and the
response is flagged `replayed`. A **rejected** operation is never recorded, so a genuine failure
stays retryable. `worktree_cleanup` additionally returns `removed[]` (path, branch, slug, pass)
alongside `cleaned`, so a retry is a _verified_ no-op rather than an ambiguous `0`.

⛔ `cleaned` is load-bearing for BACK-COMPAT — the deployed OpenCode plugin bundle reads only that
field. `removed` and `replayed` are additive; never make either one replace it.

⛔ **`worktree_sync` does NOT go through the sidecar.** `registerWorktreeSyncTool` calls
`manager.squashMerge()` directly in the MCP process (`mcp-tools.ts`); the client is used only to
_resolve_ the worktree. There is no `/worktree/sync` route, so the client-timeout failure class
cannot reach it — which is why it takes no idempotency key. It is nevertheless listed in
`DESTRUCTIVE_PATHS` (`src/sidecar/client-errors.ts`) so that adding such a route later cannot
silently skip the reconcile warning.

### Analysis Domain (`src/analysis/mcp-tools.ts`) — 4 tools

| Tool                | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `check_diagnostics` | Filtered TypeScript diagnostics with NEW/FIXED delta tracking                        |
| `impact_analysis`   | Expected vs unexpected changes, file-length violations, LOW/MED/HIGH risk            |
| `plan_impact`       | **Prospective** — same-wave file-overlap detection + reach on a plan's claimed files |
| `quality_report`    | tsc/eslint/prettier — auto-fixes ONLY a given `file`; project-wide is report-only    |

⛔ **`quality_report` never rewrites a project (D1 of `docs/plans/2026-09-24-hardening-sweep.md`).**
With `file`, the path is resolved against `project` and **refused outside it**
(`resolveQualityTarget`, `src/sidecar/quality-runners.ts`), then sent to the sidecar as an absolute
path: `eslint --fix <file>`, and `prettier --write <file>` only when `--check` exits **1**
(unformatted) — never on 2 (tool error). Without `file` it is **report-only**: it lists unformatted
files and ESLint error/warning counts, top rules and locations, and modifies nothing. Project-wide,
only `tsc` goes to the sidecar; **eslint/prettier run in-process** (`runQualityChecks`,
`src/analysis/mcp-tools.ts`), never through `/quality-check`, because a ≤1.38 sidecar still in
memory would answer them with `eslint --fix .` / `prettier --write .` (measured: 85 files on this
repo). The argv logic lives in `src/sidecar/quality-lint.ts`, the report shape in
`quality-summary.ts` / `src/analysis/quality-format.ts`. Tests use fake binaries that assert the
exact argv — never the real tools on repo files.

`plan_impact` is the prospective counterpart to `impact_analysis`, which is driven by
`git diff --name-only HEAD` and therefore answers "0 files changed" during planning. Its two halves
have **different epistemic standing and the output says so** (D4): same-wave overlap detection is
deterministic on the plan text, needs no injected `reach` and no code-graph tool, and is the only
enforcement of `spec-plan.md`'s otherwise prose-only rule; prospective reach is bounded by the
accuracy of the plan's `Files:` prediction and is rendered as a hint.

⛔ Reach is scored on **on-disk existence, never the verb**. `countTransitiveImporters` has no node
for a file that does not exist, and half this repo's plan corpus uses an inline `**Files:**` form
that states no verb at all — keying on `Create:` would score a plan of mostly-new files as LOW.
Non-existent targets are reported separately and explicitly unscored.

⛔ **Worktree ownership (`worktrees.owner`, V15).** `sentinal` rows (everything `worktree_create`
makes, and every pre-V15 row) behave as before. `external` rows — adopted with
`worktree_ensure({path, base, owner: "external"})`, e.g. an Orca worktree — are **never deleted by
Sentinal**: `worktree_abandon` _releases_ them (Sentinal's own runtime stopped, only files Sentinal
seeded removed — `worktree.env` unless tracked, `.env` only if untracked and byte-identical to the
rendered template, Sentinal's `.gitignore` entries only under its header — then `abandoned`);
cleanup's default pass marks them terminal without `branch -D`; the force pass skips any path with
an external row in any status (guard 6); `worktree_sync` merges, strips seeded files and marks
`merged` without removing dir or branch. Deleting one needs an explicit takeover
(`worktree_ensure --owner sentinal --path`). `worktree_ensure` is direct (no sidecar route), like
`worktree_create`, and is idempotent by slug; the same path under another slug/owner is
`ALREADY_EXISTS`, never a silent re-own. Setup runs through the injected `WorktreeConfig.runSetup`
(`runtimeWorktreeConfig()`), because `src/worktree` must not import `src/runtime`.

⛔ **Merge location (D3 of `docs/plans/2026-09-28-orca-orchestration.md`).** `worktree_sync`
squash-merges in the worktree that has the base branch checked out (e.g. an Orca coordinator's
checkout), else the main checkout as before; the chosen checkout must be clean for tracked files
(`DIRTY_MAIN_CHECKOUT` names the files). The tool reports `Merged in:`. `manager.squashMerge` still
returns only the commit; `squashMergeDetailed` returns `{commit, mergedIn, outcome}`.

### Orca Domain (`src/orca/mcp-tools*.ts`) — 9 tools

| Tool                   | Purpose                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orca_status`          | Detect Orca, resolve Orca vs subagents (header / `SENTINAL_ORCHESTRATION`), auth                                                                                         |
| `orca_dispatch`        | Ensure a Run; create tasks (deps) and prepared child worktrees — starts nothing                                                                                          |
| `orca_start`           | Start ONE worker (≤45 s budget; `pending` + same `request_id` joins/replays); `retry_of` replaces a stopped/failed attempt; reports `delivery_confirmed`                 |
| `orca_wait`            | One bounded wait (≤40 s + ≤10 s stall checks): `worker_done` + stalls (incl. `never-started`) + `attention` entries (no `evidence_id`) + `reclaimable` terminals; no ack |
| `orca_ack`             | Acknowledge a delivery                                                                                                                                                   |
| `orca_stop`            | **DESTRUCTIVE** — stop a worker; needs a one-shot `evidence_id` from `orca_wait`                                                                                         |
| `orca_abandon`         | **DESTRUCTIVE** — `worker-abandon`, only when `worker-show` reports `stop_unknown` (a stop Orca could not prove); then `retry_of`                                        |
| `orca_release`         | **DESTRUCTIVE** — release a settled worker's terminal                                                                                                                    |
| `orca_remove_worktree` | **DESTRUCTIVE** — `orca worktree rm` (no `--force`)                                                                                                                      |

⛔ **Direct-only, like Runtime**: Orca state lives in the Orca app, so `registerOrcaTools` ignores
`{client, store}` and shells out through one adapter (`src/orca/cli.ts`: parses the LAST JSON
document — mutations print pretty JSON, `check --wait` streams NDJSON keepalives on stderr; never
throws). Tests never run the real `orca` binary: inject the runner and replay
`src/orca/__fixtures__/`. ⛔ **Never stop, release or remove on absence** — `unverifiable` liveness
authorizes nothing; `orca_stop` refuses without a stall verdict (auth error, `exited`, idle past
10 min without `worker_done`, or `never-started`). Every mutation sends a UUID `--retry-request`.
The MCP server inherits `ORCA_TERMINAL_HANDLE` from the agent's Orca terminal; `ensureRun` refuses a
Run bound to another coordinator. MCP tool calls must stay under ~60 s, which is why start and wait
are split and bounded.

⛔ **OpenCode has no transcript** (issue #12, `docs/plans/2026-09-29-orca-dropped-prompt.md`):
`worker-read --source auto` answers `source: "terminal"`, `fallbackReason: "provider_unsupported"`,
and only a terminal tail. Stall evidence for such workers comes from that tail
(`src/orca/stall-terminal.ts`): an auth failure on screen is `auth-error`, and `never-started` (the
brief was dropped) needs ALL of — live liveness, no `worker_done`, the agent's home screen visible,
the dispatch id absent from the joined tail, no heartbeat, and `dispatchedAt` (zone-less UTC,
`parseDispatchedAt`) older than `DEFAULT_NEVER_STARTED_MS` (3 min). `worker-show` is called only for
home-screen suspects and for gap-unverifiable rows (see below). Only OpenCode's home-screen signature was verified live; it needs BOTH the splash logo's top row and the input box's `┃  Ask anything…` placeholder, each at a line start, so an agent that merely prints or quotes the phrase is never taken for the home screen. A tail `auth-error` counts only in the provider's own wording, in the last 8 non-blank lines (the terminal's "final turn"). Every
evidence string is redacted (`redactCapabilities`), because the echoed preamble shows the `dcap_…`
capability. Recovery is `orca_stop`, then `orca_start({…, retry_of: <stopped dispatch>})`.
`orca_start` reports `delivery_confirmed: false` when the receipt says `turnStart`/
`prompt.observation` `unsupported` (OpenCode). `orca_wait` lists `reclaimable` dispatches (from the
same `worker-list`, `terminalState: "reclaimable"`), minus any this session already released.

⛔ **Unverifiable liveness → attention, never a stall** (issue #12 follow-up,
`docs/plans/2026-09-30-orca-unverifiable-never-started.md`). Orca's guide
(`orca skills get orchestration --reference recovery-and-cleanup`) says: "`unverifiable` liveness |
Keep waiting or inspect; never stop, abandon, retry, or release". `resolveLiveness`
(`src/orca/stall-liveness.ts`) follows Orca's precedence: the list's `projection.liveness` first;
for `unverifiable` with a reason in `GAP_REASONS` (`missing_status`, `capability_unsupported` —
client-side gaps), a positive `live`/`exited` verdict from `worker-show` outranks the row (then the
normal stall checks apply, with a normal `evidence_id`); `host_unavailable` (contact loss) never
consults `worker-show`. Anything else resolves to `absent`, which never produces a stall.
`collectStalls` (`src/orca/stall.ts`) therefore calls `worker-show` for gap-unverifiable rows too,
and returns `attention: AttentionEntry[]` beside `stalls`/`reclaimable`; `waitForSettlement` passes
it through (`[]` when stall collection failed). Two kinds:

- **`never-started-unverifiable`** — a brief that was probably dropped while Orca cannot verify the
  agent. Needs ALL of: `absent` liveness with a `GAP_REASONS` reason; the dispatch's **own**
  terminal live (`ownTerminalLive`: `worker-read` `status.liveness: "live"` with `terminal.handle`
  equal to `worker-show`'s `dispatch.assigneeHandle` or `worker.agentTerminalHandle`, OR
  `worker-show` `observation: {status: "live", exactWorker: true}` — PTY liveness, which may inform
  but never authorizes); the home screen; no dispatch id in the tail; no heartbeat; age over 3 min
  (`neverStartedEvidence`, shared with the `never-started` stall).
- **`orca-attention`** — an active row with `projection.attention.requiresAction` and no stall
  verdict, carrying `categories` and `nextAction` (argv or `null`). Rows whose categories are
  exactly `["unverifiable"]` are excluded: every healthy 1.4.209 OpenCode worker carries it.

Attention entries have **no `evidence_id`** and are never stored in `state.verdicts`, so
`orca_stop` refuses them (`stop_refused`). `orca_wait` (`src/orca/mcp-tools-wait.ts`) renders each
dispatch's entry once per session (`state.attentionReported`), never after release, with the Next
hint: tell the user; attention never authorizes `orca_stop`, `orca_abandon` or a retry. The shape
this was built for (Orca 1.4.209, Linux, issue #12): `worker-read` `fallbackReason:
"session_not_reported"`, `status.liveness: "live"` on the worker's own handle, the OpenCode home
screen in the tail, and a projection with `provider: null`, `liveness: unverifiable/missing_status`,
`attention: {categories: ["unverifiable"], requiresAction: true}` and `nextAction: {kind: "none"}`.

⛔ **`stop_unknown` → `orca_abandon`** (Task 9 of `docs/plans/2026-09-29-orca-dropped-prompt.md`, verified
live on 1.4.216): `worker-stop` answers `stop_unknown` when Orca has marked the worker's terminal
`user_owned`/`user_takeover` (seen on an idle OpenCode worker nobody typed into; cause unknown). The
dispatch stays `dispatched`, a second stop is `dispatch_inactive`, and `--retry-of` is refused.
`orca_stop` then names the recovery: ask the user → `orca_abandon` → `orca_start({…, retry_of})`.
`orca_abandon` (`src/orca/mcp-tools-abandon.ts`) is gated on Orca's own `worker-show`
(`worker.state === "stop_unknown"` or stage `stop_outcome_unknown`) — never on absence — so it cannot
abandon a healthy worker, and the gate survives a new session. Abandon fences the dispatch as
`failed` without touching processes or files; the old terminal stays retained.

A failed start's `cleanupAttempt` (`src/orca/dispatch-start.ts`) releases the attempt and **no
longer runs `orca terminal close`** — Orca's guide says never substitute it for release; terminals of
a `retained` release are reported in `unclosedTerminals` (`closedTerminals` stays, always `[]`).

The `orca_*` tools stay Sentinal's own (rather than prose telling agents to run `orca`) because they
enforce the safety floor in code and integrate adoption, VERIFIED and merge. Shipped prose defers
every generic Orca rule (retry, release, stop, the worker contract) to the version-matched guide the
binary serves — `orca skills get orchestration [--reference <file>]` — which needs no installed
skill files.

### Runtime Domain (`src/runtime/mcp-tools.ts` + `lifecycle-mcp-tools.ts`) — 4 tools

| Tool             | Purpose                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `runtime_config` | Resolve/validate/interpolate `.sentinal/runtime.json` (up, readiness, down, isolation)          |
| `runtime_init`   | DRAFT a contract from compose/package.json/Procfile — never writes it                           |
| `runtime_up`     | Spawn `up` detached into an owned process group, write the pidfile, poll `readiness`            |
| `runtime_stop`   | **DESTRUCTIVE** — `down`, then SIGTERM→grace→SIGKILL to **that group only**, ownership-verified |

`runtime_up` / `runtime_stop` live in the sibling `src/runtime/lifecycle-mcp-tools.ts` (with the
preflight in `src/runtime/preflight.ts`) purely for length — `mcp-tools.ts` would have breached 400.
`registerRuntimeTools` calls `registerRuntimeLifecycleTools`, so `src/mcp/server.ts` needs no change
and the "one registration function per domain" rule below still holds.

⛔ **Direct-only, and deliberately so.** Unlike every other domain, `registerRuntimeTools` ignores its
`{client, store}` deps: this is a stateless fs read of a path derived from the tool's own `project`
argument, so the sidecar's warm SQLite/embedding/LSP state buys nothing. (`src/sidecar/client.ts` at
582/600 lines is a second, independent reason.) Do not "fix" the unused deps by adding a route. The
same holds for the two lifecycle tools: the ownership record is a **worktree-local pidfile**, checked
for staleness on read, so there is nothing warm to keep and no sweep to run (D5).

⛔ **`runtime_stop` is the only thing in the codebase that signals a process group**, and it asks
`src/runtime/ownership.ts` first, every time. **Never add a second signalling path.** If ownership
cannot be verified it must REFUSE — an unverifiable PID may have been recycled onto someone else's
process, which is the failure `pkill -f` embodies and this tool exists to replace.

### Project Domain (`src/project/mcp-tools.ts`) — 1 tool

| Tool              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `project_context` | Tech stack, directory layout, key commands, conventions (cached) |

## Design Rules

1. **All tool modules take `{ client, store }`.** If `client` (a `SidecarClient`) is provided, delegate to the sidecar to avoid hot SQLite open. Fall back to direct `store` only when no client is available.
2. **Tools are registered once per server.** `createSentinalServer()` calls all six `registerXxxTools()` functions; adding a new tool means editing the matching `src/<domain>/mcp-tools.ts` and nothing else.
3. **MCP tool names use `snake_case`** (e.g., `memory_search`, not `memorySearch` or `memory-search`). The MCP client prefixes them as `sentinal_<tool>` when surfacing to the agent.
4. **Read-only tools first.** Destructive tools (`worktree_sync`, `memory_maintain`) must be flagged clearly in their description for safety review.

## Testing MCP Tools

```bash
# Start the server manually and send a JSON-RPC request via stdio
bun run mcp

# Or drive it through the sidecar (since tools delegate when client is set)
bun test src/memory/mcp-tools.test.ts
bun test src/spec/mcp-tools.test.ts
```

## Smoke Test Checklist After Adding a Tool

- [ ] Tool registered in `src/<domain>/mcp-tools.ts`
- [ ] Tool appears in `createSentinalServer()` registration chain (via the domain's `registerXxxTools` function)
- [ ] Unit test added in `src/<domain>/mcp-tools.test.ts`
- [ ] Sidecar path added if the tool needs new HTTP routes (see `sentinal-sidecar.md`)
- [ ] Tool respects `{ client, store }` injection pattern
- [ ] Name uses `snake_case`
- [ ] **Counts above updated** — the domain table AND the header figure. Both are hand-maintained; `src/mcp/server.test.ts` asserts that a tool is registered, not how many there are.
- [ ] **`README.md`'s "Sentinal MCP Tool Catalog" updated too** — it carries the same figure and the same per-domain table, and the two drift independently.

### Run record — `runtime_up` / `runtime_stop` (2026-08-09)

| Item                        | Result                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Registered in the domain    | ✅ `lifecycle-mcp-tools.ts`, called by `registerRuntimeTools` (`mcp-tools.ts:52`)                      |
| In `createSentinalServer()` | ✅ via `registerRuntimeTools` (`src/mcp/server.ts:67`) — asserted in `src/mcp/server.test.ts:92-93`    |
| Unit test                   | ✅ `src/runtime/lifecycle-mcp-tools.test.ts` (registration, idempotence, refusal, DESTRUCTIVE wording) |
| Sidecar route               | ➖ **None, by design (D5).** The ownership record is a worktree-local pidfile, not sidecar state       |
| `{client, store}` injection | ➖ Domain is direct-only, as documented above                                                          |
| `snake_case`                | ✅                                                                                                     |
| Counts updated              | ✅ header 33→35, Runtime table 2→4, and the same two in `README.md`                                    |
