# Changelog

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
