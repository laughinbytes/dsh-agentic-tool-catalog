# Release checklist

## Compatibility gate (every release)

- [ ] `npm test` passes, including `scripts/verify-subagent-compat.mjs`, which drives the **real**
      `SubagentRuntime.startActivation` of `@deepseek-ai/dsh-subagent` `0.2.1-rc.2`, `0.2.2-rc.1` and `0.2.2-rc.2`
      (first run installs the pinned packages into `reference/tmp/`, gitignored).
- [ ] A newly supported DSH version is added to `HOSTS` in the compat script, to `engines.dsh`, and
      to the README compatibility line. A dropped version is removed from all three.
- [ ] Host activation-spec changes touch only `lib/subagent-compat.js`; both flat and nested shapes
      stay covered by the matrix.
- [ ] `catalog_status.generation.activationShapes` reports the shipped shapes, and
      `generation.paused` is absent on a healthy host.
- [ ] `npm run test:presentation` passes; `npm pack --dry-run` contains `lib/subagent-compat.js`.

## 0.3.4 — 2026-11-14 (prepared, not published)

Patch: the dead `@deepseek-ai/dsh-client-ui-primitives` load is removed from the client half and the
plugin compliance checker is now gated in `npm test`. No behavior change.

- [x] `npm test`: unit 77/77, real `dsh-tools` schema 29/29, real
      0.2.1-rc.2 / 0.2.2-rc.1 / 0.2.2-rc.2 activation matrix 21/21, plugin compliance `--strict`
      A=0 B=0 C=1 (the C item is the composer popover portal, R-UI-04: one 264px panel, not a second
      application; the host portals its own popovers the same way).
- [x] `npm run test:presentation` passed.
- [x] `npm pack --dry-run`: version `0.3.4`, 24 files, 369.1 kB packed / 480.7 kB unpacked; includes
      `lib/client.js`. `scripts/check-plugin-compliance.mjs` and `scripts/fixtures/compliance/` are
      **not** in the tarball (dev-only, same as the other `scripts/` verifiers).
- [x] Local git tag `v0.3.4` on `main`.
- [ ] `npm publish` **not run**: the local npm token fails `npm whoami` with 401 (expired). After a
      human runs `npm login`: `npm publish --access public --tag next`, dogfood, then
      `npm dist-tag add dsh-agentic-tool-catalog@0.3.4 latest`.
- [ ] Not installed into the daily profile in this round; switching the daily install is the user's
      decision (the client half only loses a dead require, so no App restart is involved).

## 0.3.2 — 2026-11-12 (released)

- [x] `npm test`: unit 77/77, real `dsh-tools` schema 29/29, real 0.2.1-rc.2/0.2.2-rc.1/0.2.2-rc.2 activation matrix 21/21;
      `npm run test:presentation` passed.
- [x] Live check on DSH 0.2.2-rc.2 desktop: `catalog_status` showed `freshness: "fresh"`,
      `lastOkAt` set, `others: 0`; the generation child session (`da57fc4a…`) ended with
      `tool/result structured_output ok` and `turn/end completed` (18 groups / 93 tools).
- [x] `npm pack --dry-run`: 24 files, 367.9 kB; includes `lib/subagent-compat.js`.
- [x] `npm publish --access public`: `dsh-agentic-tool-catalog@0.3.2` is `latest`
      (https://www.npmjs.com/package/dsh-agentic-tool-catalog/v/0.3.2).
- [x] GitHub tag `v0.3.2` + Release
      (https://github.com/laughinbytes/dsh-agentic-tool-catalog/releases/tag/v0.3.2).
- [x] Desktop profile updated 0.3.1 → 0.3.2 via plugin_manager (remove_bundle → install_bundle; hot, no App restart); `catalog_status.generation.activationShapes` = `["flat","nested"]`, catalog stayed fresh.

## 0.3.1 — 2026-11-11 (historical)

### Preconditions

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

### Publish order

1. **npm** (primary): `npm login` first; then `npm publish --access public`.
2. **GitHub**: ✅ done — `https://github.com/laughinbytes/dsh-agentic-tool-catalog`, tag `v0.3.1`, Release created,
   topics added (`dsh`, `dsh-plugin`, `deepseek-harness`, `tool-catalog`, `mcp`, `context`).
3. **Markets** (after npm + GitHub): awesome-dsh-plugin, dshbase, dshplugin.store, dpharness, dsh.directory.

### Blockers / decisions

- [x] npm authentication: logged in as `sunlit_divorce`; OTP completed by user.
- [x] npm publish succeeded (`0.3.1`, 23 files).
- Version: **`0.3.1`** (same version internally and publicly; no separate internal/external version).
- [x] GitHub: authenticated as `laughinbytes`; repo public and pushed.

### Post-release

- Verify `dsh plugin --profile web add dsh-agentic-tool-catalog` in a clean profile.
- Watch install/first-generation failures and catalog feedback before spending on data card v2.1.
