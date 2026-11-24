# Changelog

## 0.3.8 — 2026-11-24

Fix: a tool whose description changed (same name) left stale text in the catalog, so `search_tools` could
miss wording that only exists in the new description. 0.3.7 deliberately keeps grouping/generation keyed
by tool names, so description-only changes never reached the catalog.

- **Silent local description refresh.** `rebuild()` now also compares a description key
  (`catalog.descriptionKeyOf()`: names + descriptions, deliberately **not** part of the generation/cache
  fingerprint). When tool names are unchanged but a description differs, `refreshToolDescriptions()`
  updates the existing catalog entries in place: grouping, source, warnings and the restriction stay
  untouched, no generation starts, `lastGood`/`lastOkAt` do not move, and no warning is added
  (`generation.descriptionRefreshes` counts refreshes). If an upstream MCP keeps rewording descriptions
  on every token refresh, this is a cheap in-memory entry update, not a generation storm.
- **Boundaries unchanged.** Tool names still decide grouping and generation: additions generate, removals
  are applied locally (0.3.7), a missing history bootstraps + generates. The description key only triggers
  the in-place refresh; a catalog that is bootstrapping/stale keeps its source and warnings, and a refresh
  racing an in-flight generation is applied by the next rebuild.
- **Tests.** Unit suite 152/152 (was 141/141): description key order-insensitivity/content sensitivity,
  in-place entry refresh (grouping/source/warnings preserved, changed count, no-op and empty-catalog
  cases), and `search_tools` ranking against the refreshed description. Real-package suite 73/73 (was
  65/65): after removing and re-adding tools in the fake-host session, a description-only `tools/change`
  must not start a child, must not move `generation.runs`/`lastOkAt`, must not count as a removal skip,
  and the reworded term must be searchable afterwards. Activation matrix 33/33 and compliance A=0 B=0
  unchanged; `npm run test:presentation` passes.
- **Scope.** Only this repository changed; no package was published.

## 0.3.7 — 2026-11-24

Fix: catalog changes that only *removed* tools still spawned real `agentic-tool-catalog generation`
sub-agents that were told to return the existing grouping unchanged. An idle session
(`session-0c553b7d-a424-4e07-aa95-b6768d682f92`, 2026-11-23 18:00 → 11-24 10:40) produced 21
`origin=subagent` children in 50-minute steps; 16 of them had `New tools = []` while the current tool
count only decreased (80 → 65). The cause was our own trigger, not the upstream MCP: `rebuild()`
compared only the name-set fingerprint and started a generation whenever it changed, without telling
additions from removals.

- **Removal-only changes are now applied locally.** `lib/generation.js` classifies the change
  (`diffToolCatalog()`: `added` = current names − last grouped names, `removed` = the reverse) and
  `resolveCatalogChange()` returns mode `local` when `added` is empty. `rebuild()` then filters the
  last successful grouping through the same `adaptAgentGroups()` used for stale fallback (removed
  members dropped, empty groups dropped, leftover ungrouped tools → `others`), still updates the
  fingerprint, re-applies the restriction, publishes the snapshot — and does not call
  `startEnrichment()`. `needsEnrichment` stays `false`, so the next prompt/search cannot restart it.
- **Boundaries.** Any added tool (even together with removals) still generates; no previous grouping
  (first run / failed fallback) still goes bootstrap + generation; an empty deferred set keeps the
  existing empty-catalog branch; a forced rebuild with an unchanged set is also local.
- **Observability, not fake success.** A skip is not recorded as `catalog-generated` and does not move
  `generation.lastOkAt` or `lastGood`. `catalog.source` becomes `agent-adapted`,
  `generation.removalOnlySkips` counts skips, and a `catalog-removal-only` warning names the removed
  tools (an upstream tool disappearing is still visible instead of silently normalized). Tools that
  vanish while in `session.loaded` are pruned (`generation.loadedPruned`); the restriction deny list is
  derived from catalog entries, so a removed tool can never stay denied forever.
- **One local-adapt implementation.** Both the new removal-only path and the existing failed-generation
  fallback call `resolveCatalogChange()` → `adaptAgentGroups()` (the latter now takes
  `{ source, warning }`); filtering/warning logic is not duplicated.
