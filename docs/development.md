# Development & release validation

This repository is developed both in the `dsh-dev` workspace (shared plugin process) and as its
own DSH workspace. The release process follows the layered validation model:

1. **G0 — code**: syntax + tests (`npm test`, `npm run test:presentation`).
2. **G1 — artifact**: `npm pack --dry-run`, install the tarball in a clean profile.
3. **G2 — composition + UI**: a staging DSH profile with the same composition as daily; install
   the candidate package; run the catalog flow; UI changes verified with `scripts/quiet-verify`.
4. **G3 — pre-release dogfood**: `npm publish --tag next`, use the candidate in staging (or
   temporarily in daily with rollback ready), then promote to `latest`.
5. **G4 — post-release dogfood**: daily profile runs `latest`; watch `catalog_status` and
   failures; keep the previous version for rollback.

Do not treat a `link:` dev profile as final validation of a release: packaging, peer resolution and
the daily profile composition can differ. See [`release-checklist.md`](./release-checklist.md).
