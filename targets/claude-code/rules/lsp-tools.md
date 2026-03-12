# LSP Tools

Both Claude Code and OpenCode manage language servers automatically. Use the `LSP` tool proactively — don't wait for errors.

## When to Use LSP

| Situation | Operation |
|-----------|-----------|
| Before editing a function | `hover` — confirm type signature and docs |
| Before renaming a symbol | `findReferences` — find all call sites first |
| Understanding call hierarchy | `incomingCalls` / `outgoingCalls` |
| Jumping to a type definition | `goToDefinition` |
| Finding all implementations | `goToImplementation` |
| Viewing file's exported symbols | `documentSymbol` |
| Searching across the project | `workspaceSymbol` |

## Operation Reference

```
LSP({ operation: "hover",              file: "...", line: N, character: N })
LSP({ operation: "goToDefinition",     file: "...", line: N, character: N })
LSP({ operation: "findReferences",     file: "...", line: N, character: N })
LSP({ operation: "goToImplementation", file: "...", line: N, character: N })
LSP({ operation: "documentSymbol",     file: "..." })
LSP({ operation: "workspaceSymbol",    query: "SymbolName" })
LSP({ operation: "prepareCallHierarchy", file: "...", line: N, character: N })
LSP({ operation: "incomingCalls",      file: "...", line: N, character: N })
LSP({ operation: "outgoingCalls",      file: "...", line: N, character: N })
```

## Key Patterns

**Before editing an implementation file:**
```
LSP({ operation: "hover", file: "src/auth/auth.service.ts", line: 42, character: 10 })
```
Confirms the current type signature before you accidentally break callers.

**Before renaming a symbol:**
```
LSP({ operation: "findReferences", file: "src/auth/auth.service.ts", line: 42, character: 10 })
```
Find all usages first — rename all occurrences, not just the declaration.

**Call chain analysis (more accurate than grep):**
```
LSP({ operation: "incomingCalls", file: "src/auth/auth.service.ts", line: 42, character: 10 })
LSP({ operation: "outgoingCalls", file: "src/auth/auth.service.ts", line: 42, character: 10 })
```
Handles aliases, re-exports, and dynamic calls — grep misses these.

**Verify a new symbol is correctly exported:**
```
LSP({ operation: "documentSymbol", file: "src/auth/auth.service.ts" })
```

## Notes

- **Diagnostics are passive** — LSP pushes type errors automatically after file edits. No explicit call needed for basic error checking.
- **LSP availability** depends on `ENABLE_LSP_TOOL: "true"` in settings.json and `vtsls` being installed. If the `LSP` tool returns an error, fall back to grep/Read.
- For call chain analysis: prefer `incomingCalls`/`outgoingCalls` over grep — they handle path aliases and barrel re-exports correctly.
