---
name: sentinal-parity-baselines
description: |
  Regenerating cross-target parity baselines rewrites the ENTIRE fixture directory,
  not the one .diff you edited — so two concurrent tasks silently poison each other's
  baseline and the checks still pass. Use when: (1) editing any file under
  `targets/*/commands/`, `targets/*/skills/`, or `targets/*/rules/`, (2) a
  `target-parity.test.ts` case fails with "Cross-target parity for X changed",
  (3) planning waves where more than one task touches `targets/`, (4) deciding
  whether to add a rule to `IDENTICAL_RULES`, (5) `spec-verify.diff` is no longer
  0 bytes.
author: Claude Code
version: 1.0.0
---

# Parity Baselines

## When to Use

Any edit under `targets/`, and any wave-planning decision involving more than one
such edit.

## The Trap

`src/cli/target-parity.test.ts` gates on `UPDATE_PARITY_BASELINES === "1"` for the
**whole suite run**. Regeneration therefore rewrites **every** fixture in
`src/cli/__fixtures__/target-parity/`, not just the pair you changed.

⛔ **At most ONE baseline-regenerating task per wave.** Two concurrent tasks in a
shared working directory each bake in the other's half-finished markdown, and the
"hunk count unchanged" check then passes against a **poisoned** baseline. This is a
silent corruption, not a test failure.

Second trap: **editing a command file always shifts its `.diff`** even when applied
perfectly symmetrically, because the normalised diff embeds absolute line numbers. A
changed `@@` header is expected; a changed hunk **count** is not.

## Solution

**1. Apply the edit to both targets identically.** Note the offsets — they come from
frontmatter and must not change:

| Pair             | CC→OC offset |
| ---------------- | ------------ |
| `spec-plan`      | −3           |
| `spec-implement` | −4           |
| `sync`           | −2           |

Verify a region is identical before regenerating:

```bash
diff <(sed -n '/## Phase 7/,/## Phase 8/p' targets/claude-code/commands/sync.md) \
     <(sed -n '/## Phase 7/,/## Phase 8/p' targets/opencode/commands/sync.md)
```

**2. Run prettier on the edited files FIRST.** Shipped `targets/**/*.md` are
prettier-clean, and prettier reformats _inside_ ` ```markdown ` fences
(`embeddedLanguageFormatting: auto`). Skipping this means a later format pass
perturbs the fixtures.

```bash
bunx prettier --write targets/claude-code/commands/sync.md targets/opencode/commands/sync.md
```

⛔ **Never `bunx prettier --write` project-wide, and never call `quality_report`** —
the repo is not prettier-clean at HEAD; a project-wide write reformats ~85 unrelated
files.

**3. Regenerate once, at the end:**

```bash
UPDATE_PARITY_BASELINES=1 bun test src/cli/target-parity.test.ts
```

**4. Verify hunk counts are unchanged.** Expected state:

```
spec-bugfix-plan 1 · spec-implement 4 · spec-master-execute 3
spec-plan 1 · spec 2 · sync 1
learn / pause / quick / spec-bugfix-verify / spec-master-plan / spec-verify → 0 hunks, 0 bytes
```

**A second hunk appearing means you applied the edit one-sidedly.**

**5. Never write `Skill(skill="sentinal:…")` (double-quoted) in new content.** The
normaliser strips only the single-quoted form, so a double-quoted one survives and
adds a spurious hunk — that is how the recorded `sync` divergence arose.

**6. Run `bun run embed-assets`** after any `targets/` edit (`src/cli/embedded-assets.ts`
is gitignored and generated; without it `bunx tsc --noEmit` reports ~10 spurious
`TS2307`).

**7. If you edited both copies of a rule, add it to `IDENTICAL_RULES`** — the array's
own docstring makes this mandatory. If the two legitimately differ per-target, leave
it out and add a comment saying why.

## Verification

```bash
for f in src/cli/__fixtures__/target-parity/*.diff; do
  printf "%-28s %s hunks  %s bytes\n" "$(basename $f)" "$(rg -c '^@@' $f || echo 0)" "$(wc -c < $f)"
done
wc -c src/cli/__fixtures__/target-parity/spec-verify.diff   # MUST be 0
bun test src/cli/target-parity.test.ts
```

## When NOT to Use

- Edits confined to `src/` — no fixture involvement.
- `targets/*/rules/lsp-tools.md` — it **legitimately differs** between targets
  (`LSP(` vs `lsp(`; both platforms ship the tool, the casing is real). Do NOT force
  byte-identity or add it to `IDENTICAL_RULES`.
- `spec-verify` / `spec-bugfix-verify` LSP text — it is in `MUST_STAY_BYTE_EQUAL`,
  is accurate about Sentinal's own `LspClient` ("~10 open files" matches
  `lsp-client.ts:196`), and is asserted by `src/cli/spec-verify-full-tsc.test.ts`.

## Example

```
Change:  added 11 lines to Phase 7 in BOTH sync.md copies
Result:  sync.diff's only delta was @@ -600 → @@ -610. Hunk count stayed 1.
         Every other fixture byte-identical. spec-verify.diff still 0 bytes.
Wrong:   two tasks in one wave both running UPDATE_PARITY_BASELINES=1 — each
         captures the other's partial edit, all checks pass, drift ships.
```

## References

- `src/cli/target-parity.test.ts` — `PAIRS`, `OPENCODE_COMMAND_PAIRS`,
  `IDENTICAL_RULES`, `MUST_STAY_BYTE_EQUAL`, and the normaliser
- `src/cli/__fixtures__/target-parity/` — the baselines
- `.sentinal/rules/sentinal-dual-target.md`, `.sentinal/rules/sentinal-targets-vs-src.md`
