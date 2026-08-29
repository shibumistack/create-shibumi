// The blog engine: a small Bun + Hono renderer, the same engine that runs
// shibumistack.dev. Posts are markdown with YAML frontmatter in
// src/content/blog/; Bun's built-in markdown renderer turns them into HTML.
// `bun dev` serves this app live; scripts/build.ts pre-renders the very same
// routes to dist/, so what you build is what you preview and what ships.
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { YAML } from "bun";
import { SITE } from "./site";

const app = new Hono();

const slugPattern = /^[a-z0-9][a-z0-9-]*$/;
const urlBase = SITE.url.replace(/\/$/, "");

export type Post = {
  slug: string;
  title: string;
  description: string;
  date: Date;
  ogImage?: string;
  ogImageAlt?: string;
  draft: boolean;
  path: string;
};

const assetVersion = createHash("sha256").update(readFileSync("public/style.css")).digest("hex").slice(0, 12);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function read(path: string): Promise<string> {
  return Bun.file(path).text();
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf("---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }
  return {
    frontmatter: (YAML.parse(text.slice(3, end).trim()) as Record<string, unknown> | undefined) ?? {},
    body: text.slice(end + 3).trimStart(),
  };
}

// The SEO contract, enforced at build and serve time so a bad post fails
// loudly instead of shipping silently: a title that fits a tab and a
// description that fits a search snippet, both feeding the meta tags, RSS,
// and llms.txt. Carried over from the previous template's content schema.
function validatePost(slug: string, frontmatter: Record<string, unknown>): void {
  const title = frontmatter.title;
  if (typeof title !== "string" || title.length === 0 || title.length > 60) {
    throw new Error(`posts/${slug}.md: title must be a string from 1 to 60 characters`);
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || description.length < 50 || description.length > 160) {
    throw new Error(`posts/${slug}.md: description must be 50 to 160 characters`);
  }
  if (frontmatter.date === undefined || Number.isNaN(new Date(String(frontmatter.date)).getTime())) {
    throw new Error(`posts/${slug}.md: date must be a parseable date`);
  }
  if (frontmatter.ogImage !== undefined && typeof frontmatter.ogImage !== "string") {
    throw new Error(`posts/${slug}.md: ogImage must be a path string`);
  }
  if (frontmatter.ogImageAlt !== undefined && typeof frontmatter.ogImageAlt !== "string") {
    throw new Error(`posts/${slug}.md: ogImageAlt must be a string`);
  }
}

async function discoverPosts(): Promise<Post[]> {
  const dir = "src/content/blog";
  const posts: Post[] = [];
  try {
    if (!(await stat(dir)).isDirectory()) return posts;
  } catch {
    return posts;
  }

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const slug = entry.name.slice(0, -3);
    if (!slugPattern.test(slug)) {
      throw new Error(`Unsafe file name in ${dir}: ${entry.name}`);
    }

    const text = await read(`${dir}/${entry.name}`);
    const { frontmatter } = parseFrontmatter(text);
    validatePost(slug, frontmatter);

    posts.push({
      slug,
      title: String(frontmatter.title),
      description: String(frontmatter.description),
      date: new Date(String(frontmatter.date)),
      ogImage: typeof frontmatter.ogImage === "string" ? frontmatter.ogImage : undefined,
      ogImageAlt: typeof frontmatter.ogImageAlt === "string" ? frontmatter.ogImageAlt : undefined,
      // Draft posts build nowhere: no page, no listing, no RSS, no llms.txt.
      // Flip to false (or remove the line) to publish.
      draft: frontmatter.draft === true,
      path: `${dir}/${entry.name}`,
    });
  }

  return posts.sort((a, b) => b.date.getTime() - a.date.getTime());
}

export async function publishedPosts(): Promise<Post[]> {
  return (await discoverPosts()).filter((post) => !post.draft);
}

function canonical(path: string): string {
  return path === "/" ? urlBase : `${urlBase}${path.replace(/\/$/, "")}/`;
}

function replaceValueTokens(content: string, vars: Record<string, string>): string {
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, escapeHtml(value));
  }
  return content;
}

