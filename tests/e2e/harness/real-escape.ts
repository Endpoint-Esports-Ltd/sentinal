// Real-dir escape backstop for the E2E sandbox (split out of sandbox.ts).
//
// snapshotRealDirs / assertNoRealEscape look for writes ATTRIBUTABLE to a
// sandbox — so the user's live sidecar can keep writing during a run — plus a
// content hash of static user config. SENTINAL_E2E_STRICT_ESCAPE=1 restores a
// full check. Import through ./sandbox.ts.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir, homedir } from "node:os";
import { join, sep } from "node:path";
import { createHash } from "node:crypto";

/** Session ids the e2e suites send; a real-DB row carrying one is an escape. */
export const E2E_TEST_SESSION_IDS = [
  "e2e-session",
  "owner-A",
  "session-B",
] as const;

// Every sandbox HOME (and its realpath) and id created by this process. The
// escape backstop searches real logs for these.
const SANDBOX_MARKERS = new Set<string>();

export function homeVariants(home: string): string[] {
  const out = [home];
  try {
    const real = realpathSync(home);
    if (real !== home) out.push(real);
  } catch {
    /* already gone */
  }
  return out;
}

/** Record a sandbox so real logs naming its HOME or id count as an escape. */
export function registerSandboxMarkers(home: string, id: string): void {
  for (const h of homeVariants(home)) SANDBOX_MARKERS.add(h);
  SANDBOX_MARKERS.add(id);
}

function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

// ── Escape backstop: tree fingerprints ───────────────────────────────────────

/**
 * Fingerprint a tree (sorted paths + file contents). Top-level entries named in
 * `statOnlyTop` contribute path+size+mtime instead of content (huge, static
 * dirs such as bin/, deps/, models/). Returns "<absent>" for a missing path.
 */
function fingerprintTree(
  root: string,
  statOnlyTop: ReadonlySet<string> = new Set(),
  statOnly = false,
): string {
  if (!existsSync(root)) return "<absent>";
  const h = createHash("sha256");
  const walk = (dir: string, statMode: boolean, top: boolean) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return; // unreadable → skip (permission dirs like keychain)
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const s = statMode || (top && statOnlyTop.has(name));
      h.update(full);
      if (st.isDirectory()) walk(full, s, false);
      else if (st.isFile()) hashFile(h, full, st, s);
    }
  };
  const st = statSync(root);
  if (st.isDirectory()) walk(root, statOnly, true);
  else hashFile(h, root, st, statOnly);
  return h.digest("hex");
}

function hashFile(
  h: ReturnType<typeof createHash>,
  full: string,
  st: { size: number; mtimeMs: number },
  statMode: boolean,
): void {
  if (statMode) {
    h.update(`${st.size}:${st.mtimeMs}`);
    return;
  }
  try {
    h.update(readFileSync(full));
  } catch {
    h.update("<unreadable>");
  }
}

/** Content-hash a directory tree or file; "<absent>" when it does not exist. */
export function hashTree(root: string): string {
  return fingerprintTree(root);
}

// ── Escape backstop: snapshot + assert ───────────────────────────────────────

const STAT_ONLY = new Set(["bin", "deps", "models"]);
// Static config the installer writes; everything else in these dirs is live.
const STATIC_CLAUDE = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  ".mcp.json",
  "rules",
  "commands",
  "agents",
  "skills",
  "hooks",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json",
  "plugins/sentinal-marketplace",
];
const STATIC_OPENCODE = [
  "opencode.json",
  "opencode.jsonc",
  "AGENTS.md",
  "package.json",
  "agents",
  "commands",
  "rules",
  "skills",
  "plugins",
  "tools",
];
const RC_FILES = [".bashrc", ".zshrc", ".config/fish/config.fish", ".npmrc"];

export interface SnapshotOptions {
  /** The "real" HOME to snapshot (default os.homedir()). */
  home?: string;
  /** Full check (default: SENTINAL_E2E_STRICT_ESCAPE=1). */
  strict?: boolean;
}

