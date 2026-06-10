# PLAN: Persistent Memory System

**Status:** VERIFIED

## Overview

Implement a persistent memory system that captures and preserves context across Claude Code and OpenCode sessions. Users maintain continuity across compaction boundaries and between sessions -- decisions, discoveries, and debugging insights are never lost.

## Comparison with Prior Art (Market Research)

Prior art uses a **dual-database architecture**: SQLite for structured storage + ChromaDB for vector embeddings. After detailed analysis of that implementation, here is how Sentinal's approach compares:

| Aspect             | Prior art (market research)                | Sentinal (This Plan)                     |
| ------------------ | ------------------------------------------ | ---------------------------------------- |
| Structured storage | SQLite                                     | SQLite                                   |
| Keyword search     | SQLite FTS5                                | SQLite FTS5                              |
| Semantic search    | ChromaDB (separate process via MCP)        | sqlite-vec (embedded extension)          |
| Embedding model    | ChromaDB default (sentence-transformers)   | Configurable: local (onnxruntime) or API |
| Process model      | Worker service + ChromaDB subprocess + MCP | Single process (SQLite + extension)      |
| Search strategy    | 3-layer progressive disclosure             | 3-layer progressive disclosure (adopted) |
| Document model     | Granular (each field is a separate vector) | Granular (adopted from prior art)        |
| Recency filtering  | 90-day window                              | 90-day window (configurable)             |
| Token savings      | ~10x via progressive disclosure            | ~10x via progressive disclosure          |
| Dual-target        | Claude Code only                           | Claude Code + OpenCode                   |

### Why sqlite-vec over ChromaDB

1. **Zero extra processes** -- sqlite-vec is a loadable SQLite extension, not a separate server. No subprocess management, no MCP bridge, no backfill synchronization.
2. **Single database** -- Vectors live alongside structured data in the same `memory.db`. No sync drift, no dual-write concerns.
3. **Simpler deployment** -- One dependency (`sqlite-vec`) vs ChromaDB + chroma-mcp + uv + sentence-transformers.
4. **Same query power** -- KNN search with cosine/L2 distance, metadata filtering, batch operations.
5. **Better for our use case** -- Sentinal's memory is modest (thousands of observations, not millions). sqlite-vec handles this easily without the overhead of a dedicated vector DB.

### What we adopt from prior art

1. **3-layer progressive disclosure** -- search (index with IDs, ~50-100 tokens/result) → timeline (context around anchor) → get_observations (full details only for filtered IDs). This is a brilliant token-saving pattern.
2. **Granular document model** -- Each observation field (title, content, facts) becomes a separate vector for better retrieval precision.
3. **Hybrid search** -- Vector similarity for semantic queries + FTS5 for keyword/filter queries + SQLite WHERE for metadata filters.
4. **90-day recency window** -- Prevents stale observations from dominating results.
5. **Graceful degradation** -- If embeddings aren't available, fall back to FTS5-only search.

## Goals

1. **Cross-session context preservation** -- Capture decisions, discoveries, and debugging insights
2. **Compaction resilience** -- Restore context after auto-compaction
3. **Semantic search** -- Find relevant observations by meaning, not just keywords
4. **Automatic capture** -- Hook into key events to record insights
5. **Manual capture** -- `/learn` command for explicit knowledge recording
6. **Token efficiency** -- 3-layer progressive disclosure for minimal context usage

## Architecture

### Components

```
src/memory/
  service.ts          # Core CRUD operations, search orchestration
  store.ts            # SQLite connection, migrations, queries
  vector-store.ts     # sqlite-vec integration, embedding management
  embeddings.ts       # Embedding generation (local or API)
  types.ts            # Interfaces and Zod schemas
  capture.ts          # Heuristics for automatic capture
  restore.ts          # Context restoration logic
  search/
    orchestrator.ts   # Strategy selection (hybrid, vector-only, fts-only, filter-only)
    strategies/
      vector.ts       # sqlite-vec semantic search
      fts.ts          # SQLite FTS5 keyword search
      hybrid.ts       # Combined vector + FTS5
      filter.ts       # Metadata-only filtering (no text query)

src/hooks/
  memory-observer.ts  # Claude Code hook for automatic capture
  memory-restore.ts   # Claude Code hook for session restoration

targets/opencode/plugins/
  sentinal.ts         # Extended with memory capture + restore
```

