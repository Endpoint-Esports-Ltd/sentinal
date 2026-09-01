/**
 * Tests for the shared MCP tool-input schema helpers.
 *
 * The bug (issue #7): zod treats a MISSING required enum as a failed
 * literal-set match rather than a type error, so "you sent nothing" and
 * "you sent the wrong thing" produce a byte-identical `invalid_value`
 * message. Missing strings report `invalid_type` / "received undefined".
 *
 * These tests pin BOTH halves of the contract:
 *   - fix property:          absent  -> the message says "received undefined"
 *   - preservation property: present -> byte-identical to zod's default
 *
 * The MCP-boundary tests use a real `Client` over `InMemoryTransport`
 * (precedent: `src/analysis/impact.test.ts`) because the message has to
 * survive the SDK's validation layer, not just `schema.safeParse()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { registerMemoryTools } from "../memory/mcp-tools.js";
import { createSentinalServer } from "../mcp/server.js";
import { requiredEnum } from "./schema.js";

/**
 * The exact wrong-value message zod 4 emits for the memory_save `type` enum,
 * captured verbatim from HEAD before the fix. Written as a literal (not
 * derived) on purpose: this is the byte-for-byte preservation pin.
 */
const WRONG_VALUE_MESSAGE =
  'Invalid option: expected one of "decision"|"discovery"|"error"|"fix"|"pattern"';

// --- MCP boundary harness ---

interface ConnectedServer {
  client: Client;
  close: () => Promise<void>;
}

async function connect(server: McpServer): Promise<ConnectedServer> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function resultText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

/** Parse the zod issue array the MCP SDK embeds in its validation error text. */
interface McpIssue {
  code: string;
  path: string[];
  message: string;
}

function issuesFrom(text: string): McpIssue[] {
  const start = text.indexOf("[");
  expect(
    start,
    `no zod issue array in MCP error text: ${text}`,
  ).toBeGreaterThan(-1);
  return JSON.parse(text.slice(start)) as McpIssue[];
}

function issueFor(text: string, field: string): McpIssue {
  const issue = issuesFrom(text).find((i) => i.path.join(".") === field);
  expect(issue, `no issue for field "${field}" in: ${text}`).toBeDefined();
  return issue!;
}

// --- requiredEnum unit behaviour ---

describe("requiredEnum", () => {
  const VALUES = ["a", "b", "c"] as const;

  it("reports an absent value as not supplied, not as an invalid option", () => {
    const result = requiredEnum(VALUES).safeParse(undefined);

    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toBe(
      'Invalid input: expected one of "a"|"b"|"c", received undefined',
    );
  });

  it("leaves a wrong value's message byte-identical to plain z.enum", () => {
    const custom = requiredEnum(VALUES).safeParse("zzz");
    const plain = z.enum(VALUES).safeParse("zzz");

    expect(custom.success).toBe(false);
    expect(custom.error!.issues[0].message).toBe(
      plain.error!.issues[0].message,
    );
    expect(custom.error!.issues[0].message).toBe(
      'Invalid option: expected one of "a"|"b"|"c"',
    );
    expect(custom.error!.issues[0].code).toBe(plain.error!.issues[0].code);
  });

  it("parses a valid value unchanged", () => {
    expect(requiredEnum(VALUES).parse("b")).toBe("b");
  });

  it("keeps the description when one is supplied", () => {
    expect(requiredEnum(VALUES, "pick one").description).toBe("pick one");
    // ...and the custom error survives the describe() clone.
    expect(
      requiredEnum(VALUES, "pick one").safeParse(undefined).error!.issues[0]
        .message,
    ).toContain("received undefined");
  });
});

// --- The real tool, through a real MCP client ---

