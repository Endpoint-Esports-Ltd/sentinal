/**
 * Draft a `.sentinal/runtime.json` from what the project already declares
 * (D9). Offered by `/sync`; **never written without human review.**
 *
 * ## Why a scaffolder at all
 *
 * The contract is project-authored, which makes adoption the entire ballgame —
 * a schema nobody writes a file for delivers nothing. So Sentinal drafts from
 * `docker-compose.yml`, `package.json` scripts and `Procfile`, and the human
 * edits and commits it. Sentinal scaffolds; it does not own the file.
 *
 * ## ⛔ The rule that decides what gets drafted
 *
 * **Draft the fields whose errors are LOUD; never the field whose errors are
 * SILENT.**
 *
 * | Field       | A wrong value produces            | Draft it? |
 * | ----------- | --------------------------------- | --------- |
 * | `up`        | an error, or a readiness timeout  | ✅        |
 * | `readiness` | a timeout, with the log tail      | ✅        |
 * | `down`      | a visible teardown failure        | ✅        |
 * | `isolation` | a confident, silent green light   | ⛔ never  |
 *
 * ## ⛔ The `isolation` map is OMITTED, not defaulted
 *
 * Not "emit `shared`" or "emit `none`" — **every** value is unsafe or
 * redundant:
 *
 * | Value      | Safe to infer?                                                        |
 * | ---------- | --------------------------------------------------------------------- |
 * | `isolated` | **No.** A `db` service in compose does not mean the project name is    |
 * |            | slot-parameterised. That is a false all-clear (R13).                   |
 * | `none`     | **No.** Inferring "no cache exists" from "no cache seen" is            |
 * |            | absence-of-evidence; a real shared cache would have its gate suppressed.|
 * | `shared`   | **No.** The scaffolder cannot know the claim is true, so it would      |
 * |            | manufacture a FALSE BLOCK on every run — alarm fatigue, and blocking   |
 * |            | is reserved for a deliberate human declaration.                        |
 *
 * Omission is **fail-safe because omission means `unknown`, and `unknown`
 * never blocks**. A scaffolded file is therefore exactly as non-interrupting
 * as no file, while still delivering the `up`/`down`/`readiness` value.
 *
 * Detected resource classes are returned in {@link ScaffoldResult.detectedResources}
 * so `/sync` can **say them out loud in the conversation** — where a human is
 * paying attention — rather than writing them into a file, which people accept
 * without reading.
 *
 * ## On the compose "parser"
 *
 * This is an indentation scan, not a YAML parser: it wants service names,
 * `image:` values and published `ports:`, and nothing else. A partial or wrong
 * read is acceptable *here specifically* because the output is a DRAFT a human
 * reviews, and because every field it produces fails loudly. Adding a YAML
 * dependency to improve a draft would be a poor trade.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePackageDirs } from "../worktree/seed-sources.js";
import { RUNTIME_CONFIG_RELATIVE_PATH } from "./schema.js";

// The draft is JSONC by construction (see `jsonc.ts`). Re-exported so callers
// of the scaffolder can round-trip its output without a second import.
export { stripJsonComments } from "./jsonc.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  /** The JSONC text to offer the human. Never written by this function. */
  content: string;
  /** Where the draft would go, repo-relative. */
  targetRel: string;
  /** Repo-relative files actually inspected. */
  sources: string[];
  /**
   * Resource classes detected in the project. ⛔ Report these in the `/sync`
   * CONVERSATION — they are deliberately absent from {@link content}.
   */
  detectedResources: string[];
  /** Human-facing notes to read out alongside the draft. */
  notes: string[];
}

interface Inference {
  up?: string;
  down?: string;
  detached?: boolean;
  port?: number;
}

// ─── Resource classification ────────────────────────────────────────────────

/** image-name fragment → resource class. Deliberately conservative. */
const IMAGE_CLASSES: ReadonlyArray<[RegExp, string]> = [
  [/postgres|mysql|mariadb|mongo|cockroach|mssql|oracle/i, "database"],
  [/redis|memcached|valkey|dragonfly/i, "cache"],
  [/rabbitmq|kafka|nats|activemq|pulsar/i, "queue"],
  [/minio|localstack|ceph|garage/i, "objectStorage"],
  [/elasticsearch|opensearch|meilisearch|typesense|solr/i, "searchIndex"],
  [/mailhog|mailpit|maildev|mailcatcher/i, "outboundEmail"],
];

function classify(images: string[]): string[] {
  const found = new Set<string>();
  for (const image of images) {
    for (const [re, cls] of IMAGE_CLASSES) {
      if (re.test(image)) found.add(cls);
    }
  }
  return [...found];
}

