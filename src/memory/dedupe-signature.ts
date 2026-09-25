/**
 * Dedupe signatures for auto-captured observations (hardening-sweep D10).
 *
 * An auto-capture (`metadata.source` in {@link AUTO_CAPTURE_SOURCES}) or an
 * observation carrying `metadata.dedupeKey` gets a signature:
 *
 *   sha1(type | normalized title | normalized content)      — auto-capture
 *   sha1(type | normalized title | "key:" + dedupeKey)      — dedupeKey set
 *
 * The normalizer removes what varies between two runs of the SAME failure —
 * durations, pass/test counts, hashes, tool version banners, temp paths,
 * timestamps, tsc statistics — so repeats collapse onto one row
 * (`MemoryService.addObservationDeduped`). Manual observations (no source,
 * `mcp-tool`, `session-end`, …) are never signed, so never deduped.
 *
 * Pure and dependency-free (besides node:crypto) so the one-off DB cleanup
 * (Task 18) can stamp merged keepers with the exact shipped signature.
 */

import { createHash } from "node:crypto";

/** `metadata.source` values real auto-capture traffic sends (CC hooks + plugin). */
export const AUTO_CAPTURE_SOURCES: ReadonlySet<string> = new Set([
  "auto-capture", // capture.ts analyzeEvent — CC memory-observer, plugin
  "auto-capture-failure", // tool-failure-observer (CC), plugin tool failures
]);

export function isAutoCapture(
  metadata: Record<string, unknown> | undefined | null,
): boolean {
  const source = metadata?.source;
  return typeof source === "string" && AUTO_CAPTURE_SOURCES.has(source);
}

/**
 * Raw-output caps applied by `capture.ts` when building content sections
 * (`**Error:** <output.slice(0, 500)>` etc). A section whose body is exactly
 * its cap was truncated, so its last line is partial — and WHERE it was cut
 * moves with every volatile width (a `[4.77ms]` vs `[122.00ms]` shifts it).
 */
const SECTION_CAPS: Readonly<Record<string, number>> = {
  Error: 500,
  Result: 300,
  "Test failure": 400,
  "Tests passing": 300,
};

const SECTION_RE = /^\*\*([^*\n]+):\*\* ([\s\S]*)$/;

/** Drop the partial trailing line of every section that hit its cap. */
function dropTruncatedTails(content: string): string {
  return content
    .split(/\n\n(?=\*\*[^*\n]+:\*\* )/)
    .map((section) => {
      const m = SECTION_RE.exec(section);
      if (!m) return section;
      const [, label, body] = m;
      if (body!.length !== SECTION_CAPS[label!]) return section;
      const cut = body!.lastIndexOf("\n");
      return `**${label}:** ${cut === -1 ? "" : body!.slice(0, cut)}`;
    })
    .join("\n\n");
}

/** tsc --extendedDiagnostics statistic lines (counts that vary run to run). */
const TSC_STAT_LINE_RE =
  /^([ \t]*(?:Files|Lines(?: of [\w ]+)?|Identifiers|Symbols|Types|Instantiations|Nodes|Memory used|Memory allocs|[A-Za-z ]*cache size):)[ \t]+[\d.,]+[KMG]?B?[ \t]*$/gm;

/**
 * Replace volatile substrings with placeholders. Line structure is kept;
 * horizontal whitespace is collapsed and lines trimmed.
 */
export function normalizeVolatile(text: string): string {
  return (
    text
      // Tool version banners: `bun test v1.3.10 (30e609e0)`.
      .replace(
        /\b(bun(?: test)?) v\d+\.\d+\.\d+[\w.+-]*(?: \([0-9a-f]+\))?/gi,
        "$1 <ver>",
      )
      // ISO timestamps, then clock times (`[10:11:12 AM]`, `12:00:01.5`).
      .replace(
        /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
        "<ts>",
      )
      .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s?[AP]M)?\b/gi, "<ts>")
      // Temp directories — keep the file name, drop the random dirs.
      .replace(
        /(?<![\w./-])(?:\/private)?\/(?:var\/folders|tmp)(?:\/[^\s/:'"`()[\]{}<>,;]+)*\//g,
        "<tmp>/",
      )
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<uuid>",
      )
      // Hashes: >= 7 hex chars containing a digit (so words like "defaced"
      // survive); also catches epoch-ms numbers.
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>")
      .replace(TSC_STAT_LINE_RE, "$1 N")
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s)\b/g, "<dur>")
      // Counts that vary between runs of the same failure. Fail counts are
      // deliberately kept: " 0 fail" and " 2 fail" are different outcomes.
      .replace(
        /\bRan \d+ tests? across \d+ files?/g,
        "Ran N tests across N files",
      )
      .replace(/\b\d+ (pass|skip|todo|snapshots?|expect\(\) calls)\b/g, "N $1")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
  );
}

export interface SignableObservation {
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * The D10 dedupe signature, or null when the observation is not eligible
 * (not an auto-capture and no non-empty `metadata.dedupeKey`).
 */
export function computeDedupeSignature(
  obs: SignableObservation,
): string | null {
  const dedupeKey = obs.metadata?.dedupeKey;
  const hasKey = typeof dedupeKey === "string" && dedupeKey.length > 0;
  if (!hasKey && !isAutoCapture(obs.metadata)) return null;

  const material = hasKey
    ? `key:${dedupeKey}`
    : normalizeVolatile(dropTruncatedTails(obs.content));
  return createHash("sha1")
    .update(`${obs.type}|${normalizeVolatile(obs.title)}|${material}`)
    .digest("hex");
}
