// Vendors the canonical shibumi.css design tokens into the app templates.
// Source of truth is the shibumistack.dev repo (public/shibumi.css); vendored
// copies are never edited by hand. Run after the canonical file changes:
//
//   bun run sync:css [path-to-shibumistack.dev]
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SITE = resolve(process.argv[2] ?? join(ROOT, "..", "shibumistack.dev"), "public");
// css only: apps get a flat surface, so the kozo image stays with the sites.
const FILES = ["shibumi.css"];

if (!existsSync(join(SITE, "shibumi.css"))) {
  console.error(`canonical shibumi.css not found in ${SITE}; pass the site checkout as the first argument.`);
  process.exit(1);
}
for (const template of ["full-stack"]) {
  for (const file of FILES) {
    const target = join(ROOT, "src", "templates", template, "public", "vendor", file);
    copyFileSync(join(SITE, file), target);
    console.log(`synced ${target}`);
  }
}
