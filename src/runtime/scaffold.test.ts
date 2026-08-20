/**
 * `runtime_init` scaffolder tests (Phase 3, Task 4).
 *
 * The single most important assertion in this file is the NEGATIVE one:
 * **the draft must contain no `isolation` key.** Every possible value is
 * either unsafe (`isolated`/`none` manufacture a false all-clear; `shared`
 * manufactures a false block on every run) or redundant. Omission is
 * fail-safe because omission means `unknown`, and `unknown` never blocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldRuntimeConfig, stripJsonComments } from "./scaffold.js";
import { RuntimeConfigSchema } from "./schema.js";

let root: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `sentinal-scaffold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, content: string) => {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

/** The draft, parsed back through the real schema. */
const parsed = (content: string) =>
  RuntimeConfigSchema.parse(JSON.parse(stripJsonComments(content)));

const COMPOSE = `services:
  app:
    build: .
    ports:
      - "3000:3000"
  db:
    image: postgres:16
  cache:
    image: redis:7
`;

// ─── The load-bearing omission ──────────────────────────────────────────────

/** Any `"isolation":` KEY in the emitted JSONC — comments mentioning the word
 *  are fine and in fact required, since the draft explains its own omission. */
const hasIsolationKey = (content: string) =>
  /^\s*"isolation"\s*:/m.test(stripJsonComments(content));

describe("⛔ the draft never declares isolation", () => {
  it("omits the isolation key entirely, even with a full compose stack", () => {
    write("docker-compose.yml", COMPOSE);
    const r = scaffoldRuntimeConfig(root);

    expect(hasIsolationKey(r.content)).toBe(false);
    expect(JSON.parse(stripJsonComments(r.content)).isolation).toBeUndefined();
    expect(parsed(r.content).isolation).toBeUndefined();
  });

  it("omits it for a bare project with nothing to infer", () => {
    const r = scaffoldRuntimeConfig(root);
    expect(hasIsolationKey(r.content)).toBe(false);
    expect(parsed(r.content).isolation).toBeUndefined();
  });

  it("explains the omission in a comment so the human is not left guessing", () => {
    const r = scaffoldRuntimeConfig(root);
    expect(r.content).toContain("isolation");
    expect(r.content).toContain("unknown");
  });

  it("reports detected resource classes OUT of band, for the /sync conversation", () => {
    write("docker-compose.yml", COMPOSE);
    const r = scaffoldRuntimeConfig(root);

    // Detected — so /sync can say "I saw postgres and redis"...
    expect(r.detectedResources).toContain("database");
    expect(r.detectedResources).toContain("cache");
    // ...but never as a DECLARATION in the file.
    expect(hasIsolationKey(r.content)).toBe(false);
    expect(parsed(r.content).isolation).toBeUndefined();
  });
});

// ─── Inference ──────────────────────────────────────────────────────────────

describe("docker compose inference", () => {
  it("drafts up/down/detached from a compose file", () => {
    write("docker-compose.yml", COMPOSE);
    const cfg = parsed(scaffoldRuntimeConfig(root).content);

    expect(cfg.up).toBe("docker compose up -d");
    expect(cfg.down).toBe("docker compose down");
    expect(cfg.detached).toBe(true);
  });

  it("derives the readiness probe from a published port, never a guessed URL path", () => {
    write("docker-compose.yml", COMPOSE);
    const cfg = parsed(scaffoldRuntimeConfig(root).content);

    // An `exec` port probe is DERIVED from `ports:`. An http probe would
    // require inventing a health path, which is a guess.
    expect(cfg.readiness).toMatchObject({
      type: "exec",
      target: "nc -z localhost 3000",
    });
  });

  it("recognises compose.yaml as well as docker-compose.yml", () => {
    write("compose.yaml", COMPOSE);
    expect(scaffoldRuntimeConfig(root).sources).toContain("compose.yaml");
  });

  it("maps service images to resource classes", () => {
    write(
      "docker-compose.yml",
      `services:
  db:
    image: mysql:8
  q:
    image: rabbitmq:3
  s3:
    image: minio/minio
  search:
    image: elasticsearch:8
  mail:
    image: mailpit:latest
`,
    );
    const r = scaffoldRuntimeConfig(root);
    expect(r.detectedResources).toEqual(
      expect.arrayContaining([
        "database",
        "queue",
        "objectStorage",
        "searchIndex",
        "outboundEmail",
      ]),
    );
  });
});

