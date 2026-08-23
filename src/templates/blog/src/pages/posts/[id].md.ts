// Markdown alternates: every post is also served as plain markdown at
// posts/<id>.md for agents and curl. llms.txt links here.
import { getCollection, getEntry } from "astro:content";
import type { APIRoute } from "astro";

export async function getStaticPaths() {
  return (await getCollection("blog")).map((post) => ({ params: { id: post.id } }));
}

export const GET: APIRoute = async ({ params }) => {
  const post = await getEntry("blog", params.id!);
  if (!post) return new Response("Not found", { status: 404 });
  const date = post.data.date.toISOString().slice(0, 10);
  const body = `# ${post.data.title}\n\n${date}\n\n${post.body ?? ""}`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
