/**
 * The closed `${SENTINAL_*}` interpolation namespace (D6, narrowed).
 *
 * Split out of `schema.ts` because it is a self-contained concept with two
 * halves that are deliberately kept apart: **validating** token names (which
 * the zod schema does, with no slot in hand) and **substituting** them (which
 * the loader does, once `readSlotFromWorktree` has produced a slot). The slot
 * simply does not exist at parse time, so fusing the two would force the
 * schema to accept a parameter it has no business having.
 *
 * ## ⛔ The rule, precisely
 *
 * Sentinal owns the `SENTINAL_` prefix and **nothing else**:
 *
 * | In `up` / `down` / `readiness.target` | Behaviour                        |
 * | ------------------------------------- | -------------------------------- |
 * | `${SENTINAL_WORKTREE_SLOT}`           | substituted by Sentinal          |
 * | any other `${SENTINAL_*}`             | **validation error naming it**   |
 * | `${PORT:-3000}`, `${DOCKER_HOST}`     | passed to the shell **verbatim** |
 * | bare `$VAR`                           | passed to the shell **verbatim** |
 *
 * A blanket "any unknown `${TOKEN}` is an error" rule was rejected in both
 * directions. It would **reject legitimate shell** — `PORT=${PORT:-3000} npm
 * start` is a command projects already have, with no escape hatch specified —
 * and it would **not catch the hazard used to justify it**: `rm -rf $UNSET/`
 * is bare-dollar syntax that a `${...}` matcher never sees. Bare `$VAR` is
 * therefore explicitly out of scope; the shell handles it, as it does for
 * every other command a project runs.
 *
 * What the narrowed rule *does* buy is the real risk: a typo'd
 * `${SENTINAL_WORKTREE_SLOTT}` silently expanding to the empty string and
 * pointing a worktree at slot-less — i.e. the main checkout's — resources.
 *
 * There is **no `process.env` fallthrough inside the prefix**: an unset
 * `SENTINAL_*` name is an error, not a lookup.
 *
 * ## Two expansion layers
 *
 * Phase 2 writes a sourceable `SENTINAL_WORKTREE_SLOT=<n>` into
 * `<worktree>/.sentinal/worktree.env` (`slots.ts`), so the same token could in
 * principle be expanded twice — once by Sentinal at load time, once by the
 * shell at exec time. **Sentinal's load-time substitution wins**: by the time
 * a command reaches the shell the literal token is already gone. Phase 4
 * should *additionally* export `SENTINAL_WORKTREE_SLOT` into the spawn
 * environment so scripts invoked *by* `up` can read it — that is purely
 * additive and cannot change an already-substituted string.
 */

/** The one token Sentinal substitutes. Sourced from Phase 2's slot. */
export const SLOT_TOKEN = "SENTINAL_WORKTREE_SLOT";

/** The complete closed set. Adding to it is a deliberate, reviewable act. */
export const SENTINAL_TOKENS = [SLOT_TOKEN] as const;
export type SentinalToken = (typeof SENTINAL_TOKENS)[number];

/** The fields subject to interpolation — exactly these three. */
export const INTERPOLATED_FIELDS = ["up", "down", "readiness.target"] as const;

/**
 * Matches `${SENTINAL_...}` and nothing else.
 *
 * `[^}]*` rather than `\w*` on purpose: `${SENTINAL_FOO:-bar}` must be *seen*
 * so it can be *rejected*, not skipped as "not a token". Shell-defaulting a
 * token Sentinal has already substituted is ambiguous, and ambiguity in a
 * string that becomes a shell command is not worth preserving.
 */
const SENTINAL_TOKEN_RE = /\$\{(SENTINAL_[^}]*)\}/g;

/**
 * Every `${SENTINAL_*}` token in `text` that is not in the closed set,
 * returned with its braces so error messages are copy-pasteable.
 */
export function unknownSentinalTokens(text: string): string[] {
  const known = new Set<string>(SENTINAL_TOKENS);
  const out: string[] = [];
  for (const m of text.matchAll(SENTINAL_TOKEN_RE)) {
    if (!known.has(m[1]!)) out.push(m[0]!);
  }
  return out;
}

/** The one message shape, so every surface says the same thing. */
export function unknownTokenMessage(tokens: string[], field: string): string {
  return (
    `Unknown Sentinal token(s) in \`${field}\`: ${tokens.join(", ")}. ` +
    `Sentinal substitutes exactly one token: \${${SLOT_TOKEN}}. ` +
    `Anything else under the SENTINAL_ prefix is a typo, not a variable — it is ` +
    `rejected rather than substituted with an empty string, because an empty ` +
    `substitution into a shell command points the worktree at the WRONG resources ` +
    `silently. Non-SENTINAL_ tokens (\${PORT:-3000}, \${DOCKER_HOST}) and bare ` +
    `$VAR are passed through to the shell verbatim and need no change.`
  );
}

/**
 * Substitute the closed token set in a validated command string.
 *
 * @param slot the worktree's slot, or `null` when it has none. With `null` the
 *   placeholder is **left in place** — the same choice Phase 2's
 *   `unsubstitutedPlaceholderWarning` makes, because substituting an empty or
 *   invented value silently points the worktree at a resource that is not its
 *   own. The loader turns that into a visible warning.
 * @throws if an unknown `${SENTINAL_*}` token survives. The schema rejects
 *   these already; this is defence in depth for a hand-built config object
 *   that never went through `RuntimeConfigSchema`.
 */
export function interpolateStrict(text: string, slot: number | null): string {
  const unknown = unknownSentinalTokens(text);
  if (unknown.length > 0) {
    throw new Error(unknownTokenMessage(unknown, "runtime command"));
  }
  if (slot === null) return text;
  return text.split(`\${${SLOT_TOKEN}}`).join(String(slot));
}
