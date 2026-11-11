# Release checklist

## Preconditions

- [x] Independent repository (this repo); package name `dsh-agentic-tool-catalog`
- [x] npm published: `dsh-agentic-tool-catalog@0.3.1` (latest, 2026-11-11)
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
2. **GitHub**: ✅ done — `https://github.com/laughinbytes/dsh-agentic-tool-catalog`, tag `v0.3.1`, Release created,
   topics added (`dsh`, `dsh-plugin`, `deepseek-harness`, `tool-catalog`, `mcp`, `context`).
3. **Markets** (after npm + GitHub): awesome-dsh-plugin, dshbase, dshplugin.store, dpharness, dsh.directory.

## Blockers / decisions

- [x] npm authentication: logged in as `sunlit_divorce`; OTP completed by user.
- [x] npm publish succeeded (`0.3.1`, 23 files).
- Version: **`0.3.1`** (same version internally and publicly; no separate internal/external version).
- [x] GitHub: authenticated as `laughinbytes`; repo public and pushed.

## Post-release

- Verify `dsh plugin --profile web add dsh-agentic-tool-catalog` in a clean profile.
- Watch install/first-generation failures and catalog feedback before spending on data card v2.1.