function assertNoTokens(label: string, content: string): void {
  const unresolved = content.match(/{{[^}]+}}/);
  if (unresolved) {
    throw new Error(`Unresolved token in ${label}: ${unresolved[0]}`);
  }
}

function insert(content: string, name: string, value: string): string {
  return content.replaceAll(`<!-- insert:${name} -->`, value);
}

function assertNoInserts(content: string): void {
  const unresolved = content.match(/<!-- insert:[a-z0-9-]+ -->/);
  if (unresolved) {
    throw new Error(`Unresolved insert: ${unresolved[0]}`);
  }
}

async function renderTokens(label: string, content: string, vars: Record<string, string> = {}): Promise<string> {
  const rendered = replaceValueTokens(content, vars);
  assertNoTokens(label, rendered);
  return rendered;
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href) || /^\//.test(href) || /^#/.test(href);
}

function highlightCode(text: string, language = "text"): string {
  let code = escapeHtml(text);
  const stash: string[] = [];
  const token = (className: string, value: string) => {
    const key = String.fromCodePoint(0xe000 + stash.length);
    stash.push(`<span class="syntax-${className}">${value}</span>`);
    return key;
  };

  if (["sh", "bash", "shell"].includes(language)) {
    code = code
      .replace(/(^|\s)(#[^\n]*)/gm, (_match, lead, value) => `${lead}${token("comment", value)}`)
      .replace(/(&quot;[^\n]*?&quot;|'[^\n]*?')/g, (value) => token("string", value))
      .replace(/(^|[;&|]\s*)(bun|shis|ssh|sh|git|gh|curl|cd|systemctl|journalctl|podman|npm|docker|brew|mkdir|sudo)(?=\s|$)/gm, (_match, lead, value) => `${lead}${token("command", value)}`)
      .replace(/(^|\s)(--?[a-z][a-z0-9-]*)(?=\s|$)/g, (_match, lead, value) => `${lead}${token("option", value)}`);
  } else if (language === "json") {
    code = code
      .replace(/(&quot;[^&\n]*?&quot;)(\s*:)?/g, (_match, value, colon) => token(colon ? "key" : "string", value) + (colon ?? ""))
      .replace(/\b(true|false|null)\b/g, (value) => token("literal", value))
      .replace(/\b-?\d+(?:\.\d+)?\b/g, (value) => token("number", value));
  } else if (["ts", "typescript", "js", "javascript"].includes(language)) {
    code = code
      .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (value) => token("comment", value))
      .replace(/(&quot;[^\n]*?&quot;|'[^\n]*?'|`[^\n]*?`)/g, (value) => token("string", value))
      .replace(/\b(import|export|from|const|let|function|async|await|return|if|else|new|throw|type|interface)\b/g, (value) => token("keyword", value));
  } else if (["html", "xml"].includes(language)) {
    code = code
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, (value) => token("comment", value))
      .replace(/(&quot;[^\n]*?&quot;)/g, (value) => token("string", value))
      .replace(/(&lt;\/?)([a-zA-Z][a-zA-Z0-9-]*)/g, (_match, lead, name) => `${lead}${token("keyword", name)}`)
      .replace(/([a-zA-Z][a-zA-Z0-9-]*)(=)/g, (_match, attr, eq) => `${token("key", attr)}${eq}`);
  }

  return code.replace(/[\ue000-\uf8ff]/g, (key) => stash[key.codePointAt(0)! - 0xe000]!);
}