describe("package.json inference", () => {
  it("drafts up from a dev script when there is no compose file", () => {
    write(
      "package.json",
      JSON.stringify({ scripts: { dev: "PORT=4000 node server.js" } }),
    );
    const cfg = parsed(scaffoldRuntimeConfig(root).content);

    expect(cfg.up).toBe("npm run dev");
    expect(cfg.readiness).toMatchObject({ target: "nc -z localhost 4000" });
    // A foreground starter: `down` is legal to omit, and `detached` stays false.
    expect(cfg.detached).toBe(false);
  });

  it("prefers compose over package.json when both exist", () => {
    write("docker-compose.yml", COMPOSE);
    write("package.json", JSON.stringify({ scripts: { dev: "PORT=4000 x" } }));
    expect(parsed(scaffoldRuntimeConfig(root).content).up).toBe(
      "docker compose up -d",
    );
  });

  it("ignores a dev script with no discoverable port rather than guessing one", () => {
    write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    const cfg = parsed(scaffoldRuntimeConfig(root).content);
    expect(cfg.up).toBeUndefined();
    expect(cfg.readiness).toBeUndefined();
  });
});

describe("Procfile inference", () => {
  it("drafts up from the web process", () => {
    write("Procfile", "web: PORT=5000 bundle exec puma\nworker: rake jobs\n");
    const cfg = parsed(scaffoldRuntimeConfig(root).content);
    expect(cfg.up).toBe("PORT=5000 bundle exec puma");
    expect(cfg.readiness).toMatchObject({ target: "nc -z localhost 5000" });
  });
});

describe("monorepo discovery", () => {
  it("finds package-level sources via workspacePackageDirs", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    write("packages/api/package.json", JSON.stringify({ name: "api" }));
    write("packages/api/docker-compose.yml", COMPOSE);

    const r = scaffoldRuntimeConfig(root);
    expect(r.sources).toContain("packages/api/docker-compose.yml");
    expect(r.detectedResources).toContain("database");
  });
});

// ─── Never guess; leave it empty with a comment ─────────────────────────────

describe("ambiguity is left empty with a comment, never guessed", () => {
  it("produces a schema-valid draft with no up/down/readiness for a bare project", () => {
    const r = scaffoldRuntimeConfig(root);
    const cfg = parsed(r.content);

    expect(cfg.up).toBeUndefined();
    expect(cfg.down).toBeUndefined();
    expect(cfg.readiness).toBeUndefined();
    expect(r.sources).toEqual([]);
  });

  it("explains in a comment what the human has to fill in", () => {
    const r = scaffoldRuntimeConfig(root);
    expect(r.content).toContain("//");
    expect(r.content.toLowerCase()).toContain("up");
  });

  it("always tells the human the probe is a port check, not a health endpoint", () => {
    write("docker-compose.yml", COMPOSE);
    const r = scaffoldRuntimeConfig(root);
    expect(r.content).toContain("//");
    expect(r.notes.join("\n")).toBeTruthy();
  });

  it("never emits `up` without `readiness` — the draft must always validate", () => {
    // A draft that fails its own schema is worse than no draft: the user
    // commits it and the first verify run errors on their own config.
    for (const setup of [
      () => {},
      () => write("docker-compose.yml", COMPOSE),
      () => write("docker-compose.yml", "services:\n  db:\n    image: postgres\n"),
      () => write("package.json", JSON.stringify({ scripts: { dev: "x" } })),
      () => write("Procfile", "web: node x\n"),
    ]) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      setup();
      const r = scaffoldRuntimeConfig(root);
      expect(() => parsed(r.content)).not.toThrow();
    }
  });
});

// ─── JSONC support ──────────────────────────────────────────────────────────

// The stripper itself is covered by `jsonc.test.ts`. What matters here is only
// that the scaffolder's own output survives a round trip — which every
// `parsed()` call above already exercises — plus that the re-export works.
describe("re-exports stripJsonComments", () => {
  it("round-trips its own draft", () => {
    const r = scaffoldRuntimeConfig(root);
    expect(() => JSON.parse(stripJsonComments(r.content))).not.toThrow();
  });
});
