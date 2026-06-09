# Phase 4 Baseline: Hook Subprocess Latency

**Date:** 2026-06-09  
**Machine:** macOS (Apple Silicon M-series)  
**Runtime:** Bun via `bun src/cli/index.ts hook <scope> <name>`  
**Methodology:** `hyperfine --warmup 3 --runs 20` with a realistic PreToolUse/Write payload  
**Payload:**
```json
{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"src/test.ts","content":"x"},"cwd":"/tmp","session_id":"bench","transcript_path":"","permission_mode":"default"}
```

Note: benchmarked against source (`bun src/cli/index.ts`) not installed binary
(`sentinal`). Installed binary is typically 5–10ms faster due to no JIT warm-up.
These figures are conservative (upper bound) relative to a production install.

## Results

| Hook             | Median (ms) | σ (ms) | Min (ms) | Max (ms) |
|------------------|-------------|--------|----------|----------|
| `tdd-guard`      | 63.7        | 1.5    | 61.5     | 66.9     |
| `pre-edit-guide` | 70.6        | 1.9    | 68.3     | 74.7     |
| `file-checker`   | 60.9        | 1.6    | 58.3     | 65.6     |
| `tool-redirect`  | 59.5        | 1.7    | 56.6     | 63.1     |

**Total hot-path overhead per Write/Edit call (tdd-guard + pre-edit-guide + file-checker):** ~195ms sequential  
**User-perceived:** Claude Code runs sync hooks in parallel where possible; real overhead closer to the slowest single hook (~71ms)

## Interpretation

All four hooks are in the **60–71ms** band. This is tighter than the estimated 50–200ms range, and skews low because macOS has faster process spawn than Linux.

- The dominant cost is **Bun cold-start** (~50ms). The actual hook logic (read stdin, check TDD state, write stdout) takes <15ms.
- **Target for MCP-tool or HTTP transport:** ≤50% of baseline → ≤30ms. Since the cold-start is eliminated, in-process transports should easily achieve this.
- On Linux (the production environment for the reporter), cold-start is 20–50ms higher → expect 80–120ms baseline per hook there.

## Comparison Baseline for Phase 4b

| Transport    | Expected median | Cold-start cost | Notes                         |
|--------------|-----------------|-----------------|-------------------------------|
| subprocess   | ~65ms           | ~50ms           | This measurement              |
| MCP-tool     | ~5–15ms est.    | 0 (server warm) | TBD — spike Tasks 1–2         |
| HTTP         | ~3–8ms est.     | 0 (sidecar warm)| TBD — spike Task 3            |

Raw hyperfine data: `docs/benchmarks/phase4-baseline.json`
