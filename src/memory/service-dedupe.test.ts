/**
 * MemoryService — server-side dedupe of auto-captured observations
 * (hardening-sweep Task 15, D10). The D3 signed-error behaviour stays covered
 * by service.test.ts ("addObservationDeduped (Task 7, D3)").
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  MemoryService,
  AUTO_CAPTURE_DEDUP_WINDOW_MS,
  FIX_TITLE_DEDUP_WINDOW_MS,
} from "./service.js";
import { MemoryStore } from "./store.js";
import { computeDedupeSignature } from "./dedupe-signature.js";
import type { VectorStore } from "./vector-store.js";
import type { SearchOrchestrator } from "./search/orchestrator.js";
import type { CreateObservation } from "./types.js";

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

// Real bun output, two runs of the same failure (different durations,
// counts, version banner and temp dir).
const RUN_1 = `bun test v1.3.10 (30e609e0)
error: expect(received).toBe(expected)
      at <anonymous> (/private/var/folders/4k/tp/T/opencode/dd/x.test.ts:2:23)
(fail) a [4.77ms]
 1 pass
 1 fail
Ran 2 tests across 1 file. [122.00ms]`;
const RUN_2 = `bun test v1.3.11 (4b1c9f2a)
error: expect(received).toBe(expected)
      at <anonymous> (/var/folders/zz/q/T/sentinal-test-home-x/x.test.ts:2:23)
(fail) a [0.72ms]
 3 pass
 1 fail
Ran 4 tests across 2 files. [16.00ms]`;

function auto(overrides: Partial<CreateObservation> = {}): CreateObservation {
  return {
    sessionId: "s",
    projectPath: "/test/project",
    timestamp: T0,
    type: "pattern",
    title: "TDD cycle completed: a.ts",
    content: `**Test failure:** ${RUN_1}`,
    filePaths: [],
    tags: [],
    metadata: { source: "auto-capture", confidence: 0.8, toolName: "bash" },
    ...overrides,
  };
}

function vectorSpy() {
  const indexCalls: unknown[][] = [];
  const removeCalls: number[] = [];
  const vectorStore = {
    isAvailable: () => true,
    indexObservation: (...args: unknown[]) => {
      indexCalls.push(args);
      return Promise.resolve(1);
    },
    removeObservation: (id: number) => {
      removeCalls.push(id);
    },
  } as unknown as VectorStore;
  const orchestrator = {
    search: () => Promise.resolve([]),
    isVectorAvailable: () => true,
  } as unknown as SearchOrchestrator;
  return { vectorStore, orchestrator, indexCalls, removeCalls };
}

describe("addObservationDeduped — auto-captures (D10)", () => {
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
  });
  afterEach(() => service.close());

  const rows = () => store.getStats().totalObservations;

  it("exposes the 30-min signature and 5-min fix-title windows", () => {
    expect(AUTO_CAPTURE_DEDUP_WINDOW_MS).toBe(30 * MIN);
    expect(FIX_TITLE_DEDUP_WINDOW_MS).toBe(5 * MIN);
  });

  it("10 identical auto-captures → 1 row with occurrences 10, no re-embed", () => {
    const spy = vectorSpy();
    service.setSearchBackends(spy.vectorStore, spy.orchestrator);

    const results = Array.from({ length: 10 }, (_, i) =>
      service.addObservationDeduped(auto({ timestamp: T0 + i * MIN })),
    );

    expect(rows()).toBe(1);
    expect(results[0]!.deduplicated).toBe(false);
    expect(results.slice(1).every((r) => r.deduplicated)).toBe(true);
    expect(results.every((r) => r.deduplicable)).toBe(true);
    const row = store.getObservation(results[0]!.observation.id)!;
    expect(row.metadata.occurrences).toBe(10);
    expect(row.metadata.lastSeen).toBe(T0 + 9 * MIN);
    expect(row.timestamp).toBe(T0);
    // The stored signature is the shipped one (Task 18 relies on this).
    expect(row.metadata.signature).toBe(computeDedupeSignature(auto()));
    expect(row.metadata.source).toBe("auto-capture");

    expect(spy.indexCalls).toHaveLength(1);
    expect(spy.removeCalls).toHaveLength(0);
  });

  it("volatile-only differences (real bun variants) collapse", () => {
    const a = service.addObservationDeduped(auto());
    const b = service.addObservationDeduped(
      auto({ timestamp: T0 + MIN, content: `**Test failure:** ${RUN_2}` }),
    );
    expect(b.deduplicated).toBe(true);
    expect(b.observation.id).toBe(a.observation.id);
    expect(rows()).toBe(1);
  });

  it("genuinely different content is a new row", () => {
    service.addObservationDeduped(auto());
    const b = service.addObservationDeduped(
      auto({
        timestamp: T0 + MIN,
        content: `**Test failure:** ${RUN_1.replace("toBe(expected)", "toEqual(expected)")}`,
      }),
    );
    expect(b.deduplicated).toBe(false);
    expect(rows()).toBe(2);
  });

  it("the window is fixed from first sight (30 min)", () => {
    const a = service.addObservationDeduped(auto());
    service.addObservationDeduped(auto({ timestamp: T0 + 29 * MIN }));
    const late = service.addObservationDeduped(
      auto({ timestamp: T0 + 30 * MIN }),
    );
    expect(late.deduplicated).toBe(false);
    expect(late.observation.id).not.toBe(a.observation.id);
  });

  it("scopes by project", () => {
    service.addObservationDeduped(auto());
    const b = service.addObservationDeduped(
      auto({ projectPath: "/other", timestamp: T0 + MIN }),
    );
    expect(b.deduplicated).toBe(false);
  });

  it("an auto-capture-failure error without a client signature is signed too", () => {
    const err = (t: number) =>
      auto({
        type: "error",
        title: "Bash failed",
        timestamp: t,
        metadata: { source: "auto-capture-failure" },
      });
    service.addObservationDeduped(err(T0));
    expect(service.addObservationDeduped(err(T0 + MIN)).deduplicated).toBe(
      true,
    );
  });

  it("a client-supplied error signature still wins (D3 unchanged)", () => {
    const r = service.addObservationDeduped(
      auto({
        type: "error",
        metadata: { source: "auto-capture-failure", signature: "sig-1" },
      }),
    );
    expect(r.observation.metadata.signature).toBe("sig-1");
  });

  describe("type=fix: same (project, title) within 5 min collapses", () => {
    const fix = (content: string, t: number, extra = {}) =>
      auto({
        type: "fix",
        title: "Fixed issue in a.ts",
        content,
        timestamp: t,
        ...extra,
      });

    it("different content, same title, within 5 min → one row", () => {
      const a = service.addObservationDeduped(fix("error one", T0));
      const b = service.addObservationDeduped(fix("error two", T0 + 4 * MIN));
      expect(b.deduplicated).toBe(true);
      expect(b.observation.id).toBe(a.observation.id);
      expect(store.getObservation(a.observation.id)!.metadata.occurrences).toBe(
        2,
      );
    });

    it("after 5 min, different content is a new row", () => {
      service.addObservationDeduped(fix("error one", T0));
      const b = service.addObservationDeduped(fix("error two", T0 + 5 * MIN));
      expect(b.deduplicated).toBe(false);
      expect(rows()).toBe(2);
    });

    it("only for fix: another type with the same title and different content is kept", () => {
      service.addObservationDeduped(auto({ content: "one" }));
      const b = service.addObservationDeduped(
        auto({ content: "two", timestamp: T0 + MIN }),
      );
      expect(b.deduplicated).toBe(false);
    });

    it("never collapses into a manual fix with the same title", () => {
      service.addObservationDeduped(
        fix("manual", T0, { metadata: { source: "mcp-tool" } }),
      );
      const b = service.addObservationDeduped(fix("auto", T0 + MIN));
      expect(b.deduplicated).toBe(false);
      expect(rows()).toBe(2);
    });
  });

  describe("manual observations are never deduped", () => {
    for (const metadata of [
      {},
      { source: "mcp-tool" },
      { source: "session-end" },
    ]) {
      it(`metadata ${JSON.stringify(metadata)}`, () => {
        const a = service.addObservationDeduped(auto({ metadata }));
        const b = service.addObservationDeduped(
          auto({ metadata, timestamp: T0 + MIN }),
        );
        expect(a.deduplicable).toBe(false);
        expect(b.deduplicated).toBe(false);
        expect(b.observation.id).not.toBe(a.observation.id);
        // Untouched metadata: no signature, no occurrences stamp.
        expect(a.observation.metadata).toEqual(metadata);
        expect(rows()).toBe(2);
      });
    }

    it("manual type=fix with the same title is not title-collapsed", () => {
      const m = { source: "mcp-tool" };
      service.addObservationDeduped(
        auto({ type: "fix", content: "a", metadata: m }),
      );
      const b = service.addObservationDeduped(
        auto({ type: "fix", content: "b", metadata: m, timestamp: T0 + MIN }),
      );
      expect(b.deduplicated).toBe(false);
    });
  });

  it("a dedupeKey collapses differing content under the same key", () => {
    const loaded = (content: string, key: string, t: number) =>
      auto({
        type: "discovery",
        title: "Instructions loaded: CLAUDE.md",
        content,
        timestamp: t,
        metadata: { source: "instructions-loaded", dedupeKey: key },
      });
    const a = service.addObservationDeduped(
      loaded("Load reason: session_start", "/p/CLAUDE.md", T0),
    );
    const b = service.addObservationDeduped(
      loaded("Load reason: path_glob_match", "/p/CLAUDE.md", T0 + MIN),
    );
    const c = service.addObservationDeduped(
      loaded("Load reason: session_start", "/p/sub/CLAUDE.md", T0 + 2 * MIN),
    );
    expect(b.observation.id).toBe(a.observation.id);
    expect(c.deduplicated).toBe(false);
    expect(rows()).toBe(2);
  });
});
