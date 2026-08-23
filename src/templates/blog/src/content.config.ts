import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

// The schema enforces the SEO contract: every post has a title that fits a
// tab and a description that fits a search snippet, and both feed the meta
// tags, RSS, and llms.txt.
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string().max(60),
    description: z.string().min(50).max(160),
    date: z.coerce.date(),
    ogImage: z.string().optional(),
  }),
});

export const collections = { blog };
