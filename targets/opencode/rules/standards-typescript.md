## TypeScript Development Standards

**Auto-detect package manager from lockfile:** pnpm-lock.yaml -> pnpm | yarn.lock -> yarn | bun.lockb -> bun | package-lock.json -> npm. Use the detected manager for all install/run commands.

### Type Safety

- **Strict mode always:** `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes` must be enabled
- **No `any`:** Never use `any`. Use `unknown` for truly unknown types, then narrow with type guards
- **Explicit return types** on all exported functions and public methods
- **No type assertions** (`as Type`) unless unavoidable - prefer type guards (`if (isType(x))`)
- **Discriminated unions** over optional properties for variant types
- **`satisfies` operator** for type checking without widening

### Code Style

- **`const` over `let`** - mutable variables are the exception, not the rule
- **Destructuring** for object/array access
- **Template literals** over string concatenation
- **`node:` prefix** for all Node.js built-in imports (`import { readFile } from 'node:fs'`)
- **kebab-case filenames** (`user-service.ts`, not `UserService.ts` or `user_service.ts`)
- **Barrel exports** (`index.ts`) for module public APIs

### Patterns

- **Early returns** over nested conditionals
- **Pure functions** where possible - minimize side effects
- **Dependency injection** over global state or direct imports
- **Error handling:** Typed errors extending `Error`, never throw strings
- **Async/await** over raw Promises - no `.then()` chains

### Imports

- **Organize imports:** Node built-ins -> external packages -> internal modules -> relative imports
- **No circular imports** - if detected, refactor the dependency graph
- **Type-only imports** with `import type { ... }` when importing only types

### Testing

- **Every exported function needs tests** - no exceptions
- **Test naming:** `describe("functionName", () => { it("should behavior when condition") })`
- **Mock external dependencies only** - never mock the module under test
- **Assert outcomes, not implementation** - test what it does, not how