### Database Schema

Location: `~/.sentinal/memory.db`

```sql
-- Core observations table
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,       -- 'decision' | 'discovery' | 'error' | 'fix' | 'pattern'
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  file_paths TEXT,          -- JSON array of related files
  tags TEXT,                -- JSON array of tags/concepts
  metadata TEXT             -- JSON object for extra data
);

-- Sessions tracking
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  project_path TEXT NOT NULL,
  assistant TEXT NOT NULL,  -- 'claude-code' | 'opencode'
  observation_count INTEGER DEFAULT 0,
  summary TEXT
);

-- Full-text search (keyword matching)
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, content, tags, content=observations, content_rowid=id
);

-- Vector embeddings (semantic search)
-- Each observation field gets its own vector document (granular model)
CREATE VIRTUAL TABLE observation_vectors USING vec0(
  doc_id TEXT PRIMARY KEY,     -- 'obs_{id}_title', 'obs_{id}_content', 'obs_{id}_tag_0'
  embedding FLOAT[384],        -- all-MiniLM-L6-v2 produces 384-dim vectors
  +observation_id INTEGER,     -- FK to observations.id
  +field_type TEXT,            -- 'title' | 'content' | 'tag'
  +project TEXT,               -- for project-scoped queries
  +timestamp INTEGER           -- for recency filtering
);

-- Indexes
CREATE INDEX idx_obs_session ON observations(session_id);
CREATE INDEX idx_obs_project ON observations(project_path);
CREATE INDEX idx_obs_type ON observations(type);
CREATE INDEX idx_obs_timestamp ON observations(timestamp);
CREATE INDEX idx_sessions_project ON sessions(project_path);
```

### Embedding Strategy

**Model**: `all-MiniLM-L6-v2` (384 dimensions)

- Small (80MB), fast (<10ms per embedding), good quality
- Runs locally via `onnxruntime-node` -- no API calls, no network dependency
- Same model family used by ChromaDB's default

**Granular document model** (adopted from prior art):
Each observation produces multiple vector documents for better retrieval precision:

| Vector Document ID | Text Embedded       | field_type |
| ------------------ | ------------------- | ---------- |
| `obs_{id}_title`   | observation.title   | `title`    |
| `obs_{id}_content` | observation.content | `content`  |
| `obs_{id}_tag_0`   | tags[0]             | `tag`      |
| `obs_{id}_tag_1`   | tags[1]             | `tag`      |

A query about "database migration" can match a tag document without needing the full content to be the best match.

**Fallback**: If onnxruntime is unavailable, degrade to FTS5-only search (still functional, just not semantic).

### Search Architecture

#### 3-Layer Progressive Disclosure (adopted from prior art)

```
Layer 1: search(query) → Compact index with IDs (~50-100 tokens/result)
Layer 2: timeline(anchor=ID) → Context window around an observation
Layer 3: get_observations([IDs]) → Full details ONLY for filtered IDs

Traditional RAG: 20 full results × 800 tokens = 16,000 tokens
Progressive:     20 indexes + 3 full results  =  3,500 tokens (78% savings)
```

#### Strategy Selection

```typescript
function selectStrategy(params: SearchParams): SearchStrategy {
  if (!params.query) {
    return new FilterStrategy(); // Date range, type, project filters only
  }
  if (!vectorStoreAvailable) {
    return new FTSStrategy(); // FTS5 keyword search (fallback)
  }
  if (params.exactMatch) {
    return new FTSStrategy(); // User wants exact keyword match
  }
  return new HybridStrategy(); // Vector similarity + FTS5 boost
}
```

#### Hybrid Search Algorithm

```typescript
async function hybridSearch(
  query: string,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  // 1. Vector search: semantic similarity via sqlite-vec
  const vectorResults = await vectorStore.search(query, {
    limit: 100,
    project: filters.project,
    recencyWindow: 90 * 24 * 60 * 60 * 1000, // 90 days
  });

  // 2. FTS5 search: keyword matching
  const ftsResults = await ftsSearch(query, filters);

  // 3. Merge and rank
  //    - Deduplicate by observation_id
  //    - Score = (vector_similarity * 0.7) + (fts_rank * 0.3)
  //    - Apply recency boost: more recent = higher score
  return mergeAndRank(vectorResults, ftsResults, filters);
}
```

