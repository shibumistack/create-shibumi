// One place for site identity. Everything (head tags, RSS, llms.txt,
// sitemap, robots) reads from here.
export const SITE = {
  name: "Quiet notes",
  description: "A blog about building calm, owned software.",
  author: "Your Name",
  // Set to your handle (without "@") to emit twitter:site, e.g. "quietnotes".
  twitter: "",
  // TODO: set your real domain before the first `bun ship`; canonicals,
  // og:url, RSS links, and the sitemap all derive from it.
  url: "https://example.com",
};