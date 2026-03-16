/**
 * Sentinal Plugin Helpers
 *
 * Extracted helper functions for the OpenCode plugin to keep the
 * main plugin file under the 600-line limit.
 */

// ─── Tool Redirect Hints ──────────────────────────────────────────────────────

const VAGUE_GREP_INDICATORS = [
  /^how\s/i, /^what\s/i, /^where\s/i, /^why\s/i,
  /^find\s.*that/i, /\bworks?\b/i, /\bhandles?\b/i, /\bimplements?\b/i,
];

export function getGrepHint(pattern: string): string | null {
  if (VAGUE_GREP_INDICATORS.some((r) => r.test(pattern))) {
    return "[Hint] This grep pattern looks like a semantic query. Consider using a code search tool or reading relevant files directly.";
  }
  return null;
}

export function getFetchHint(): string {
  return "[Hint] For full page rendering, consider using the MCP web-fetch tool if available.";
}

// ─── Pre-Edit Guidance ────────────────────────────────────────────────────────

interface SidecarLike {
  memorySearch(opts: { query: string; project: string; limit: number }): Promise<Array<{
    id: number;
    title: string;
    type: string;
    timestamp: number;
    filePaths: string[];
  }>>;
}

/**
 * Query sidecar for file-specific observations and return a guidance hint.
 * Returns null if no relevant observations exist.
 */
export async function getPreEditGuide(
  sidecar: SidecarLike,
  filePath: string,
  projectRoot: string,
): Promise<string | null> {
  try {
    const basename = filePath.split("/").pop() ?? filePath;
    const results = await sidecar.memorySearch({
      query: basename,
      project: projectRoot,
      limit: 10,
    });

    const relevant = results.filter((r) =>
      r.filePaths?.some((fp) => fp === filePath || filePath.endsWith(fp) || fp.endsWith(filePath)),
    );

    if (relevant.length === 0) return null;

    const lines = [`[Sentinal] Context for ${basename}:`];
    for (const hit of relevant.slice(0, 5)) {
      const date = new Date(hit.timestamp).toISOString().split("T")[0];
      lines.push(`- [${hit.type}] ${date}: ${hit.title}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}