### Memory Types

| Type        | Description                                     | Example                                                |
| ----------- | ----------------------------------------------- | ------------------------------------------------------ |
| `decision`  | Architecture choices, design pattern selections | "Chose repository pattern for data access layer"       |
| `discovery` | Non-obvious findings, workarounds               | "Angular CDK virtual scroll requires explicit height"  |
| `error`     | Bugs encountered and root causes                | "Race condition in auth middleware when token expires" |
| `fix`       | Solutions to problems                           | "Added mutex lock around token refresh call"           |
| `pattern`   | Recurring solutions, project conventions        | "All DTOs use class-validator with whitelist: true"    |

### Capture Triggers

**Automatic (heuristic-based):**

- Error-fix sequence detected (error log followed by successful edit)
- Significant file changes (new module, architectural file)
- TDD cycle completion (test fail -> implementation -> test pass)
- Build/lint fix sequences
- Configuration changes

**Manual:**

- `/learn` command invocation
- Explicit observation annotations in prompts

### Restoration Strategy

On session start, load the most relevant observations:

1. Last 10 observations from the same project
2. Any active spec/plan state
3. Key decisions from past 30 days
4. Error patterns relevant to current file context

Format as a compact context block injected via:

- Claude Code: `SessionStart` hook output
- OpenCode: `event` handler for `session.created`

## Implementation Steps

### Phase 1: Core Infrastructure

**Files to create:**

- `src/memory/types.ts` -- Interfaces, Zod schemas, constants
- `src/memory/store.ts` -- SQLite connection, migrations, raw queries
- `src/memory/service.ts` -- Business logic, CRUD, search
- `src/memory/store.test.ts` -- Store unit tests
- `src/memory/service.test.ts` -- Service unit tests

**Key interfaces:**

```typescript
interface Observation {
  id: number;
  sessionId: string;
  projectPath: string;
  timestamp: number;
  type: ObservationType;
  title: string;
  content: string;
  filePaths: string[];
  tags: string[];
  metadata: Record<string, unknown>;
}

interface SearchResult {
  id: number;
  title: string;
  type: ObservationType;
  timestamp: number;
  score: number; // relevance score
  estimatedTokens: number; // estimated read cost
  snippet: string; // content preview
}

interface MemoryService {
  addObservation(obs: Omit<Observation, "id">): Promise<Observation>;
  getObservation(id: number): Promise<Observation | null>;
  getObservations(ids: number[]): Promise<Observation[]>;
  search(query: string, filters?: SearchFilters): Promise<SearchResult[]>;
  timeline(anchor: number | string, depth?: number): Promise<TimelineResult>;
  getRecentForProject(
    projectPath: string,
    limit?: number,
  ): Promise<Observation[]>;
  deleteObservation(id: number): Promise<void>;
  startSession(projectPath: string, assistant: string): Promise<Session>;
  endSession(sessionId: string, summary?: string): Promise<void>;
}
```

**Dependencies to add:**

- `better-sqlite3` -- SQLite driver (works with both Node and Bun)
- `@types/better-sqlite3` -- Type definitions
- `sqlite-vec` -- Vector search SQLite extension

### Phase 2: Vector Search Layer

**Files to create:**

- `src/memory/vector-store.ts` -- sqlite-vec operations
- `src/memory/embeddings.ts` -- Embedding generation
- `src/memory/search/orchestrator.ts` -- Strategy selection
- `src/memory/search/strategies/vector.ts`
- `src/memory/search/strategies/fts.ts`
- `src/memory/search/strategies/hybrid.ts`
- `src/memory/search/strategies/filter.ts`
- `src/memory/vector-store.test.ts`
- `src/memory/embeddings.test.ts`

**Embedding generation:**

```typescript
import * as ort from "onnxruntime-node";

class EmbeddingService {
  private session: ort.InferenceSession | null = null;
  private tokenizer: Tokenizer | null = null;

  async initialize(): Promise<void> {
    // Load all-MiniLM-L6-v2 ONNX model
    const modelPath = join(SENTINAL_HOME, "models", "all-MiniLM-L6-v2.onnx");
    this.session = await ort.InferenceSession.create(modelPath);
  }

  async embed(text: string): Promise<Float32Array> {
    // Tokenize + run inference → 384-dim vector
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Batch inference for efficiency
  }
}
```

