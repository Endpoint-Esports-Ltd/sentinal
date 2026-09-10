# LSP Tools

Both Claude Code and OpenCode manage language servers automatically. Use the `LSP` tool proactively — don't wait for errors.

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
LSP({ operation: "hover",                filePath: "...", line: N, character: N })
LSP({ operation: "goToDefinition",       filePath: "...", line: N, character: N })
LSP({ operation: "findReferences",       filePath: "...", line: N, character: N })
LSP({ operation: "goToImplementation",   filePath: "...", line: N, character: N })
LSP({ operation: "documentSymbol",       filePath: "...", line: N, character: N })
LSP({ operation: "workspaceSymbol",      filePath: "...", line: N, character: N, query: "SymbolName" })
LSP({ operation: "prepareCallHierarchy", filePath: "...", line: N, character: N })
LSP({ operation: "incomingCalls",        filePath: "...", line: N, character: N })
LSP({ operation: "outgoingCalls",        filePath: "...", line: N, character: N })
```

`query` applies to `workspaceSymbol` only. Always supply it — most language servers return nothing for an empty query. `filePath` still matters there: it selects which language server answers.

## Key Patterns

**Before editing an implementation file:**

```
LSP({ operation: "hover", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
```

Confirms the current type signature before you accidentally break callers.

**Before renaming a symbol:**

```
LSP({ operation: "findReferences", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
```

Find all usages first — rename all occurrences, not just the declaration.

**Call chain analysis (more accurate than grep):**

```
LSP({ operation: "incomingCalls", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
LSP({ operation: "outgoingCalls", filePath: "src/auth/auth.service.ts", line: 42, character: 10 })
```

Handles aliases, re-exports, and dynamic calls — grep misses these.

**Verify a new symbol is correctly exported:**

```
LSP({ operation: "documentSymbol", filePath: "src/auth/auth.service.ts", line: 1, character: 1 })
```

## When LSP Cannot Answer

Work down this order and stop at the first rung available:

1. **LSP** — as above. Compiler-accurate.
2. **A catalogued code-graph capability** — check `.sentinal/rules/{slug}-mcp-servers.md` for the block marked `SENTINAL GRAPH TOOLS`. `/sync` writes it from smoke-testing this project's own servers, and it records the invocation that was actually verified. Never rely on a row marked ⚠️ unverified.
3. **Grep, as a last resort** — it matches text, not symbols, so it misses aliased imports, barrel re-exports and dynamic dispatch, and over-reports identically-named symbols from unrelated modules. Its result is a lower bound; never conclude "nothing calls this" from grep alone.

## Notes

- **Diagnostics are passive** — LSP pushes type errors automatically after file edits. No explicit call needed for basic error checking.
- **LSP availability** depends on `ENABLE_LSP_TOOL: "true"` in settings.json and `vtsls` being installed. If the `LSP` tool returns an error, fall back down the order above.
- For call chain analysis: prefer `incomingCalls`/`outgoingCalls` over grep — they handle path aliases and barrel re-exports correctly.
