# Changelog

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