**sqlite-vec integration:**

```typescript
class VectorStore {
  async addDocument(
    docId: string,
    text: string,
    metadata: VectorMetadata,
  ): Promise<void> {
    const embedding = await this.embeddings.embed(text);
    this.db.run(
      `INSERT INTO observation_vectors(doc_id, embedding, observation_id, field_type, project, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        docId,
        embedding,
        metadata.observationId,
        metadata.fieldType,
        metadata.project,
        metadata.timestamp,
      ],
    );
  }

  async search(
    query: string,
    options: VectorSearchOptions,
  ): Promise<VectorResult[]> {
    const queryEmbedding = await this.embeddings.embed(query);
    const recencyCutoff =
      Date.now() - (options.recencyWindow || 90 * 24 * 60 * 60 * 1000);

    return this.db.all(
      `
      SELECT doc_id, observation_id, field_type, distance
      FROM observation_vectors
      WHERE embedding MATCH ?
        AND k = ?
        AND timestamp > ?
        ${options.project ? "AND project = ?" : ""}
      ORDER BY distance
    `,
      [
        queryEmbedding,
        options.limit || 100,
        recencyCutoff,
        ...(options.project ? [options.project] : []),
      ],
    );
  }
}
```

**Dependencies to add:**

- `onnxruntime-node` -- Local embedding inference
- Model file: `all-MiniLM-L6-v2.onnx` (~80MB, downloaded on first use)

### Phase 3: Capture & Restoration Hooks

**Files to create:**

- `src/memory/capture.ts` -- Capture heuristics and event detection
- `src/hooks/memory-observer.ts` -- Claude Code PostToolUse hook
- `src/hooks/memory-restore.ts` -- Claude Code SessionStart hook
- `src/hooks/memory-observer.test.ts`
- `src/memory/restore.ts` -- Context restoration logic
- `src/memory/restore.test.ts`

**Files to modify:**

- `targets/opencode/plugins/sentinal.ts` -- Add memory capture + restore
- `src/hooks/hooks.json` -- Register new hooks (Claude Code)
- `src/index.ts` -- Export memory module

**Claude Code hook registration:**

```json
{
  "SessionStart": [
    {
      "type": "command",
      "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/memory-restore.js\"",
      "timeout": 5
    }
  ],
  "PostToolUse": [
    {
      "matcher": "Write|Edit|MultiEdit|Bash",
      "hooks": [
        {
          "type": "command",
          "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/memory-observer.js\"",
          "timeout": 5
        }
      ]
    }
  ]
}
```

**Restoration output format:**

```markdown
## Sentinal Memory Context

**Project:** /path/to/project
**Last Session:** 2026-03-08 (45 min, 12 observations)

### Key Decisions

- Chose repository pattern for data access (2026-03-07)
- Using Angular signals over RxJS for component state (2026-03-05)

### Recent Discoveries

- CDK virtual scroll needs explicit container height (2026-03-08)
- NestJS ConfigModule must be imported before TypeOrmModule (2026-03-06)

### Active Issues