describe("memory_save through the MCP boundary", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let harness: ConnectedServer;

  const VALID_ARGS = {
    title: "A title",
    content: "Some content for the observation",
    project: "/test/project",
  };

  beforeEach(async () => {
    tmpDir = makeTmpDir("schema-enum");
    store = new MemoryStore(join(tmpDir, "test.db"));
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerMemoryTools(server, { client: null, store });
    harness = await connect(server);
  });

  afterEach(async () => {
    await harness.close();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports an omitted `type` as missing, like it already does for `project`", async () => {
    const result = await harness.client.callTool({
      name: "memory_save",
      arguments: { title: VALID_ARGS.title, content: VALID_ARGS.content },
    });
    const text = resultText(result);

    const typeIssue = issueFor(text, "type");
    const projectIssue = issueFor(text, "project");

    // `project` is a plain z.string(); it has always got this right.
    expect(projectIssue.message).toBe(
      "Invalid input: expected string, received undefined",
    );

    // The bug: `type` used to be byte-identical to the wrong-value message.
    expect(
      typeIssue.message,
      "a missing enum still reads as an invalid value",
    ).not.toBe(WRONG_VALUE_MESSAGE);
    expect(typeIssue.message).toContain("received undefined");
    expect(typeIssue.message).toBe(
      'Invalid input: expected one of "decision"|"discovery"|"error"|"fix"|"pattern", received undefined',
    );
  });

  it("leaves a wrong `type` value byte-identical (preservation pin)", async () => {
    const result = await harness.client.callTool({
      name: "memory_save",
      arguments: { ...VALID_ARGS, type: "zzz" },
    });

    const issue = issueFor(resultText(result), "type");
    expect(issue.message).toBe(WRONG_VALUE_MESSAGE);
    expect(issue.code).toBe("invalid_value");
  });

  it("still accepts every valid `type` value", async () => {
    for (const type of ["decision", "discovery", "error", "fix", "pattern"]) {
      const result = await harness.client.callTool({
        name: "memory_save",
        arguments: { ...VALID_ARGS, type },
      });
      const text = resultText(result);
      expect(text, `valid type "${type}" was rejected`).not.toContain(
        "validation error",
      );
      expect(text).toContain("Saved");
    }
  });

  it("advertises all five values and keeps `type` required in inputSchema", async () => {
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === "memory_save");
    expect(tool, "memory_save is not listed by the server").toBeDefined();

    const schema = tool!.inputSchema as unknown as {
      properties?: Record<string, { enum?: string[]; description?: string }>;
      required?: string[];
    };

    // The custom error must be invisible to the JSON-Schema converter.
    // (`.refine()` is silently dropped by it — so prove, do not assume.)
    expect(schema.properties?.type?.enum).toEqual([
      "decision",
      "discovery",
      "error",
      "fix",
      "pattern",
    ]);
    expect(schema.properties?.type?.description).toBe(
      "Type: decision, discovery, error, fix, or pattern",
    );
    expect(schema.required ?? []).toContain("type");
  });
});

// --- Drift guard ---

/**
 * A helper only helps if new code remembers it. Walk every zod shape the
 * unified server registers and assert each REQUIRED top-level enum reports an
 * absent value as missing. This is a behavioural probe, not a marker check —
 * it cannot be satisfied by anything except the actual fix.
 *
 * Optional enums are excluded on purpose: `undefined` legitimately passes
 * there, so there is nothing to distinguish.
 */
describe("required enum drift guard", () => {
  interface ZodInternals {
    _zod?: { def?: { type?: string } };
    safeParse?: (v: unknown) => {
      success: boolean;
      error?: { issues: { message: string }[] };
    };
  }

  function isZodSchema(v: unknown): v is ZodInternals {
    return typeof v === "object" && v !== null && "_zod" in (v as object);
  }

  function findShape(args: unknown[]): Record<string, unknown> | null {
    for (const arg of args) {
      if (typeof arg !== "object" || arg === null || Array.isArray(arg))
        continue;
      const values = Object.values(arg as Record<string, unknown>);
      if (values.length > 0 && values.every(isZodSchema)) {
        return arg as Record<string, unknown>;
      }
    }
    return null;
  }

  /** Register every Sentinal tool, capturing the raw zod shapes. */
  function captureAllShapes(): Map<string, Record<string, unknown>> {
    const tmpDir = makeTmpDir("schema-drift");
    const store = new MemoryStore(join(tmpDir, "test.db"));
    const shapes = new Map<string, Record<string, unknown>>();
    const orig = McpServer.prototype.tool;

    (McpServer.prototype as unknown as { tool: unknown }).tool = function (
      this: McpServer,
      ...args: unknown[]
    ) {
      if (typeof args[0] === "string") {
        const shape = findShape(args.slice(1));
        if (shape) shapes.set(args[0], shape);
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };

    try {
      createSentinalServer({ store });
    } finally {
      (McpServer.prototype as unknown as { tool: unknown }).tool = orig;
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
    return shapes;
  }

  function requiredEnumFields(): {
    tool: string;
    field: string;
    schema: ZodInternals;
  }[] {
    const found: { tool: string; field: string; schema: ZodInternals }[] = [];
    for (const [tool, shape] of captureAllShapes()) {
      for (const [field, schema] of Object.entries(shape)) {
        if (!isZodSchema(schema)) continue;
        if (schema._zod?.def?.type !== "enum") continue; // optional => "optional"
        found.push({ tool, field, schema });
      }
    }
    return found;
  }

  it("finds the four known required enums (guard is actually looking)", () => {
    const ids = requiredEnumFields()
      .map((f) => `${f.tool}.${f.field}`)
      .sort();

    expect(ids).toEqual([
      "memory_maintain.action",
      "memory_save.type",
      "spec_notify.type",
      "tdd_set_state.state",
    ]);
  });

  it("every required enum reports an absent value as missing", () => {
    const offenders: string[] = [];

    for (const { tool, field, schema } of requiredEnumFields()) {
      const result = schema.safeParse!(undefined);
      const message = result.error?.issues[0]?.message ?? "";
      if (!message.includes("received undefined")) {
        offenders.push(`${tool}.${field} -> ${message}`);
      }
    }

    expect(
      offenders,
      `these required enums do not use requiredEnum() from src/utils/schema.ts, ` +
        `so omitting them reads as an invalid value:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
