# Agent Notes

This is the public source for the `create-shibumi` npm package, the Shibumi Stack scaffolder. The release plan and contracts live in the shibumistack.dev repo at `.plans/cli-vps-release.md`; site copy at shibumistack.dev is the product contract and is never walked back.

## Commands

```sh
bun install
bun test        # CLI tests only (bunfig scopes test root to ./test)
bun check       # tsc --noEmit
bun sync:ship   # re-vendor Ship client from the locked immutable snapshot
```

## Layout

- `src/cli.ts`: entry, prompts, exit codes. `src/args.ts`: strict parser. `src/create.ts`: atomic scaffold. `src/adopt.ts`: `bun create shibumi .` on an existing project (vendor the client, add scripts, generate the static image files).
- `src/templates/<id>/`: template assets copied verbatim into generated projects (template `test/` folders ship to projects; they are not this package's tests).
- `src/templates/ship.ts`: vendored Ship client, byte-locked to `scripts/ship.lock.json`. Never edit by hand; update the lock and run `bun sync:ship`.
- `src/extensions/`: auth and email extension assets; installer lands in a later workstream.
- Template `.gitignore` files are stored as `gitignore` (npm pack strips dotted ones); `create.ts` renames them at scaffold time.

## Hard rules

- Package stays `"private": true` until the release workstream adds publish guards. npm publish is manual, done by the owner only.
- No shell-string exec anywhere; `Bun.spawn` argument arrays only. CI greps for violations.
- Atomic creation invariants: exclusive mkdtemp temp sibling, mkdir-reserved rename, destination absent on any failure/cancel/signal, existing paths never touched, git never stages or commits.
- Exit codes: 0 success, 1 runtime failure, 2 usage error, 130 SIGINT, 143 SIGTERM.
- Security gates from the release plan are hard blocks: no unauthenticated mutation endpoints in templates, adversarial review before any publish, HIGH findings block.

## Gotchas

- Never `import` `src/templates/ship.ts` from anything in `include` (tsconfig): the client is authored without `noUncheckedIndexedAccess` and adds ten errors to `bun check` the moment it joins this program. `src/adopt.ts` reuses its static-image generators through a computed dynamic import (specifier in a variable, so tsc leaves it as `any`), always after verifying the checksum lock; tests drive the client through its entry point or a child process instead.

- `bun build` inlines `process.env.NODE_ENV` at build time (defaults to "development"), so the runtime container `ENV NODE_ENV=production` is ignored in bundled code. Read `process.env["NODE_ENV"]` (bracket form) to force a runtime lookup. Caught only by running the built container, never by unit tests (they run from source). Extensions gate security behavior on this (auth login-link fail-closed).
- `bun-types` already declares `*.yaml` and `*.yml` (`export = any`). Do NOT add a `declare module "*.yaml"` shim — it collides (TS2309 "export assignment ... other exported elements"). Just `import cfg from "./x.yaml"`; Bun bundles the parsed value into the image at build.
- Hono: never hand-compose middleware (e.g. csrf() wrapping requireAuth in one `.use`); the returned Response is dropped and you get a 500 "Context is not finalized". Use separate `.use()` calls. Each `.use()` adds an `ALL /prefix/*` entry to `app.routes`, so mirror the count in route-pin tests.
- Hono `onError` must re-apply the security-header set AND return `err.getResponse()` for `HTTPException`, else framework 4xx (CSRF 403) collapse to 500. Non-HTTPException stays a logged 500.
- Extension config: non-secret tunables live in `src/config/<ext>.yaml` (bundled, validated at boot, fail loud on bad value). Secrets/per-deploy config go server-side via `bun ship:env` (never committed YAML). Config file must be imported (not runtime-read): the Dockerfile only copies `dist/`, so import-bundling is the only path into the image.
- Extensions are copied-in owned code. `bun run shibumi update` re-vendors the installer (via `bunx create-shibumi@latest --print-installer`, checksum-verified) and reports drift; it never overwrites installed files. Per-extension versions recorded in `.shibumi/installed.json` at install.
- Hono `csrf()` default derives the expected origin from the request URL. Behind a TLS-terminating proxy (Caddy) the app sees http://, browsers send the https Origin, so every form-content-type POST 403s in production only. Use `csrf(csrfOptions())` (auth lib) which pins to APP_ORIGIN. Same-scheme tests and local dev can never catch this class; only a real TLS deploy does (found in the first kunstfy.com dogfood).
- Every script a template vendors must declare its deps in that template's package.json. Static template shipped no deps while scripts/ship.ts imports @clack/prompts; bun auto-install masked it until an empty node_modules disabled auto-install and every interactive ship command died. verify:packed doesn't catch it (acceptance never runs ship.ts interactively).