- **Tests.** Unit suite 141/141 (was 107/107): removal-only decision (`needsGeneration=false`, empty
  group dropped, warning + source, no `catalog-generated`), pure addition, addition+removal, no-history
  bootstrap, failed-generation fallback, `diffToolCatalog`, `pruneLoadedTools`. Real-package suite
  65/65 (was 43/43): drives the real `apply()` end to end with a fake tool service, fake agent and fake
  subagent host — initial generation, then a `tools/change` removal must not start a second child, must
  not move `lastOkAt`, must prune the removed tool from `session.loaded`, and must keep the next idle
  prompt (`agent/inbox/claimed`) from restarting generation; then an addition must generate again. Activation matrix 33/33 and
  compliance A=0 B=0 unchanged; `npm run test:presentation` passes.
- **Deliberately not done: time-window coalescing.** Grouping several changes within ~5 minutes into
  one generation was considered and left out: the generation queue already merges same-fingerprint
  requests, caps app-wide concurrency and backs off failures, while a debounce timer would delay
  legitimate new-tool grouping and add timer state the current design avoids. Pure removals were the
  observed waste and are now free without a timer.
- **Known trade-offs (unchanged).** The fingerprint still hashes tool **names** only, so a description
  change with an unchanged name does not trigger regeneration. Removal-only adaptations are not
  persisted as a new successful generation: the next session diffs against the untouched last-good
  grouping and skips generation as well (one generation happens again only after a later addition
  creates a new grouping).
- **Scope.** Only this repository changed; no package was published, and the daily profile / other
  repositories were not modified.

## 0.3.6 — 2026-11-16

Fix: catalog generation could leave real sub-agent sessions running past the timeout and accumulate
them forever. First reported from a dsh-dev session (919 leaked `origin=subagent` sessions; one
generation ran 4.5 min with `catalogTimeoutMs=120000`), then reproduced locally before the fix.

- **Timeout now cancels the child.** `startActivation()`'s `signal` is documented as pre-publication
  cancellation only ("callers own later cancellation through dispose"): aborting it after the
  activation is published does not stop the child turn. The old code did `abort()` +
  `await activation.result`, so a timed-out generation kept running to natural completion (4.5 min
  observed) and disposed only afterwards. `generate()` now races start/result against a real
  deadline; on timeout it calls `subagents.interrupt(childId, { kind: 'ancestor', agent })`, then
  awaits `activation.dispose()` (cancel → whenIdle → flush → release) under a bounded teardown grace
  (`GENERATION_TEARDOWN_GRACE_MS`, 15 s) and returns `TIMEOUT`. No retry on timeout. An activation
  published after the deadline (including one microtask after the abort) is still released and
  archived — the teardown hook does not depend on the start promise's settle flag.
- **Child sessions are archived after every attempt.** A `spawn` activation creates a durable
  `origin=subagent` session; the plugin never cleaned them up. Each attempt (success, validation
  retry, timeout) now retires its child through the official Workspace lifecycle:
  `workspaceRegistry.archiveSession(childId, { stopActivity: true })` — hidden from session lists,
  residual work stopped. Config: `catalogArchiveChildSessions` (default `true`; turn off for debugging).
  The archive wait is bounded (`GENERATION_ARCHIVE_TIMEOUT_MS`, at most 5 s): a stuck workspace
  write/stop provider can never hold the process-wide generation slot forever; archive continues in
  the background and is counted when it lands.
- **Process-wide generation limiter.** Old single-flight was per fingerprint only, so a rapidly
  changing tool set (or several sessions/presets) started one real sub-agent per fingerprint —
  7 concurrent catalog children were observed. A process-level queue now enforces
  `catalogMaxConcurrentGenerations` (default 1, clamped to 1..4), merges same-fingerprint requests
  across sessions, keeps at most one pending request (newest wins; stale pending resolves as
  skipped), and makes pre-warm best-effort: it runs only while the queue is idle; otherwise the
  restored session's first prompt/search triggers an on-demand run. Queue state is exposed in
  `catalog_status.generation.queue`.
- **Exponential failure backoff.** A failed generation left the session in `needsEnrichment`, so
  every later prompt or scheduled message retried after the fixed 10-minute backoff indefinitely.
  Backoff now doubles per consecutive failure (10 min → 20 min → … capped at 6 h) and resets on
  success.
- **Incremental prompt hardening.** Incremental generation now prefers the grouping cached for the
  *same* fingerprint instead of another catalog's `lastGood`, and both prompts state that this is a
  pure classification task (no tool calls / workspace inspection; return unchanged when nothing is
  new). Observed children spent minutes inspecting the live catalog and storage before timing out.
- **Cache eviction.** `tables.catalogs` had no cap (226+ fingerprints and growing). It now keeps at
  most `catalogCacheMaxEntries` (default 64), evicting the oldest `createdAt` from memory and
  official Storage; hydration prunes too. `storage` status reports `entries` / `maxEntries` / `evicted`.
