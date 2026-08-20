/**
 * Minimal JSONC support for `.sentinal/runtime.json`.
 *
 * ## Why a `.json` file accepts comments
 *
 * The scaffolder's governing rule is "prefer leaving a field empty **with a
 * comment** over guessing" — so the file Sentinal itself drafts is JSONC by
 * construction, and a loader that rejected comments would reject Sentinal's
 * own output. Beyond that, this is a hand-edited config: the explanation of
 * *why* `isolation` is unset is worth more sitting next to the field than in a
 * README nobody opens.
 *
 * The extension stays `.json` because every editor, `jq` pipeline and CI
 * linter already knows what to do with it, and JSONC is a strict superset for
 * reading purposes.
 *
 * ## Deliberately NOT supported
 *
 * **Trailing commas.** Nothing Sentinal emits produces one, and accepting them
 * would quietly widen the dialect a project's other tooling has to agree with.
 * A trailing comma therefore surfaces as an ordinary JSON parse error.
 */

/**
 * Remove `//` line comments and block comments, preserving everything else —
 * including newlines, so parse-error line numbers still point at the right
 * line of the original file.
 *
 * String-aware, which is the whole difficulty: `"curl http://localhost/x"`
 * contains a `//` that is emphatically not a comment, and a naive regex would
 * silently truncate a readiness target to `"curl http:`.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const c = text[i]!;

    if (inString) {
      out += c;
      if (c === "\\") {
        // Consume the escaped character wholesale, so `\"` does not look like
        // a string terminator and `\\` does not swallow the real one.
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue; // the "\n" itself is emitted by the next iteration
    }

    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        // Keep newlines so line numbers survive a multi-line comment.
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i += 2; // past the closing */ — or past the end, if unterminated
      continue;
    }

    out += c;
    i++;
  }
  return out;
}
