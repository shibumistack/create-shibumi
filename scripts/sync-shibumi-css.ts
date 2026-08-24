// Vendors the canonical shibumi.css design tokens into the app templates.
// Source of truth is the shibumistack.dev repo (public/shibumi.css); vendored
// copies are never edited by hand. Run after the canonical file changes:
//
//   bun run sync:css [path-to-shibumistack.dev]
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOURCE = resolve(process.argv[2] ?? join(ROOT, "..", "shibumistack.dev"), "public", "shibumi.css");
const TARGETS = ["web", "full-stack"].map((template) =>
  join(ROOT, "src", "templates", template, "public", "vendor", "shibumi.css"),
);

if (!existsSync(SOURCE)) {
  console.error(`canonical shibumi.css not found at ${SOURCE}; pass the site checkout as the first argument.`);
  process.exit(1);
}
for (const target of TARGETS) {
  copyFileSync(SOURCE, target);
  console.log(`synced ${target}`);
}
