# create-shibumi

Scaffold a Shibumi Stack project: simple apps, whole stack, without React, build pipelines, or 600 MB of `node_modules`. Every generated project keeps its source, tests, and deployment config in your repository. No Shibumi runtime dependency.

```sh
bun create shibumi@latest my-app
cd my-app
bun dev
```

## Three starting points

1. **Static site**: publish a verified build directory such as `./dist`, `public`, `build`, or `out` from any framework.
2. **Bun web**: Hono, HTML, CSS, Alpine, Zod, tests, and a health endpoint.
3. **SQLite full stack**: the Bun web project plus Drizzle, migrations, persistent data, backup, and restore.

All three deploy to a Linux VPS or homelab through [shibumi-server](https://server.shibumistack.dev). Other providers can wait until their generated projects pass the same artifact and deployment tests.

## Flags

```text
--template <id>       static, web, or full-stack
--yes, -y             non-interactive; requires name and --template
--no-git              skip git init
--no-install          skip dependency install
--help, -h            show help
--version             show version
```

Creation is atomic: the project is built in a temporary sibling directory and renamed into place. Failure or cancellation leaves nothing behind, and an existing destination is never touched. Git init stages and commits nothing; the first commit belongs to you.

## Guidance for coding agents

Generated projects include a root `agents.md`. It records route locations, data rules, available checks, and files that need extra care.

## Development

```sh
bun install
bun test        # CLI tests (parsing, atomicity, signals, E2E)
bun check       # TypeScript
bun sync:ship   # re-vendor the Ship client from its locked immutable snapshot
```

The vendored Ship client in `src/templates/ship.ts` is locked byte-for-byte to a published immutable snapshot via `scripts/ship.lock.json`; tests fail on any drift.

Docs: <https://shibumistack.dev/docs>
