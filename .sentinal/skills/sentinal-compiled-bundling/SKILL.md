---
name: sentinal-compiled-bundling
description: |
  Recipes for loading npm packages with native/deep dependencies inside
  bun --compile binaries. Use when: (1) a compiled binary throws
  "Cannot find module '<pkg>' from '/$bunfs/root/...'", (2) an external
  on-disk module fails with "Cannot find module <its-own-dep>" when imported
  from a compiled binary, (3) bundling a package that pulls in sharp or
  onnxruntime, (4) "dlopen ... Library not loaded: @rpath/..." after bundling
  a .node file.
author: Claude Code
version: 1.0.0
---

# Bundling Native-Dep Packages for bun --compile Binaries

## When to Use

- A `bun build --compile` binary must load a package that cannot be bundled
  at compile time (native `.node` addons, huge optional deps, runtime-provisioned).
- Errors matching:
  - `Cannot find module 'X' from '/$bunfs/root/<binary>'` — bare import inside the binary
  - `Cannot find module '@huggingface/jinja' from '<deps>/node_modules/...'` — external file's own bare imports
  - `dlopen(...hash.node): Library not loaded: @rpath/lib...dylib` — bundler copied a .node away from its dylibs

## Core Facts (all verified 2026-06-10, Bun 1.3.10)

1. **Compiled binaries do NOT walk node_modules** for bare specifiers — not for
   their own externals, not for imports inside external on-disk files, and
   `createRequire(anchor-in-deps-dir)` is equally blocked.
2. **Node builtins DO resolve** (`fs`, `path`, `crypto`, `worker_threads`...).
3. **Relative-path requires of `.node` files from external on-disk modules WORK**
   — resolved relative to the file's real location.
4. Therefore: flatten the package into ONE self-contained ESM file at setup
   time; only builtin imports may remain; native artifacts live in the
   expected RELATIVE layout next to the bundle.

## Solution

The product implementation is `src/memory/setup-bundle.ts` (`buildTransformersBundle`)
— copy its recipe for new packages:

**Bun path** (preferred; spawn system `bun`, never `Bun.build` in-process — the
compiled binary can't bundle):

```ts
await Bun.build({
  entrypoints: ["<deps>/node_modules/<pkg>/<entry>.js"],
  target: "node", format: "esm",
  plugins: [{ name: "stub-sharp", setup(b) {
    b.onResolve({ filter: /^sharp$/ }, () => ({ path: "s", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default null;", loader: "js" }));
  }}],
});
```

**esbuild fallback** (CLI only, no JS API needed):

```bash
npx -y esbuild <entry> --bundle --format=esm --platform=node \
  --alias:sharp=<stub-file.js> \
  --external:*.node \
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=<out>.mjs
```

**Native layout:** keep `.node` requires RELATIVE (external), then replicate the
package's expected tree next to the bundle. For onnxruntime-node the bundle at
`<deps>/bundle/x.mjs` requires `../bin/napi-v3/<os>/<arch>/onnxruntime_binding.node`
→ `cp -R <deps>/node_modules/onnxruntime-node/bin <deps>/bin`.

## Gotchas That Cost Hours

| Symptom | Cause | Fix |
| --- | --- | --- |
| sharp's "npm ls sharp" help error at import | transformers imports sharp eagerly (images only) | Alias/stub to `export default null;` — `.default` must exist |
| esbuild `No loader for .node` | `.node` referenced in source | `--external:*.node` (NOT `--loader:.node=copy` — copies break `@rpath` dylib siblings) |
| esbuild ESM output: require is not defined | externals use require() | the createRequire banner above |
| Bundle imports fine under bun, fails in binary | smoke ran under bun only | smoke-test inside a tiny compiled test binary: `bun build --compile main.ts` where main.ts imports the bundle path from argv |

## Verification

```bash
# 1) Residual bare imports must be builtins only:
grep -oE 'require\("[^./"][^"]*"\)|from ?"[^./"][^"]*"' bundle.mjs | sort -u
# 2) Compiled-binary import+use smoke (NOT just bun):
bun build --compile /tmp/probe.ts --outfile /tmp/probe && /tmp/probe <bundle-path>
```

## When NOT to Use

- The package is pure JS with no deep deps → just bundle it into the binary normally.
- Running from source with node_modules present → bare imports work; no bundle needed.
- Windows targets (no sentinal release binaries; layouts unverified).

## References

- `src/memory/setup-bundle.ts`, `src/memory/native-deps.ts` (resolution chain)
- Plan: `docs/plans/2026-06-10-compiled-binary-semantic-search.md` (SPIKE-PROVEN section)
- Memory #138, #131