- Race condition in auth token refresh (investigating)
```

### Phase 4: MCP Server & CLI

**Files to create:**

- `src/memory/mcp-server.ts` -- MCP server exposing memory tools
- `src/memory/cli.ts` -- CLI commands

**MCP tools (3-layer progressive disclosure):**

```typescript
const tools = [
  {
    name: "memory_search",
    description:
      "Search memory. Returns compact index with IDs. Use memory_get for full details.",
    // Returns: | ID | Time | Type | Title | ~Tokens |
  },
  {
    name: "memory_timeline",
    description:
      "Get chronological context around an observation or timestamp.",
    // Returns: observations before and after the anchor point
  },
  {
    name: "memory_get",
    description:
      "Fetch full observation details by IDs. Only call after filtering with search/timeline.",
    // Returns: full observation content for specified IDs
  },
  {
    name: "memory_save",
    description: "Manually save an observation to memory.",
  },
];
```

**CLI commands:**

```bash
sentinal memory search "auth token"
sentinal memory list --project . --type decision --limit 20
sentinal memory timeline --anchor 42 --depth 5
sentinal memory get 42 43 44
sentinal memory export --format json > memories.json
sentinal memory stats
sentinal memory prune --older-than 90d
```

### Phase 5: /learn Command Enhancement

**Files to modify:**

- `templates/commands/learn.md` -- Enhanced with memory integration

**Learn workflow:**

1. User invokes `/learn` or `/learn <topic>`
2. AI summarizes the key insight
3. AI proposes observation type and tags
4. AI calls `memory_save` MCP tool to persist
5. Embedding generated and indexed automatically
6. Confirmation with observation ID returned

## Technical Considerations

### Performance

- Async capture -- never block the main tool flow
- Connection pooling -- reuse SQLite connections
- Batch writes -- group rapid-fire observations
- Batch embeddings -- embed multiple texts in one inference call
- Index strategy -- cover common query patterns
- Pagination -- limit result sets
- Lazy model loading -- only load ONNX model on first search

### Privacy & Security

- Local-only storage -- no cloud sync, no API calls for embeddings
- Sanitization -- strip secrets/credentials from content
- Configurable retention -- auto-prune old observations
- Opt-out -- disable memory entirely via config
- Model runs locally -- no data leaves the machine

### Cross-Platform

- Use `better-sqlite3` for Node/Bun compatibility
- `sqlite-vec` loadable extension (prebuilt binaries for macOS, Linux, Windows)
- `onnxruntime-node` (prebuilt for all platforms)
- OS-agnostic paths via `node:path`
- XDG base directory support on Linux
- `~/Library/Application Support` on macOS

### Data Integrity

- WAL mode for concurrent reads
- Foreign key constraints
- FTS rebuild on corruption
- Vector index rebuild on corruption
- Backup before migration

### Graceful Degradation

| Component Missing         | Behavior                                 |
| ------------------------- | ---------------------------------------- |
| sqlite-vec not available  | FTS5-only search (keyword matching)      |
| onnxruntime not available | FTS5-only search (no embeddings)         |
| ONNX model not downloaded | Prompt to download, fall back to FTS5    |
| Both missing              | Filter-only search (date, type, project) |

## Success Metrics

| Metric                    | Target                                      |
| ------------------------- | ------------------------------------------- |
| Context retention         | 90%+ of key decisions preserved             |
| Compaction recovery       | <5s to restore working context              |
| Semantic search relevance | 80%+ relevant results in top 5              |
| FTS5 search relevance     | 60%+ relevant results in top 5              |
| Capture latency           | <50ms per observation (async)               |
| Embedding latency         | <10ms per text (local ONNX)                 |
| Storage efficiency        | <5MB per 1000 observations (with vectors)   |
| Token savings             | 70%+ reduction vs naive full-text retrieval |

## Risks & Mitigations

| Risk                        | Mitigation                                                            |
| --------------------------- | --------------------------------------------------------------------- |
| Storage bloat from vectors  | Auto-prune, 90-day recency, configurable retention                    |
| Performance impact          | Async capture, lazy model loading, batch operations                   |
| Privacy concerns            | Local-only, local embeddings, no API calls                            |
| Capture noise               | Heuristic tuning, confidence thresholds                               |
| SQLite locking              | WAL mode, connection pooling, retry logic                             |
| ONNX model size (80MB)      | Download on first use, graceful degradation without it                |
| sqlite-vec platform support | Prebuilt binaries available; FTS5 fallback if missing                 |
| Embedding quality           | all-MiniLM-L6-v2 is well-tested; configurable model path for upgrades |

## Future Enhancements

1. **Configurable embedding models** -- Swap models via config (e.g., larger models for better quality)
2. **API-based embeddings** -- Optional OpenAI/Anthropic embeddings for users who prefer cloud
3. **Cross-project memory** -- Link observations across related projects
4. **Memory consolidation** -- AI-driven deduplication and summarization of old observations
5. **Team sharing** via Git sync of exported observations
6. **Smart Explore tools** (like prior art's smart_search/smart_outline/smart_unfold) -- AST-based code navigation via tree-sitter