- **Observation.** `generation` status adds `timeouts`, `sessionsArchived`,
  `sessionArchiveFailures`, `generationSkipped` and the queue snapshot; `storage` adds the counters above.
- **Tests.** Unit suite 107/107 (was 77/77): timeout cancellation / no residual child, late-activation
  cleanup after a startup timeout (including the abort→microtask publish window), bounded archive when
  `archiveSession` never settles, child archive on success/failure/timeout, same-fingerprint dedupe,
  global serialization, pre-warm skip. Real `dsh-tools` / `schemastery` / `storage-domain` schema suite
  43/43 (was 29/29): cache eviction and the new Config defaults. Real activation matrix 33/33 (was
  29/29): every supported host now also asserts it exposes `interrupt()`, the timeout-cancel channel
  this fix depends on. Compliance A=0 B=0 (the known C=1 client portal finding is unchanged);
  `npm run test:presentation` passes.
- **Scope.** Only this repository changed; `dsh-dev`, the daily profile and `~/.dsh` were not
  modified and no GitHub issue was filed. Sessions leaked by 0.3.5 or earlier are not deleted
  automatically — archive them once manually if you want a clean list; 0.3.6 prevents new leaks.

## 0.3.5 — 2026-11-15

Verification only: cover DSH 0.2.2-rc.3 in the real-host activation matrix. No runtime behavior change.

- `scripts/verify-subagent-compat.mjs` now drives `@deepseek-ai/dsh-subagent` 0.2.2-rc.3 in addition to 0.2.1-rc.2 / 0.2.2-rc.1 / 0.2.2-rc.2. `HOSTS` records each host's shape (`nested` for the first two, `flat` for rc.2/rc.3) instead of hard-coding "the only flat host is rc.2"; the regression anchor and outputSchema capability checks follow the recorded shape. Matrix: 29/29 (was 21/21).
- rc.3 reads the same flat `spec.parent` activation shape and enforces the same `outputSchema` capability, so `lib/subagent-compat.js` is unchanged; `engines.dsh` already allowed rc.3.
- README / plugin detail / development / release-checklist compatibility lines now list rc.3.
- Verification: `npm test` unit 77/77, real `dsh-tools` schema 29/29, real activation matrix 29/29, compliance A=0 B=0; `npm run test:presentation` passed.

## 0.3.4 — 2026-11-14

Patch: remove a dead client-side dependency and gate plugin compliance in `npm test`. No behavior change.

- The client half no longer probes `@deepseek-ai/dsh-client-ui-primitives`. The official UI rules forbid a plugin client from loading any Harness Client package (`dsh-doc` → `references/practices.md` §UI, `references/ui-plugin.md`), the package no longer resolves on 0.2.2-rc.3, and the probe was already dead: `Tooltip` was always `null`, so the trigger always fell back to the native `title`. The trigger now carries `title` directly; markup, layout and behavior are unchanged.
- Added `scripts/check-plugin-compliance.mjs` and `scripts/fixtures/compliance/` (verbatim copy of the dsh-dev checker, rule matrix `dsh-dev/docs/spec-matrix.md`, DSH 0.2.2-rc.3). `npm test` now ends with `node scripts/check-plugin-compliance.mjs --root . --strict` (also available as `npm run test:compliance`): A and B findings block a commit, C findings are reported for review.
- Compliance state: `--strict` reports A=0 B=0 C=1; the C finding is the composer popover portaled to `document.body` (R-UI-04), which the host itself does, and it is a single 264px panel, not a second application.
- Verification: `npm test` unit 77/77, real `dsh-tools` schema 29/29, real 0.2.1-rc.2 / 0.2.2-rc.1 / 0.2.2-rc.2 activation matrix 21/21, compliance A=0 B=0; `npm run test:presentation` passed.

## 0.3.3 — 2026-11-12

Wording only: PTC-compatible model-facing text, plus one concurrency invariant comment. No behavior change.

- The catalog note and the `search_tools` description/returns no longer tell the model to call loaded tools "directly". In a PTC preset only `run_code` is callable directly, so the text now reads "directly, or as `tools.<name>` inside `run_code`"; the return also says "callable from your next step", which is true in both executors (a next request in native, a next program in PTC). Loading behavior is unchanged.
- `search_tools` now carries an explicit comment that its read-state-to-restrict section must stay `await`-free and that it must not declare `isConcurrencySafe`: concurrency there would be both meaningless (pure in-memory work, no I/O) and harmful (a stale `loaded` snapshot would waste `maxResults` slots and make the deny set order-dependent).

## 0.3.2 — 2026-11-12

