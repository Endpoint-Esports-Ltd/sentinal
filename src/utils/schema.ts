/**
 * Shared zod helpers for MCP tool input schemas.
 */

import { z } from "zod";

/**
 * A required enum whose error distinguishes "not supplied" from "wrong value".
 *
 * zod treats `undefined` as a failed literal-set match rather than a type
 * error, so a MISSING required enum and a WRONG value emit a byte-identical
 * `invalid_value` message — _"Invalid option: expected one of …"_. That reads
 * as "the value you sent is wrong" when nothing was sent at all, which sends
 * the caller off to inspect an argument that never arrived (issue #7).
 *
 * The error function only overrides the `undefined` case and returns
 * `undefined` otherwise, which falls through to zod's default. So the
 * wrong-value message stays **byte-identical** and only the absent case
 * changes — to the same shape zod already uses for a missing string
 * (_"Invalid input: expected string, received undefined"_).
 *
 * The custom error is a runtime-only concern: it does not appear in the
 * emitted JSON Schema, so the advertised enum values are unchanged.
 *
 * ⛔ Use this for every REQUIRED enum in an agent-reachable MCP tool input.
 * `src/utils/schema.test.ts` has a drift guard that walks the registered tool
 * schemas and fails if a required enum is declared with a bare `z.enum()`.
 * Optional enums do NOT need it — `undefined` legitimately passes there.
 */
export function requiredEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  description?: string,
): z.ZodEnum<{ [K in T[number]]: K }> {
  const options = values.map((v) => JSON.stringify(v)).join("|");
  const schema = z.enum(values, {
    error: (issue) =>
      issue.input === undefined
        ? `Invalid input: expected one of ${options}, received undefined`
        : undefined,
  });
  return description ? schema.describe(description) : schema;
}
