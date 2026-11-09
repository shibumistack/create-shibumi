# Publishing create-shibumi

Manual, owner-run. Every gate below is a hard block. Nothing here is automated on purpose: publishing is the one irreversible step.

First release shipped 2026-08-24: `create-shibumi@0.2.0`, tag `v0.2.0`, registry tarball sha256 `a5b090bdfd44785133f6b345137423a106cee70cdc7b2a9c7bfa5fdd801a3fd3`. The `"private": true` guard was removed in that release commit; the pack allowlist and CI gates are now the accidental-publish protection. Compatibility rule going forward: the vendored Ship client and the published `shibumi-server` npm release must agree (Ship v45 requires `shis env`, server >= 0.10.6).

## Preconditions (all green)

- CI green on the commit you are publishing (test, check, exec/symlink guards, pack allowlist, full-stack + blog acceptance, packed verification, bun-floor job).
- `bun run verify:packed` green locally; record the printed tarball sha256.
- `bun run verify:copy` green (site command/script tables match generated output). Run from the `shibumistack.dev` checkout.
- Latest adversarial security review of the packed artifact + one fixture per path + each extension has no HIGH finding. Two independent passes have been run per diff (codex gpt-5.6-sol, kimi k3); run one more on the exact release tarball if any code changed since.
- Vendored clients current: `scripts/ship.lock.json` and `scripts/shibumi.lock.json` match the live immutable URLs; `bun run sync:ship`, `bun run sync:extensions`, and `bun run sync:css` produce no diff.

## Publish steps

1. Confirm npm identity and 2FA: `npm whoami`, account has publish rights to `create-shibumi`, 2FA enabled.
2. Bump the version in `package.json` in its own release commit. Do not push other changes in this commit. Golden-number rule (owner convention): the sum of the version components (major + minor + patch) must not be 4, 6, or 8; skip version numbers until the sum clears (0.2.2 sums to 4, so it was skipped for 0.2.3).
3. `npm pack --dry-run` and review the file list one more time (the CI allowlist already enforces it, but look).
4. Prefer npm trusted publishing (OIDC from a tagged CI release) over a long-lived token. If publishing locally, use an automation token scoped to this package and revoke it after.
5. Publish under a prerelease dist-tag, never straight to `latest`:
   `npm publish --tag next --provenance`
6. Cold-verify from the registry on a clean machine (no checkout, fresh temp dir):
   - `bun create shibumi@next cold-fs --yes --template full-stack` then `cd cold-fs && bun install && bun test && bun run check && bun run build`
   - `bunx create-shibumi@next cold-blog --yes --template blog` and the same acceptance
   - full-stack: `bun run shibumi add auth --yes`, then `add uploads --yes`, then `add admin --yes`, then `add email --yes`; run `bun test && bun run check && bun run build`. Confirm `add uploads`/`add admin` refuse without auth, and removal refuses while a dependent is installed.
   - scaffold static and blog; build blog, check artifacts
   - confirm the published tarball digest matches the one `verify:packed` recorded
7. Promote the verified version to `latest`: `npm dist-tag add create-shibumi@<version> latest`.
8. Tag the repo at the published commit: `git tag v<version> && git push --tags`.
9. Cold-verify `bun create shibumi@latest` and `bunx create-shibumi` one final time.
10. Flip any remaining "preview" wording on the site; redeploy shibumistack.dev.

## After publishing

- A published version is immutable; a mistake means a new patch, not a re-publish. `npm unpublish` is not a recovery path.
- Watch the first real installs; keep the prerelease dist-tag pointer until `latest` is confirmed healthy.

## Ship client releases (changing scripts/ship.ts)

The Ship client is a separate, versioned artifact from create-shibumi itself. Releasing vN+1 touches every repo in the org; do it in this order:

1. **Publish on shibumistack.dev**: add `public/ship/vN+1.ts`, point `/ship/latest.ts` at it in `src/app.ts`, cut a new `install-vM.ts` (source URL + append the new sha256 to `knownSourceHashes`), point `/install/ship` at it, update `ship.md` source URL and `scripts/build.ts`, and fix `test/app.test.ts` to the new version.
2. **Deploy the site** so `latest.ts` actually serves vN+1 (owner-gated).
3. **Sync the vendored copies, lock-first**: create-shibumi (`scripts/ship.lock.json` → `bun run sync:ship`), shibumi-forms and shibumi-server (same lock + sync + drift test pattern), and shibumistack.dev's own `scripts/ship.ts`.
4. **Prune** per the retention policy (current + previous two CLI versions, current installer, current bootstrap): delete older `v*.ts`, `install-*.ts`, `bootstrap-*.sh`, and update the site's version-boundary test, which encodes the policy.
5. CI in each repo then guards drift: any hand-edit without a re-lock fails the build.

Old clients pinned to a pruned version lose `ship:update` (their immutable `CURRENT_SOURCE` 404s) but still ship; the current installer's embedded `knownSourceHashes` keeps upgrades working from every reviewed version.

## Deploy-side items still owner-gated (not blocking npm publish)

- **VPS dogfood matrix.** Done on arm64 (2026-08-24, kunstfy.com on alpha): DNS, setup, `ship:env`, image upload, deploy, health, auth/uploads/admin live, rollback with env retention, remove and re-add. The dogfood caught and fixed the CSRF-behind-TLS-proxy bug before this release. Still open: an amd64 host for the same live leg (CI covers the amd64 container path).
- **Ship-client trust-model findings** (in the vendored `scripts/ship.ts`, owner-owned, not create-shibumi code): the server install is `curl -fsSL https://shibumistack.dev/install/server | bash`; `bun ship:update` fetches and runs unsigned TypeScript from one origin; `ssh()` passes remote arguments to a login shell that reparses them. These are deliberate self-hosted-tool trust decisions; if you want them hardened (signed install manifest, pinned digests, POSIX-quoted remote args), that is a Ship release, not a create-shibumi one.