Fix: background catalog generation failed 100% on DSH **0.2.2-rc.2** with
`AGENT_FAILED: Cannot read properties of undefined (reading 'id')`, plus hardening so the next
host API move degrades gracefully instead of failing silently.

- **Cause**: rc.2 flattened the `ctx.subagents.startActivation()` spec
  (`SubagentActivationSpec`). `parent`, `prompt`, `maxDepth`, and `outputSchema` moved from
  `spec.request.*` to the top level; `startActivation` now reads `spec.parent.id` directly.
  0.3.1 still passed the 0.2.2-rc.1 nested shape, so `spec.parent` was `undefined` and every
  generation threw before a child session was created. This was a host breaking change, not a
  Computer Use plugin issue: an isolated DSH 0.2.2-rc.2 instance with only this plugin reproduced it.
- **Compatibility adapter**: all version-shape knowledge now lives in `lib/subagent-compat.js`.
  It sends the union of both shapes: request fields at the top level (0.2.2-rc.2+) and a
  **non-enumerable** `request` property (0.2.1-rc.2 … 0.2.2-rc.1). Non-enumerability keeps rc.2's
  external-provider rest-spread from forwarding the legacy nested object, while old versions still
  read `spec.request`. Both host implementations ignore unknown keys, so one call supports both.
- **Soft gate**: three consecutive shape rejections report `UNSUPPORTED_HOST`, pause automatic
  generation for one hour, and keep the last-known-good catalog with an explicit
  `catalog-generation-paused` warning instead of a stream of `AGENT_FAILED` retries. A plugin
  reload clears the pause and the per-fingerprint backoff, so a fix takes effect immediately.
- **Compatibility declaration**: `engines.dsh` is now the tested line `>=0.2.1-rc.2 <0.3.0-0`
  instead of an open-ended range. `generation.activationShapes` reports `["flat","nested"]`.
- **Tests**: `lib/subagent-compat.js` has a dedicated `scripts/verify-subagent-compat.mjs` that
  drives the **real** `@deepseek-ai/dsh-subagent` `0.2.2-rc.1` and `0.2.2-rc.2`
  `SubagentRuntime.startActivation` implementations: both accept the adapter spec, each reads its
  own shape, a flat-only spec fails on rc.1, a nested-only spec fails on rc.2, and both versions
  enforce the `outputSchema` capability. It runs as part of `npm test` (first run installs the two
  pinned host packages into `reference/tmp/subagent-compat/`, gitignored).

## 0.3.1 — 2026-11-11

Documentation-only release: the plugin page was rewritten around the user's questions (what it
does, what it saves, what to know), the product hero and benchmark charts were added, and the
in-session screenshot section / implementation jargon were removed. No runtime behavior change.

## 0.3.0 — 2026-11-11

Renamed from `dsh-tool-discovery` / Tool Discovery; public identity is now **Agentic Tool Catalog**.

- **Name/identity**: `@local/dsh-agentic-tool-catalog`, row id `agentic-tool-catalog`,
  display "Agentic Tool Catalog / Agent 工具目录"; tools renamed `discovery_status` → `catalog_status`;
  prompt section `catalog:note`; config `agentGroup*` → `catalog*`; internal `policy.js` → `catalog.js`,
  `agent-groups.js` → `generation.js`.
- **Persistence**: moved the catalog cache from a self-managed JSON file to official DSH Storage
  (`ctx.storageDomain`, domain `agentic_tool_catalog`, schema-validated). No second file backend;
  profiles without a storage service use memory-only caching and report `storage.mode = "memory"`.
- **Status contract**: `catalog_status` returns fixed sections `catalog` / `session` / `generation` /
  `storage` / `warnings`.
- **Migration fix**: when replacing the old `dsh-tool-discovery` bundle, release restrictions left in the
  legacy global registry so a renamed plugin does not inherit an orphaned deny set.
- **Empty catalog fix**: with nothing deferred (e.g. every tool resident) the plugin no longer spawns a
  grouping subagent that can only fail `TOO_FEW_GROUPS`; it emits an empty catalog directly. The group floor
  now scales down for catalogs with fewer than 6 tools, and validation accepts exactly `0` groups for `0` tools.
- **Docs**: bilingual README (`README.md` / `README.zh.md`), rewritten product detail pages, MIT LICENSE.

## 0.2.0 — 2026-11-10

- Agent-curated catalog only (all legacy/rules/BM25/heuristic strategies removed).
- Lazy/pre-warm generation, incremental regeneration, official freshness/origin reporting,
  last-known-good continuation with explicit `catalog-stale` warnings.
