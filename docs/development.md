# Development & release validation

This repository is developed both in the `dsh-dev` workspace (shared plugin process) and as its
own DSH workspace. The release process follows the layered validation model:

1. **G0 — code**: `npm test` (unit + real `dsh-tools` schema + real `@deepseek-ai/dsh-subagent`
   0.2.1-rc.2 / 0.2.2-rc.1 / 0.2.2-rc.2 activation matrix + DSH plugin spec compliance) and
   `npm run test:presentation`.
   The activation matrix is the gate for host API moves: when DSH changes the
   `startActivation()` spec again, add the new version to `HOSTS` in
   `scripts/verify-subagent-compat.mjs`, keep every supported shape covered, and update
   `engines.dsh` / the README compatibility line in the same change.
   The compliance step is the gate for plugin contracts: see [Plugin compliance](#plugin-compliance).
2. **G1 — artifact**: `npm pack --dry-run`, install the tarball in a clean profile.
3. **G2 — composition + UI**: a staging DSH profile with the same composition as daily; install
   the candidate package; run the catalog flow; UI changes verified with the dsh-dev workspace tool `scripts/verify-ui/` (isolated DSH Web + headless Chrome).
4. **G3 — pre-release dogfood**: `npm publish --tag next`, use the candidate in staging (or
   temporarily in daily with rollback ready), then promote to `latest`.
5. **G4 — post-release dogfood**: daily profile runs `latest`; watch `catalog_status` and
   failures; keep the previous version for rollback.

Do not treat a `link:` dev profile as final validation of a release: packaging, peer resolution and
the daily profile composition can differ. See [`release-checklist.md`](./release-checklist.md).

## Plugin compliance

`scripts/check-plugin-compliance.mjs` (with its fixtures in `scripts/fixtures/compliance/`) is a
verbatim copy of `dsh-dev/scripts/check-plugin-compliance.mjs`; the rule matrix it enforces is
`dsh-dev/docs/spec-matrix.md`, pinned to DSH 0.2.2-rc.3. `npm test` and `npm run test:compliance`
run it with `--strict` over the repository root, so A and B findings block a commit; C findings are
reported and reviewed by hand. Copy the checker again when the matrix changes upstream rather than
editing it here.

Rules this plugin must keep green:

- **Client half** (R-UI-01 / R-UI-02): load no Harness Client package — not even
  `@deepseek-ai/dsh-client-ui-primitives` (it is unresolvable in 0.2.2-rc.3); write the controls
  yourself and use the native `title` attribute. `dsh.client.inject` entries only order activation
  and stay allowed. Contribute slots through
  `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`.
- **Credentials** (R-CRED-01 / R-CRED-04), if this plugin ever stores any: a record must be
  `{ kind: 'grant', payload }` or `{ kind: 'api-key', key?, env? }`, and the read side must check
  `kind === 'grant'` before reading `payload`. A bare object without `kind` is what broke the host
  on 2026-11-14.

