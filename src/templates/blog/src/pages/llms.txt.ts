// Agent-facing index. Generated from the content collection, so it is
// always current; links point at the markdown alternates.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "../site";

export const GET: APIRoute = async (context) => {
  const posts = (await getCollection("blog", ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.description}`,
    "",
    "Every post is also available as plain markdown at the .md links below.",
    "",
    "## Posts",
    "",
    ...posts.map(
      (post) =>
        `- [${post.data.title}](${new URL(`/posts/${post.id}.md`, context.site)}): ${post.data.description}`
    ),
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
