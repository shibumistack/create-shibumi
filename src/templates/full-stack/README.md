# Shibumi full-stack app

Bun, Hono, Zod, Alpine, Drizzle, and SQLite. Everything here is your source, including the migration and backup tooling.

```sh
bun install
bun dev
```

Deploy with `bun ship:setup`, then `bun ship`. Data lives on a persistent volume at `/data`; see `agents.md` for migration, backup, restore, and rollback rules.
