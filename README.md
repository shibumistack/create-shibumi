# create-shibumi

Scaffold a Bun full-stack app, blog, or static site as source you own. The full-stack template includes tests and container files; blog and static generate container files during deployment setup. No Shibumi runtime dependency.

Requires **Bun 1.4.4 or newer** and Git. Run `bun --version` to check, or `bun upgrade` to update. The CLI refuses an older runtime before creating project files.

```sh
bun create shibumi@latest my-app
cd my-app
bun dev
```

Choose **Later** for deployment, then open http://localhost:9001. In the full-stack starter, click Count and reload; SQLite keeps the value. Docker and a VPS are only needed when you deploy. [Follow the quick start](https://shibumistack.dev/docs) for the complete local and deployment path.

Already have a project? Run it inside that project instead, and it gets deploy tooling rather than a scaffold:

```sh
bun create shibumi@latest .
```

## Three starting points

1. **Bun full-stack app**: Hono, HTML, CSS, Alpine, Zod, tests, a health endpoint, and SQLite through Drizzle with migrations, persistent data, backup, and restore.
2. **Blog**: the shibumistack.dev engine — a Bun + Hono markdown renderer with posts, RSS, sitemap, SEO meta, and llms.txt.
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

`bun create shibumi .` detects where your build lands (Astro and Vite write `dist/`, Eleventy `_site/`, an exported Next.js `out/`, plain files `public/`), copies in `scripts/ship.ts`, adds the `ship` scripts, installs the one dependency that client needs, and generates a `Dockerfile`, `compose.yaml`, and `.dockerignore` for the static image. Git is never touched, and `--no-install` skips the install.

Two cases stop the run instead of guessing. Deployment files that already exist are never reinterpreted: a `compose.yaml` carrying Shibumi's static labels beside somebody else's `Dockerfile` would deploy the wrong artifact. A `package.json` with a `start` script belongs to `bun ship:setup`, which generates server deployment files. Finish with `bun ship:setup`.

## Guidance for coding agents

Generated projects include a root `agents.md`. It records route locations, data rules, available checks, and files that need extra care.

## Development

```sh
bun install
bun test        # Local CLI and regression tests; never deploys to a VPS
bun check       # Native type checking; no standalone TypeScript dependency
bun sync:ship   # re-vendor the Ship client from its locked immutable snapshot
```

The vendored Ship client in `src/templates/ship.ts` is locked byte-for-byte to a published immutable snapshot via `scripts/ship.lock.json`; tests fail on any drift.

## Live deployment tests

The opt-in E2E suite uses Bun to pack and install the CLI outside this checkout. It runs the generated Ship client against a disposable VPS registration, checks real HTTPS pages in a browser, redeploys changed content, verifies recovery from an unhealthy image, and rolls back to the expected commit.

```sh
SHIBUMI_E2E=1 bun run test:e2e:matrix /absolute/path/to/target.json
```

The matrix covers every template in `src/args.ts` twice. Full-stack checks include auth and uploads, session cookies, and persistent SQLite data and file bytes. Blog checks include posts, drafts, canonical/OG metadata, feeds and Markdown alternates. Static checks include nested pages, assets, MIME types and custom 404s. Results and screenshots stay outside the checkout.

This changes a dedicated test app and private test repository. Read [the setup and safety instructions](scripts/e2e.md) before running it. The matrix restores and deploys the original full-stack fixture afterward. Normal `bun test` does not run these live checks.

Docs: <https://shibumistack.dev/docs>
