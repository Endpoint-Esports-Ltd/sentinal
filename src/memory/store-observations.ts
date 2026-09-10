/**
 * Memory Store — observations
 *
 * The observation CRUD / FTS search / timeline half of `MemoryStore`, split
 * out of `store.ts` purely for file length (Task 6a of
 * docs/plans/2026-09-01-audit-high-remediation.md). `MemoryStore` extends
 * this, so callers still see a single class with every method on it — same
 * inverted-inheritance precedent as `src/sidecar/client-routes.ts`.
 *
 * This file is only ever imported by `store.ts`; it is not part of the
 * public API surface.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import type {
  Observation,
  CreateObservation,
  SearchFilters,
  ObservationType,
  RawObservation,
} from "./types.js";
import { SEARCH_CONSTANTS } from "./types.js";
import { MemoryStoreSessions } from "./store-sessions.js";

export abstract class MemoryStoreObservations extends MemoryStoreSessions {
  // ─── Observations CRUD ────────────────────────────────────────────────

  insertObservation(obs: CreateObservation): Observation {
    const confidence =
      typeof obs.metadata?.confidence === "number"
        ? obs.metadata.confidence
        : null;
    const qualityScore =
      confidence != null && confidence > 0 && confidence <= 1
        ? confidence
        : 1.0;

    const stmt = this.db.prepare(`
      INSERT INTO observations (session_id, project_path, timestamp, type, title, content, file_paths, tags, metadata, quality_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.sessionId,
      obs.projectPath,
      obs.timestamp,
      obs.type,
      obs.title,
      obs.content,
      JSON.stringify(obs.filePaths),
      JSON.stringify(obs.tags),
      JSON.stringify(obs.metadata),
      qualityScore,
    );

    return this.getObservation(Number(result.lastInsertRowid))!;
  }

  getObservation(id: number): Observation | null {
    const row = this.db
      .prepare("SELECT * FROM observations WHERE id = ?")
      .get(id) as RawObservation | null;
    return row ? this.deserializeObservation(row) : null;
  }

  getObservations(ids: number[]): Observation[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`)
      .all(...ids) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  deleteObservation(id: number): boolean {
    // Check existence first because bun:sqlite result.changes includes trigger-generated changes (FTS)
    const exists = this.db
      .prepare("SELECT 1 FROM observations WHERE id = ?")
      .get(id);
    if (!exists) return false;
    this.db.prepare("DELETE FROM observations WHERE id = ?").run(id);
    return true;
  }

  /**
   * Update an existing observation's content fields and RESET its staleness:
   * `timestamp` → now and `quality_score` → fresh (same derivation as insert).
   * This is what lets a correction supersede the original instead of appending
   * a new "CORRECTION" observation. FTS stays in sync automatically via the
   * `observations_au` AFTER UPDATE trigger — do not touch `observations_fts`.
   * Returns the updated observation, or null if `id` doesn't exist.
   *
   * NOTE: this is the raw store primitive. Callers that must keep the vector
   * index in sync should use `MemoryService.updateObservation` (remove + re-add).
   */
  updateObservation(
    id: number,
    patch: {
      title?: string;
      content?: string;
      type?: ObservationType;
      tags?: string[];
      filePaths?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Observation | null {
    const existing = this.getObservation(id);
    if (!existing) return null;

    // Reset quality the same way insertObservation does (confidence in [0,1]
    // else fresh 1.0), using the incoming metadata if provided, else existing.
    const metadata = patch.metadata ?? existing.metadata;
    const confidence =
      typeof metadata?.confidence === "number" ? metadata.confidence : null;
    const qualityScore =
      confidence != null && confidence > 0 && confidence <= 1
        ? confidence
        : 1.0;

    const next = {
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      type: patch.type ?? existing.type,
      tags: patch.tags ?? existing.tags,
      filePaths: patch.filePaths ?? existing.filePaths,
      metadata,
    };

    this.db
      .prepare(
        `UPDATE observations
         SET title = ?, content = ?, type = ?, file_paths = ?, tags = ?, metadata = ?,
             timestamp = ?, quality_score = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.content,
        next.type,
        JSON.stringify(next.filePaths),
        JSON.stringify(next.tags),
        JSON.stringify(next.metadata),
        Date.now(),
        qualityScore,
        id,
      );

    return this.getObservation(id);
  }

  getRecentForProject(
    projectPath: string,
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
  ): Observation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM observations WHERE project_path = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(projectPath, limit) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  // ─── FTS Search ───────────────────────────────────────────────────────

  searchFTS(query: string, filters: SearchFilters): Observation[] {
    let sql = `
      SELECT o.*, rank
      FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
    `;
    const params: SQLQueryBindings[] = [query];

    sql += this.buildFilterClauses(filters, params);
    sql += ` ORDER BY ${filters.orderBy === "date_desc" ? "o.timestamp DESC" : filters.orderBy === "date_asc" ? "o.timestamp ASC" : "rank"} `;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(filters.limit, filters.offset);

    const rows = this.db.prepare(sql).all(...params) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  // ─── Filter-Only Search ───────────────────────────────────────────────

  searchFilters(filters: SearchFilters): Observation[] {
    let sql = `SELECT * FROM observations o WHERE 1=1`;
    const params: SQLQueryBindings[] = [];

    sql += this.buildFilterClauses(filters, params);
    sql += ` ORDER BY ${filters.orderBy === "date_asc" ? "o.timestamp ASC" : "o.timestamp DESC"} `;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(filters.limit, filters.offset);

    const rows = this.db.prepare(sql).all(...params) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  // ─── Timeline ─────────────────────────────────────────────────────────

  getTimelineAround(
    anchorId: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    projectPath?: string,
  ): {
    anchor: Observation | null;
    before: Observation[];
    after: Observation[];
  } {
    const anchor = this.getObservation(anchorId);
    if (!anchor) return { anchor: null, before: [], after: [] };

    let beforeSql = `SELECT * FROM observations WHERE timestamp < ? `;
    let afterSql = `SELECT * FROM observations WHERE timestamp > ? `;
    const beforeParams: SQLQueryBindings[] = [anchor.timestamp];
    const afterParams: SQLQueryBindings[] = [anchor.timestamp];

    if (projectPath) {
      beforeSql += ` AND project_path = ?`;
      afterSql += ` AND project_path = ?`;
      beforeParams.push(projectPath);
      afterParams.push(projectPath);
    }

    beforeSql += ` ORDER BY timestamp DESC LIMIT ?`;
    afterSql += ` ORDER BY timestamp ASC LIMIT ?`;
    beforeParams.push(depthBefore);
    afterParams.push(depthAfter);

    const before = (
      this.db.prepare(beforeSql).all(...beforeParams) as RawObservation[]
    )
      .map((r) => this.deserializeObservation(r))
      .reverse();

    const after = (
      this.db.prepare(afterSql).all(...afterParams) as RawObservation[]
    ).map((r) => this.deserializeObservation(r));

    return { anchor, before, after };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private buildFilterClauses(
    filters: SearchFilters,
    params: SQLQueryBindings[],
  ): string {
    let sql = "";

    if (filters.project) {
      sql += ` AND o.project_path = ?`;
      params.push(filters.project);
    }
    if (filters.type) {
      sql += ` AND o.type = ?`;
      params.push(filters.type);
    }
    if (filters.types && filters.types.length > 0) {
      const placeholders = filters.types.map(() => "?").join(",");
      sql += ` AND o.type IN (${placeholders})`;
      params.push(...filters.types);
    }
    if (filters.dateStart) {
      sql += ` AND o.timestamp >= ?`;
      params.push(filters.dateStart);
    }
    if (filters.dateEnd) {
      sql += ` AND o.timestamp <= ?`;
      params.push(filters.dateEnd);
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        sql += ` AND o.tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }

    return sql;
  }

  private deserializeObservation(row: RawObservation): Observation {
    return {
      id: row.id,
      sessionId: row.session_id,
      projectPath: row.project_path,
      timestamp: row.timestamp,
      type: row.type as ObservationType,
      title: row.title,
      content: row.content,
      filePaths: JSON.parse(row.file_paths || "[]"),
      tags: JSON.parse(row.tags || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      qualityScore: row.quality_score ?? 1.0,
    };
  }
}