// Safe-by-default markdown: raw HTML is dropped, links must be http(s),
// mailto, tel, relative, or fragment, and code gets classed spans.
function safeMarkdownHtml(markdown: string): string {
  return Bun.markdown.render(markdown, {
    html: () => "",
    heading: (children, attrs: { level: number }) => `<h${attrs.level}>${children}</h${attrs.level}>`,
    paragraph: (children) => `<p>${children}</p>`,
    strong: (children) => `<strong>${children}</strong>`,
    emphasis: (children) => `<em>${children}</em>`,
    codespan: (text) => `<code>${escapeHtml(text)}</code>`,
    code: (text, meta?: { language?: string }) => {
      const lang = meta?.language ? ` language="${meta.language}"` : "";
      return `<pre><code${lang}>${highlightCode(text, (meta?.language ?? "text").toLowerCase())}</code></pre>`;
    },
    link: (children, attrs: { href: string }) => (isSafeHref(attrs.href) ? `<a href="${attrs.href}">${children}</a>` : children),
    image: (children, attrs: { src: string }) =>
      isSafeHref(attrs.src) ? `<img src="${attrs.src}" alt="${escapeHtml(children.replace(/<[^>]+>/g, ""))}" loading="lazy">` : "",
    list: (children, attrs: { ordered: boolean }) => {
      const tag = attrs.ordered ? "ol" : "ul";
      return `<${tag}>${children}</${tag}>`;
    },
    listItem: (children) => `<li>${children}</li>`,
    blockquote: (children) => `<blockquote>${children}</blockquote>`,
  });
}

function ogImageFor(post?: Post): string {
  if (post?.ogImage) {
    return post.ogImage.startsWith("/") ? urlBase + post.ogImage : `${urlBase}/${post.ogImage}`;
  }
  return `${urlBase}/og-default.png`;
}

async function metaHtml(title: string, description: string, path: string, post?: Post): Promise<string> {
  const url = canonical(path);
  const image = ogImageFor(post);
  // og:image dimensions are only declared for the default 1200×630 image;
  // a custom ogImage can be any size, so we leave its dimensions to the
  // platform to measure. Image alt comes from the post's ogImageAlt or
  // falls back to the site name; without a custom image there is no alt.
  const defaultImage = post === undefined || post.ogImage === undefined;
  // Alt text for the declared image: the post's ogImageAlt when it has a
  // custom image, the site name for the known default og image, nothing
  // when a custom image ships without an alt to describe it.
  const imageAlt = post?.ogImageAlt ?? (defaultImage ? SITE.name : undefined);
  const twitter = SITE.twitter.replace(/^@/, "");
  const tags = [
    `<meta property="og:type" content="${post ? "article" : "website"}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:image" content="${image}">`,
    ...(defaultImage
      ? [`<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`]
      : []),
    ...(imageAlt ? [`<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">`] : []),
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE.name)}">`,
    ...(post ? [`<meta property="article:published_time" content="${post.date.toISOString()}">`] : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    ...(twitter ? [`<meta name="twitter:site" content="${escapeHtml(twitter)}">`] : []),
    `<meta name="twitter:url" content="${url}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    ...(imageAlt ? [`<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">`] : []),
    ...(post ? [`<link rel="alternate" type="text/markdown" href="/posts/${post.slug}.md">`] : []),
  ];
  return tags.join("\n    ");
}

async function frame(title: string, description: string, path: string, page: string, post?: Post): Promise<string> {
  let layout = await renderTokens("layout", await read("src/layout.html"), {
    title,
    description,
    author: SITE.author,
    "site-name": SITE.name,
    canonical: canonical(path),
    year: String(new Date().getFullYear()),
    "asset-version": assetVersion,
  });
  layout = insert(layout, "meta", await metaHtml(title, description, path, post));
  layout = insert(layout, "page-style", "");
  layout = insert(layout, "page", page);
  layout = insert(layout, "page-script", "");
  assertNoInserts(layout);
  return layout;
}

async function homeHtml(): Promise<string> {
  const posts = await publishedPosts();
  const items = posts
    .map(
      (post) =>
        `<li><a href="/posts/${post.slug}/"><time datetime="${post.date.toISOString().split("T")[0]}">${post.date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</time><h3>${escapeHtml(post.title)}</h3><p>${escapeHtml(post.description)}</p></a></li>`,
    )
    .join("\n      ");

  let page = await renderTokens("home", await read("src/pages/index.html"), { "site-name": SITE.name });
  page = insert(page, "posts", items);
  return frame(SITE.name, SITE.description, "/", page);
}

