# Performance: with vs without Agentic Tool Catalog

Measured 2026-11-11 on DSH `0.2.2-rc.1` (desktop profile), model `deepseek-flash`, Google Workspace MCP online.
Same 5 tasks × 2 independent sessions per arm; verified independently.

- **baseline (without on-demand catalog)**: all 122 tools resident, every request carries every schema.
- **treatment (this plugin)**: 31 resident tools + a short catalog note; 92 deferred tools loaded on demand.

| Metric | baseline | treatment | Change |
|---|---:|---:|---:|
| Task pass rate | 100% (10/10) | 100% (10/10) | equal |
| First-request tools | 122 | 31 | −74.6% |
| First-request tool-schema chars (payload) | 131,390 | 21,877 | **−83.3%** |
| **First-request real prompt tokens** (usage, not estimate) | **49,504** | **18,536** | **−62.6% (−30,968 tokens/request)** |
| Max request schema chars | 131,390 | 34,785 | −73.5% |
| Avg total tokens / session | 452,463 | 268,551 | **−40.6%** |
| Avg steps | 7.40 | 7.90 | +6.8% |
| Avg cost / session | $0.0112 | $0.0116 | +3.7% (≈flat) |
| Avg wall time | 37.0s | 33.3s | −9.9% |
| Avg `search_tools` calls | 0.10 | 1.30 | +1.2/session |

**Headline**: same task success, **−83.3% tool-schema payload, −62.6% real first-request prompt tokens
(−30,968 tokens/request)**, and **−41% total session tokens**; the cost is ~1.2 extra catalog searches per session and +7% steps.
Cost/wall differences are within run-to-run noise.


Quality (same runs, from the discovery output):

| Metric | baseline | treatment |
|---|---:|---:|
| Target capability hit | 10/10 | 10/10 |
| missedCapability | 0 | 0 |
| Searches / session | 0.10 | 1.30 |
| Setup searches before target call | 0 | 1.20 |
| Tools loaded / search | — | 9.2 |
| Loaded tools actually used | — | 1.9 |
| loadedUsedRatio | — | **0.289** |

Honest read: the catalog trades "see a little more" for "carry much less"; search currently loads ~9 tools and
uses ~2, so the loaded-used ratio is a tuning target (tighter `maxResults`/ranking), not something hidden here.

Notes:
- One-time generation (per catalog version, background) is not included in task metrics; it is cached in official
  DSH Storage and reused across sessions/restarts, with incremental regeneration on catalog changes.
- This card does **not** claim cost savings: cost is ~flat (+3.7%); it saves context/tokens. Sample is 5 tasks ×
  2 runs, one model (`deepseek-flash`), one profile — not a cross-model claim.
- Catalog generation is a one-time background cost and is **not** included in the task metrics; its exact
  token/cost instrumentation is future work (no precise number is claimed).
- Tasks: `host-ops-session-list`, `docs-workers-limit`, `terminal-echo`, `goal-set`, `docs-d1-storage`.
  `workspace-calendar-count` is excluded from the main table because it depends on MCP availability.
- First-request token figures come from real session usage (`inputTokens + cacheReadTokens`); schema chars are a
  payload-size metric, **not** a chars/4 token estimate.
- Full methodology and raw results: `benchmark/data-card.md` and `benchmark/results/` in the
  source repository.
