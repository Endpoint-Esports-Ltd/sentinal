/**
 * Project-qualified spec keys (D6).
 *
 * `specs.id` is `<canonicalProject>::<slug>` — opaque, never parsed. Callers
 * may hold either the key or the bare slug (the API keeps `Spec.id` = slug);
 * `resolveSpecKey` maps both onto the stored key:
 *   exact key → (project, slug) → unique slug → otherwise null (ambiguous).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import { specKey, resolveSpecKey, resolveSpecKeyForWrite } from "./spec-key.js";

function insertSpec(store: MemoryStore, project: string, slug: string): void {
  store
    .getRawDb()
    .prepare(
      `INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
       VALUES (?, ?, 't', ?, 'feature', 'PENDING', '/p.md', 1, 1)`,
    )
    .run(specKey(project, slug), project, slug);
}

describe("specKey", () => {
  it("joins the canonical project and slug with '::'", () => {
    expect(specKey("/repo/a", "2026-01-01-x")).toBe("/repo/a::2026-01-01-x");
  });
});

describe("resolveSpecKey", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    insertSpec(store, "/repo/a", "shared");
    insertSpec(store, "/repo/b", "shared");
    insertSpec(store, "/repo/a", "only-a");
  });

  afterEach(() => store.close());

  const db = () => store.getRawDb();

  it("returns an exact stored key unchanged", () => {
    expect(resolveSpecKey(db(), "/repo/b::shared")).toBe("/repo/b::shared");
  });

  it("resolves (project, slug) to that project's key", () => {
    expect(resolveSpecKey(db(), "shared", "/repo/a")).toBe("/repo/a::shared");
    expect(resolveSpecKey(db(), "shared", "/repo/b")).toBe("/repo/b::shared");
  });

  it("resolves a slug that exists in exactly one project without a project", () => {
    expect(resolveSpecKey(db(), "only-a")).toBe("/repo/a::only-a");
  });

  it("refuses an ambiguous slug without a project (null, never a guess)", () => {
    expect(resolveSpecKey(db(), "shared")).toBeNull();
  });

  it("returns null for an unknown value", () => {
    expect(resolveSpecKey(db(), "nope")).toBeNull();
    expect(resolveSpecKey(db(), "nope", "/repo/a")).toBeNull();
  });

  it("never crosses projects: a supplied project with no such slug → null", () => {
    expect(resolveSpecKey(db(), "only-a", "/repo/b")).toBeNull();
  });

  it("an exact key wins even when a different project is supplied", () => {
    expect(resolveSpecKey(db(), "/repo/a::only-a", "/repo/b")).toBe(
      "/repo/a::only-a",
    );
  });
});

describe("resolveSpecKeyForWrite (FK writers)", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    insertSpec(store, "/repo/a", "shared");
    insertSpec(store, "/repo/b", "shared");
    insertSpec(store, "/repo/a", "only-a");
  });

  afterEach(() => store.close());

  it("prefers the supplied project's row", () => {
    expect(resolveSpecKeyForWrite(store.getRawDb(), "shared", "/repo/b")).toBe(
      "/repo/b::shared",
    );
  });

  it("falls back to a unique slug when the project is raw/inferred and misses", () => {
    expect(resolveSpecKeyForWrite(store.getRawDb(), "only-a", "/")).toBe(
      "/repo/a::only-a",
    );
  });

  it("still refuses an ambiguous slug the project cannot disambiguate", () => {
    expect(resolveSpecKeyForWrite(store.getRawDb(), "shared", "/")).toBeNull();
  });
});