async function postHtml(slug: string): Promise<string | undefined> {
  const post = (await publishedPosts()).find((candidate) => candidate.slug === slug);
  if (!post) return;

  const { body } = parseFrontmatter(await read(post.path));
  const dateIso = post.date.toISOString().split("T")[0]!;
  const dateDisplay = post.date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  // Neutralize any remaining template tokens that arrived in the markdown
  // itself so a `{{ }}` in a post cannot become markup.
  const renderedBody = safeMarkdownHtml(body).replaceAll("{{", "&#123;&#123;").replaceAll("}}", "&#125;&#125;");

  let page = await renderTokens("post", await read("src/pages/post.html"), {
    "site-name": SITE.name,
    "date-iso": dateIso,
    date: dateDisplay,
    title: post.title,
    description: post.description,
  });
  page = insert(page, "body", renderedBody);
  return frame(post.title, post.description, `/posts/${post.slug}`, page, post);
}

async function postMarkdown(slug: string): Promise<string | undefined> {
  const post = (await publishedPosts()).find((candidate) => candidate.slug === slug);
  if (!post) return;
  const { body } = parseFrontmatter(await read(post.path));
  return `# ${post.title}\n\n${post.date.toISOString().slice(0, 10)}\n\n${body.trim()}\n`;
}

async function notFoundHtml(): Promise<string> {
  const page = await renderTokens("404", await read("src/pages/404.html"), { "site-name": SITE.name });
  return frame(`Not found · ${SITE.name}`, SITE.description, "/404", page);
}

async function rssXml(): Promise<string> {
  const posts = await publishedPosts();
  const items = posts
    .map((post) => {
      const url = canonical(`/posts/${post.slug}`);
      return [
        "  <item>",
        `    <title>${escapeXml(post.title)}</title>`,
        `    <link>${url}</link>`,
        `    <guid>${url}</guid>`,
        `    <pubDate>${post.date.toUTCString()}</pubDate>`,
        `    <description>${escapeXml(post.description)}</description>`,
        "  </item>",
      ].join("\n");
    })
    .join("\n");
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<rss version="2.0">', "  <channel>", `    <title>${escapeXml(SITE.name)}</title>`, `    <link>${urlBase}/</link>`, `    <description>${escapeXml(SITE.description)}</description>`, "    <language>en</language>", items, "  </channel>", "</rss>", ""].join("\n");
}

async function llmsTxt(): Promise<string> {
  const posts = await publishedPosts();
  return [
    `# ${SITE.name}`,
    "",
    `> ${SITE.description}`,
    "",
    "Every post is also available as plain markdown at the .md links below.",
    "",
    "## Posts",
    "",
    ...posts.map((post) => `- [${post.title}](${urlBase}/posts/${post.slug}.md): ${post.description}`),
    "",
  ].join("\n");
}

async function robotsTxt(): Promise<string> {
  return `User-agent: *\nAllow: /\n\nSitemap: ${urlBase}/sitemap.xml\n`;
}

async function sitemapXml(): Promise<string> {
  const posts = await publishedPosts();
  const urls = ["/", ...posts.map((post) => `/posts/${post.slug}`)]
    .map((path) => `  <url><loc>${canonical(path)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

app.get("/", async (c) => c.html(await homeHtml()));

app.get("/posts/:slug", async (c) => {
  const slug = c.req.param("slug");
  // Markdown alternates live at the same URL with `.md` appended; the
  // `:slug` param would otherwise swallow them as an unknown post id.
  if (slug.endsWith(".md")) {
    const body = await postMarkdown(slug.slice(0, -3));
    if (body === undefined) return c.notFound();
    return c.body(body, 200, { "content-type": "text/plain; charset=utf-8", "content-disposition": "inline" });
  }
  const html = await postHtml(slug);
  if (html) return c.html(html);
  return c.notFound();
});

app.get("/rss.xml", async (c) => c.body(await rssXml(), 200, { "content-type": "application/rss+xml; charset=utf-8" }));
app.get("/llms.txt", async (c) => c.body(await llmsTxt(), 200, { "content-type": "text/plain; charset=utf-8" }));
app.get("/robots.txt", async (c) => c.body(await robotsTxt(), 200, { "content-type": "text/plain; charset=utf-8" }));
app.get("/sitemap.xml", async (c) => c.body(await sitemapXml(), 200, { "content-type": "application/xml; charset=utf-8" }));

app.use("/*", serveStatic({ root: "./public" }));

app.notFound(async (c) => c.html(await notFoundHtml(), 404));

export default app;