/**
 * Snapshot the real user state an escaped sandbox could write.
 *
 * Default mode tolerates the user's LIVE Sentinal (sidecar logs, WAL frames,
 * its own DB rows) and checks only ATTRIBUTABLE writes: log bytes appended
 * after the snapshot that name a sandbox HOME/id, and real-DB rows keyed to a
 * sandbox or tmpdir path or a test session id (count comparison, so an escape
 * that logs no sandbox path is still caught). Static user config is hashed;
 * ~/.sentinal/{bin,deps,models} are stat-fingerprinted.
 *
 * SENTINAL_E2E_STRICT_ESCAPE=1 additionally fingerprints the WHOLE real trees
 * (bin/deps/models stat-only) — only usable with no live Sentinal running.
 *
 * The result is a flat `kind:path → value` map (assignable to the historical
 * Record<string, string>); pass it to assertNoRealEscape.
 */
export function snapshotRealDirs(
  opts: SnapshotOptions = {},
): Record<string, string> {
  const home = opts.home ?? homedir();
  const strict = opts.strict ?? process.env.SENTINAL_E2E_STRICT_ESCAPE === "1";
  const sentinal = join(home, ".sentinal");
  const claudeDirs = new Set([join(home, ".claude")]);
  if (!opts.home && process.env.CLAUDE_CONFIG_DIR) {
    claudeDirs.add(process.env.CLAUDE_CONFIG_DIR);
  }
  const opencode = join(home, ".config", "opencode");
  const snap: Record<string, string> = {};
  const add = (kind: string, p: string) => {
    snap[`${kind}:${p}`] = fingerprint(kind, p);
  };

  for (const rc of RC_FILES) add("hash", join(home, rc));
  if (strict) {
    for (const d of claudeDirs) add("strict", d);
    for (const d of [opencode, join(home, ".opencode"), sentinal]) {
      add("strict", d);
    }
  } else {
    for (const d of claudeDirs) {
      for (const f of STATIC_CLAUDE) add("hash", join(d, f));
    }
    for (const f of STATIC_OPENCODE) add("hash", join(opencode, f));
    add("hash", join(home, ".opencode", "package.json"));
    add("stat", join(home, ".opencode", "bin"));
    add("hash", join(sentinal, "config.json"));
    for (const d of STAT_ONLY) add("stat", join(sentinal, d));
  }
  add("logdir", sentinal);
  for (const name of listLogs(sentinal)) add("log", join(sentinal, name));
  add("db", join(sentinal, "memory.db"));
  return snap;
}

function fingerprint(kind: string, p: string): string {
  switch (kind) {
    case "strict":
      return fingerprintTree(p, STAT_ONLY);
    case "stat":
      return fingerprintTree(p, new Set(), true);
    case "logdir":
      return JSON.stringify(listLogs(p));
    case "log":
      return String(existsSync(p) ? statSync(p).size : 0);
    case "db":
      return dbFingerprint(p);
    default:
      return fingerprintTree(p);
  }
}

export function assertNoRealEscape(before: Record<string, string>): void {
  for (const [key, prev] of Object.entries(before)) {
    const m = /^(hash|stat|strict|log|logdir|db):(.*)$/s.exec(key);
    const kind = m?.[1] ?? "hash"; // bare path = legacy { path: hash }
    const path = m?.[2] ?? key;
    if (kind === "log") {
      checkAppended(path, Number(prev));
    } else if (kind === "logdir") {
      const old = new Set(JSON.parse(prev) as string[]);
      for (const n of listLogs(path))
        if (!old.has(n)) checkAppended(join(path, n), 0);
    } else if (kind === "db") {
      const now = dbFingerprint(path);
      if (now !== prev) throw dbEscapeError(path, prev, now);
    } else if (fingerprint(kind, path) !== prev) {
      throw new Error(
        `Sandbox escape detected: real path "${path}" changed during the e2e run`,
      );
    }
  }
}

function listLogs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".log"))
      .sort();
  } catch {
    return [];
  }
}

/** Throw if bytes written to `path` after `offset` name a sandbox HOME/id. */
function checkAppended(path: string, offset: number): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  const start = size >= offset ? offset : 0; // truncated/rotated → rescan
  if (size === start) return;
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf-8");
  for (const marker of SANDBOX_MARKERS) {
    if (text.includes(marker)) {
      throw new Error(
        `Sandbox escape detected: real log "${path}" gained output naming sandbox "${marker}"`,
      );
    }
  }
}