// ─── Compose scanning ───────────────────────────────────────────────────────

const COMPOSE_FILENAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

/** Every `image:` value and the first published host port. */
function scanCompose(text: string): { images: string[]; port?: number } {
  const images: string[] = [];
  for (const m of text.matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm)) {
    images.push(m[1]!);
  }

  // Published ports look like `- "3000:3000"`, `- 3000:3000`, or
  // `- "127.0.0.1:3000:3000"`. The HOST side is what a probe can reach, and
  // for the 3-part form that is the middle field.
  let port: number | undefined;
  for (const m of text.matchAll(/^\s*-\s*["']?([0-9.:]+)["']?\s*$/gm)) {
    const parts = m[1]!.split(":");
    const host = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const n = Number(host);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      port = n;
      break;
    }
  }
  return { images, port };
}

// ─── Port extraction from a command string ──────────────────────────────────

/** `PORT=4000 node x`, `--port 4000`, `-p 4000`. Never invented. */
function portFromCommand(cmd: string): number | undefined {
  const m =
    /\bPORT=(\d{2,5})\b/.exec(cmd) ??
    /--port[= ](\d{2,5})\b/.exec(cmd) ??
    /\s-p\s+(\d{2,5})\b/.exec(cmd);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 65536 ? n : undefined;
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** The repo root plus every workspace package root, repo-relative. */
function searchDirs(repoRoot: string): string[] {
  return [".", ...workspacePackageDirs(repoRoot)];
}

function readIfExists(repoRoot: string, rel: string): string | null {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

const relOf = (dir: string, name: string) =>
  dir === "." ? name : `${dir}/${name}`;

// ─── The draft ──────────────────────────────────────────────────────────────

/**
 * Inspect a project and draft a runtime contract for human review.
 *
 * Precedence for `up` is compose → `package.json` → `Procfile`: compose is the
 * fullest description of a stack, so when it exists it is what "start the
 * project" means. Only ONE `up` is drafted; combining them would invent a
 * lifecycle nobody declared.
 *
 * ⛔ Never emits `up` without `readiness`. A draft that fails its own schema is
 * worse than no draft — the human commits it and their next verify run errors
 * on their own config.
 */
export function scaffoldRuntimeConfig(repoRoot: string): ScaffoldResult {
  const sources: string[] = [];
  const images: string[] = [];
  const notes: string[] = [];
  let inference: Inference = {};

  // ── Pass 1: compose, at the root and in every workspace package ──────────
  for (const dir of searchDirs(repoRoot)) {
    for (const name of COMPOSE_FILENAMES) {
      const rel = relOf(dir, name);
      const text = readIfExists(repoRoot, rel);
      if (text === null) continue;
      sources.push(rel);
      const scan = scanCompose(text);
      images.push(...scan.images);
      if (!inference.up) {
        inference = {
          up: "docker compose up -d",
          down: "docker compose down",
          detached: true,
          port: scan.port,
        };
      } else if (inference.port === undefined) {
        inference.port = scan.port;
      }
    }
  }

  // ── Pass 2: package.json scripts ─────────────────────────────────────────
  for (const dir of searchDirs(repoRoot)) {
    const rel = relOf(dir, "package.json");
    const text = readIfExists(repoRoot, rel);
    if (text === null) continue;
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(text).scripts ?? {}) as Record<string, string>;
    } catch {
      continue;
    }
    const name = ["dev", "start", "serve"].find((s) => scripts[s]);
    if (!name) continue;
    sources.push(rel);
    if (inference.up) continue;
    inference = {
      up: `npm run ${name}`,
      detached: false,
      port: portFromCommand(scripts[name]!),
    };
  }

  // ── Pass 3: Procfile ─────────────────────────────────────────────────────
  for (const dir of searchDirs(repoRoot)) {
    const rel = relOf(dir, "Procfile");
    const text = readIfExists(repoRoot, rel);
    if (text === null) continue;
    const web = /^web:\s*(.+)$/m.exec(text);
    if (!web) continue;
    sources.push(rel);
    if (inference.up) continue;
    const cmd = web[1]!.trim();
    inference = { up: cmd, detached: false, port: portFromCommand(cmd) };
  }

  const detectedResources = classify(images);
  return {
    content: render(inference, notes),
    targetRel: RUNTIME_CONFIG_RELATIVE_PATH,
    sources,
    detectedResources,
    notes,
  };
}

/** One rendered line-group: either a `key: value` pair or a comment block. */
type Item =
  | { kind: "entry"; text: string }
  | { kind: "comment"; text: string };

