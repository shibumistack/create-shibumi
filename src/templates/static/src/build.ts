import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import { Marked } from "marked";

const marked = new Marked();
const SRC = import.meta.dir;
const ROOT = join(SRC, "..");
const DIST = join(ROOT, "dist");
const CONTENT = join(ROOT, "content");
const PUBLIC = join(ROOT, "public");

// ── Ensure dist/ ────────────────────────────────────────────────────

mkdirSync(DIST, { recursive: true });

// ── Copy public/ ────────────────────────────────────────────────────

cpSync(PUBLIC, DIST, { recursive: true });

// ── Build pages ─────────────────────────────────────────────────────

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  ${body}
</body>
</html>`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Index ───────────────────────────────────────────────────────────

const files = readdirSync(CONTENT).filter((f) => f.endsWith(".md"));
const posts = files.map((f) => {
  const raw = readFileSync(join(CONTENT, f), "utf-8");
  const { data, content } = matter(raw);
  return { slug: f.replace(/\.md$/, ""), meta: data, content };
});

posts.sort((a, b) => new Date(b.meta.date).getTime() - new Date(a.meta.date).getTime());

const indexHtml = layout(
  "Site",
  `<h1>Site</h1>
<ul>
${posts.map((p) => `  <li><a href="/${p.slug}.html">${escape(p.meta.title)}</a> · ${p.meta.date}</li>`).join("\n")}
</ul>`
);

writeFileSync(join(DIST, "index.html"), indexHtml);

// ── Posts ───────────────────────────────────────────────────────────

for (const post of posts) {
  const html = marked.parse(post.content) as string;
  const pageHtml = layout(
    post.meta.title,
    `<a href="/">&larr; Home</a>
<h1>${escape(post.meta.title)}</h1>
<p>${post.meta.date}</p>
${html}`
  );
  writeFileSync(join(DIST, `${post.slug}.html`), pageHtml);
}

console.log(`Built ${posts.length + 1} pages to dist/`);
