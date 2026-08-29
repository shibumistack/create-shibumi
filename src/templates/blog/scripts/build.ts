// Pre-renders the blog to static files in dist/: the same Hono app that
// `bun dev` serves, rendered once. Ship packages this output; nothing here
// runs in production.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import app, { publishedPosts } from "../src/app";

const output = "dist";

async function write(path: string, body: string | ArrayBuffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body instanceof ArrayBuffer ? new Uint8Array(body) : body);
}

async function responseBody(path: string): Promise<string> {
  const response = await app.request(path);
  if (!response.ok) {
    throw new Error(`cannot build ${path}: HTTP ${response.status}`);
  }
  return response.text();
}

await rm(output, { recursive: true, force: true });
await cp("public", output, { recursive: true });

const posts = await publishedPosts();
const htmlRoutes = ["/", ...posts.map((post) => `/posts/${post.slug}`)];
for (const route of htmlRoutes) {
  const path = route === "/" ? join(output, "index.html") : join(output, route.slice(1), "index.html");
  await write(path, await responseBody(route));
}

const notFound = await app.request("/404");
if (notFound.status !== 404) {
  throw new Error(`cannot build /404: HTTP ${notFound.status}`);
}
await write(join(output, "404.html"), await notFound.text());

for (const file of ["rss.xml", "llms.txt", "robots.txt", "sitemap.xml"]) {
  await write(join(output, file), await responseBody(`/${file}`));
}
for (const post of posts) {
  // Markdown alternates: every post is also served as plain markdown so
  // agents can read the source of the writing (llms.txt links here).
  await write(join(output, "posts", `${post.slug}.md`), await responseBody(`/posts/${post.slug}.md`));
}

console.log(`Built ${htmlRoutes.length} HTML routes + feeds in ${output}/`);