const entry = (text: string): Item => ({ kind: "entry", text });
const comment = (text: string): Item => ({ kind: "comment", text });

/**
 * Serialise items into JSONC.
 *
 * Commas are placed by position — only entries before the LAST entry get one —
 * so a trailing comment block can never strand a trailing comma. (An earlier
 * draft joined everything with `,\n` and stripped commas with a regex; it
 * produced invalid JSON the moment the file ended on a comment, which is the
 * common case.)
 */
function serialise(items: Item[]): string {
  const lastEntry = items.reduce(
    (acc, it, i) => (it.kind === "entry" ? i : acc),
    -1,
  );
  const out: string[] = ["{"];
  items.forEach((it, i) => {
    if (it.kind === "comment") {
      for (const line of it.text.split("\n")) out.push(`  // ${line}`);
    } else {
      out.push(`  ${it.text}${i < lastEntry ? "," : ""}`);
    }
  });
  out.push("}");
  return out.join("\n") + "\n";
}

/**
 * Render the JSONC draft.
 *
 * ⛔ Two invariants live here and nowhere else:
 *   1. no `isolation` key is ever emitted;
 *   2. `up` is emitted only together with a `readiness` probe.
 */
function render(inf: Inference, notes: string[]): string {
  const items: Item[] = [];
  const startable = inf.up !== undefined && inf.port !== undefined;

  if (startable) {
    items.push(entry(`"up": ${JSON.stringify(inf.up)}`));
    if (inf.down) items.push(entry(`"down": ${JSON.stringify(inf.down)}`));
    if (inf.detached) items.push(entry(`"detached": true`));
    items.push(
      comment(
        `DERIVED from a published port, not a guessed URL path. Swap this for\n` +
          `{ "type": "http", "target": "http://localhost:${inf.port}/<your-health-path>" }\n` +
          `once you know the endpoint — an http probe proves the app ANSWERS,\n` +
          `a port probe only proves something is listening.`,
      ),
    );
    items.push(
      entry(
        `"readiness": { "type": "exec", "target": "nc -z localhost ${inf.port}" }`,
      ),
    );
    notes.push(
      `Drafted \`up\` and a PORT probe on ${inf.port}. A port probe only proves something ` +
        `is listening — replace it with an http probe against your real health endpoint ` +
        `when you have one.`,
    );
  } else if (inf.up !== undefined) {
    items.push(
      comment(
        `Found a start command (${JSON.stringify(inf.up)}) but no port to probe,\n` +
          `so it is NOT drafted: "up" without "readiness" is rejected, because\n` +
          `starting something with no way to know it started is the failure this\n` +
          `contract exists to prevent. Add both together:\n` +
          `  "up": ${JSON.stringify(inf.up)},\n` +
          `  "readiness": "http://localhost:<port>/<health-path>"`,
      ),
    );
    notes.push(
      `Found a start command (${inf.up}) but could not derive a port, so neither ` +
        `\`up\` nor \`readiness\` was drafted — they must be added together.`,
    );
  } else {
    items.push(
      comment(
        `Nothing to infer. Fill in "up" and "readiness" TOGETHER to have\n` +
          `spec-verify start your stack, wait for it, run the tests, then tear\n` +
          `it down. "down" is optional; "detached": true requires it.\n` +
          `  "up": "./scripts/stack up \${SENTINAL_WORKTREE_SLOT}",\n` +
          `  "down": "./scripts/stack down \${SENTINAL_WORKTREE_SLOT}",\n` +
          `  "readiness": "http://localhost:3000/health"`,
      ),
    );
    notes.push(
      `Nothing startable was detected, so the draft is a commented template. Fill in ` +
        `\`up\` and \`readiness\` together, or discard it.`,
    );
  }

  // ⛔ Deliberately no `isolation` key. See the module docblock.
  items.push(
    comment(
      `No "isolation" key, on purpose. Sentinal will NOT guess what your "up"\n` +
        `command namespaces per-slot — a wrong guess is a silent green light, which\n` +
        `is worse than no file at all. Unstated means "unknown", and unknown NEVER\n` +
        `interrupts a run. Declare a resource "shared" and Sentinal will ask before\n` +
        `any run that could touch it; declare it "isolated" and it stays quiet.\n` +
        `Vocabulary: ports, database, cache, queue, filesystem, objectStorage,\n` +
        `searchIndex, outboundEmail, browser, plus\n` +
        `other: [{ "name": "...", "state": "shared" }].`,
    ),
  );

  return serialise(items);
}
