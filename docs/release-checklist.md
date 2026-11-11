# Release checklist

## Preconditions

- [x] Independent repository (this repo); package name `dsh-agentic-tool-catalog`
- [x] npm name available (last check: HTTP 404 on registry, 2026-11-11)
- [x] Package metadata: license, repository/homepage/bugs, keywords, engines, files
- [x] `npm pack --dry-run`: 22 files, ~201 KB
- [x] Tests: `npm test` (55 + 29), `npm run test:presentation`
- [x] Plugin page visuals: `docs/detail-hero.svg`, `docs/detail-benchmark.svg`, UI screenshot; verified in isolated DSH
- [x] Bilingual README + detail docs + locale
- [x] MIT LICENSE + CHANGELOG
- [x] Live profile switched to this repository via `link:` (`dsh-agentic-tool-catalog`, row `agentic-tool-catalog`)
- [x] Old `@local/dsh-agentic-tool-catalog` bundle removed; dsh-dev source/references cleaned

## Publish order

1. **npm** (primary): `npm login` first; then `npm publish --access public`.
2. **GitHub**: create `laughinbytes/dsh-agentic-tool-catalog`, push `main`, tag the release, add topics
   (`dsh`, `dsh-plugin`, `deepseek-harness`, `tool-catalog`, `mcp`, `context`), publish Release notes.
3. **Markets** (after npm + GitHub): awesome-dsh-plugin, dshbase, dshplugin.store, dpharness, dsh.directory.

## Blockers / decisions

- npm authentication: `npm whoami` → **E401 Unauthorized**; `npm login` required before publishing.
- Version: **`0.3.1`** (same version internally and publicly; no separate internal/external version).
- GitHub repository creation needs the account authenticated (the existing `dsh-host-ops` uses `laughinbytes`).

## Post-release

- Verify `dsh plugin --profile web add dsh-agentic-tool-catalog` in a clean profile.
- Watch install/first-generation failures and catalog feedback before spending on data card v2.1.
