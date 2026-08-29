# Shibumi blog

A blog on the same engine as shibumistack.dev: a small Bun + Hono renderer with the boring parts done — RSS, sitemap, OG and SEO meta from a schema your posts can't skip, an `llms.txt`, and a markdown alternate of every post for readers who curl. No framework dependency; posts are markdown in `src/content/blog/` rendered by Bun's markdown engine.

```sh
bun install
bun dev    # live server on http://localhost:9001
bun build  # pre-render dist/
```

Write posts in `src/content/blog/`. Set `url` in `src/site.ts`, then `bun ship:setup` and `bun ship` to deploy. `agents.md` has the house rules.