# LSP Tools

Both OpenCode and Claude Code manage language servers automatically. Use the `lsp` tool proactively — don't wait for errors.

## When to Use LSP

| Situation                       | Operation                                    |
| ------------------------------- | -------------------------------------------- |
| Before editing a function       | `hover` — confirm type signature and docs    |
| Before renaming a symbol        | `findReferences` — find all call sites first |
| Understanding call hierarchy    | `incomingCalls` / `outgoingCalls`            |
| Jumping to a type definition    | `goToDefinition`                             |
| Finding all implementations     | `goToImplementation`                         |
| Viewing file's exported symbols | `documentSymbol`                             |
| Searching across the project    | `workspaceSymbol`                            |

## Operation Reference

**⛔ The path parameter is `filePath`, not `file`, and `line`/`character` are required on _every_ operation — including `documentSymbol` and `workspaceSymbol`, which ignore the position but still validate it. Both are 1-based, as shown in editors. A call using `file:` is rejected before it reaches the language server.**

```
lsp({ operation: "hover",                filePath: "...", line: N, character: N })
lsp({ operation: "goToDefinition",       filePath: "...", line: N, character: N })
lsp({ operation: "findReferences",       filePath: "...", line: N, character: N })
lsp({ operation: "goToImplementation",   filePath: "...", line: N, character: N })
lsp({ operation: "documentSymbol",       filePath: "...", line: N, character: N })
lsp({ operation: "workspaceSymbol",      filePath: "...", line: N, character: N, query: "SymbolName" })
lsp({ operation: "prepareCallHierarchy", filePath: "...", line: N, character: N })
lsp({ operation: "incomingCalls",        filePath: "...", line: N, character: N })
lsp({ operation: "outgoingCalls",        filePath: "...", line: N, character: N })
```

`query` applies to `workspaceSymbol` only. Always supply it — most language servers return nothing for an empty query. `filePath` still matters there: it selects which language server answers.

## Key Patterns

**Before editing an implementation file:**

```
lsp({ operation: "hover", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
```

Confirms the current type signature before you accidentally break callers.

**Before renaming a symbol:**

```
lsp({ operation: "findReferences", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
```

Find all usages first — rename all occurrences, not just the declaration.

**Call chain analysis (more accurate than grep):**

```
lsp({ operation: "incomingCalls", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
lsp({ operation: "outgoingCalls", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
```

Handles aliases, re-exports, and dynamic calls — grep misses these.

**Verify a new symbol is correctly exported:**

```
lsp({ operation: "documentSymbol", filePath: "src/auth/auth.service.ts", line: 1, character: 1 })
```

## When LSP Cannot Answer

Work down this order and stop at the first rung available:

1. **LSP** — as above. Compiler-accurate.
2. **A catalogued code-graph capability** — check `.sentinal/rules/{slug}-mcp-servers.md` for the block marked `SENTINAL GRAPH TOOLS`. `/sync` writes it from smoke-testing this project's own servers, and it records the invocation that was actually verified. Never rely on a row marked ⚠️ unverified.
3. **Grep, as a last resort** — it matches text, not symbols, so it misses aliased imports, barrel re-exports and dynamic dispatch, and over-reports identically-named symbols from unrelated modules. Its result is a lower bound; never conclude "nothing calls this" from grep alone.

## Notes

- **Diagnostics are passive** — LSP pushes type errors automatically after file edits. No explicit call needed for basic error checking.
- **LSP availability** depends on a language server being configured (`typescript-language-server --stdio` in opencode.json). If the `lsp` tool returns an error, fall back down the order above.
- For call chain analysis: prefer `incomingCalls`/`outgoingCalls` over grep — they handle path aliases and barrel re-exports correctly.