// ── Escape backstop: read-only real-DB check ─────────────────────────────────

const DB_TABLES = [
  "observations",
  "sessions",
  "specs",
  "spec_events",
  "spec_tasks",
  "worktrees",
  "notifications",
  "tdd_cycles",
];
const PATH_COLUMNS = [
  "project_path",
  "worktree_path",
  "plan_file",
  "file_path",
  "transcript_path",
];

function tmpPrefixes(): string[] {
  const base = withSep(tmpdir());
  const out = new Set([base, "/tmp/", "/private/tmp/"]);
  try {
    out.add(withSep(realpathSync(tmpdir())));
  } catch {
    /* keep the rest */
  }
  return [...out];
}

/**
 * Per-table counts of rows keyed to a tmpdir path / a sandbox path / a test
 * session id, as "tmp/e2e/sid". Opened READ-ONLY: with a live WAL the reader
 * never checkpoints (it cannot write); with no WAL it opens `immutable=1` so
 * SQLite creates no -wal/-shm. Never opened read-write.
 */
function dbFingerprint(dbPath: string): string {
  if (!existsSync(dbPath)) return "<absent>";
  const live = existsSync(`${dbPath}-wal`) && existsSync(`${dbPath}-shm`);
  const uri =
    "file:" +
    encodeURI(dbPath).replace(/\?/g, "%3F").replace(/#/g, "%23") +
    (live ? "?mode=ro" : "?mode=ro&immutable=1");
  let db: Database | null = null;
  try {
    db = new Database(uri, { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const counts: Record<string, string> = {};
    const exists = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    for (const table of DB_TABLES) {
      if (!exists.get(table)) continue;
      counts[table] = tableCounts(db, table);
    }
    return JSON.stringify(counts);
  } catch (err) {
    return `<unreadable: ${(err as Error).message}>`;
  } finally {
    db?.close();
  }
}

function tableCounts(db: Database, table: string): string {
  const cols = (
    db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  ).map((c) => c.name);
  const pathCols = cols.filter((c) => PATH_COLUMNS.includes(c));
  const sidCols = cols.filter(
    (c) => c === "session_id" || (table === "sessions" && c === "id"),
  );
  const count = (where: string, params: string[]): number =>
    where
      ? ((
          db
            .query(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`)
            .get(...params) as { n: number }
        ).n ?? 0)
      : 0;
  const prefixes = tmpPrefixes();
  const tmpWhere = pathCols
    .flatMap((c) => prefixes.map(() => `instr("${c}", ?) = 1`))
    .join(" OR ");
  const tmpParams = pathCols.flatMap(() => prefixes);
  const e2eWhere = pathCols
    .map((c) => `instr("${c}", '/sentinal-e2e-') > 0`)
    .join(" OR ");
  const ids = E2E_TEST_SESSION_IDS.map(() => "?").join(", ");
  const sidWhere = sidCols.map((c) => `"${c}" IN (${ids})`).join(" OR ");
  const sidParams = sidCols.flatMap(() => [...E2E_TEST_SESSION_IDS]);
  return [
    count(tmpWhere, tmpParams),
    count(e2eWhere, []),
    count(sidWhere, sidParams),
  ].join("/");
}

function dbEscapeError(path: string, prev: string, now: string): Error {
  let detail = `${prev} → ${now}`;
  try {
    const a = JSON.parse(prev) as Record<string, string>;
    const b = JSON.parse(now) as Record<string, string>;
    detail = Object.keys(b)
      .filter((t) => a[t] !== b[t])
      .map((t) => `table "${t}" tmp/e2e/sid ${a[t] ?? "-"} → ${b[t]}`)
      .join("; ");
  } catch {
    /* unreadable on one side — keep the raw values */
  }
  return new Error(
    `Sandbox escape detected: real DB "${path}" gained rows keyed to a ` +
      `sandbox/tmpdir path or a test session id: ${detail}`,
  );
}
