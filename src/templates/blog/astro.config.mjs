// @ts-check
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Set this to your real domain before the first `bun ship`.
  // Sitemap, RSS, canonical URLs, and og:url all derive from it.
  site: "https://example.com",
  integrations: [sitemap()],
  // "directory" keeps clean URLs as posts/foo/index.html, which the pinned
  // static server routes without any adapter or rewrites.
  build: { format: "directory" },
});
