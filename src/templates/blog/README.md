# Shibumi blog

An Astro blog with the boring parts done: RSS, sitemap, OG and SEO meta from a schema your posts can't skip, an `llms.txt`, and a markdown alternate of every post for readers who curl.

```sh
bun install
bun dev
```

Write posts in `src/content/blog/`. Set `site` in `astro.config.mjs`, then `bun ship:setup` and `bun ship` to deploy. `agents.md` has the house rules.
