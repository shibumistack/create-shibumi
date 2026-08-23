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

- `src/cli.ts`: entry, prompts, exit codes. `src/args.ts`: strict parser. `src/create.ts`: atomic scaffold.
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
