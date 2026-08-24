# create-shibumi

Scaffold a Shibumi Stack project: simple apps, whole stack, without React, build pipelines, or 600 MB of `node_modules`. Every generated project keeps its source, tests, and deployment config in your repository. No Shibumi runtime dependency.

```sh
bun create shibumi@latest my-app
cd my-app
bun dev
```

Already have a project? Run it inside that project instead, and it gets deploy tooling rather than a scaffold:

```sh
bun create shibumi@latest .
```

## Three starting points

1. **Bun full-stack app**: Hono, HTML, CSS, Alpine, Zod, tests, a health endpoint, and SQLite through Drizzle with migrations, persistent data, backup, and restore.
2. **Blog**: Astro with posts, RSS, sitemap, SEO meta, and llms.txt.
3. **Static site**: publish a verified build directory such as `./dist`, `public`, `build`, or `out` from any framework.

All three deploy to a Linux VPS or homelab through [shibumi-server](https://server.shibumistack.dev). Other providers can wait until their generated projects pass the same artifact and deployment tests.

## Flags

```text
--template <id>       full-stack, blog, or static
--yes, -y             non-interactive; requires name and --template
--no-git              skip git init
--no-install          skip dependency install
--spa                 adopting only: unknown paths serve index.html
--help, -h            show help
--version             show version
```

Creation is atomic: the project is built in a temporary sibling directory and renamed into place. Failure or cancellation leaves nothing behind, and an existing destination is never touched. Git init stages and commits nothing; the first commit belongs to you.

## Adopting an existing project

`bun create shibumi .` detects where your build lands (Astro and Vite write `dist/`, Eleventy `_site/`, an exported Next.js `out/`, plain files `public/`), vendors `scripts/ship.ts`, adds the `ship` scripts, installs the one dependency that client needs, and generates a `Dockerfile`, `compose.yaml`, and `.dockerignore` for the static image. Git is never touched, and `--no-install` skips the install.

Two cases stop the run instead of guessing. Deployment files that already exist are never reinterpreted: a `compose.yaml` carrying Shibumi's static labels beside somebody else's `Dockerfile` would deploy the wrong artifact. A `package.json` with a `start` script belongs to `bun ship:setup`, which generates server deployment files. Finish with `bun ship:setup`.

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
