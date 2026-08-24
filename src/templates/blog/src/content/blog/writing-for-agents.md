---
title: Writing for readers who curl
description: Every post here is served twice, as rendered HTML and as plain markdown, with an llms.txt index. One endpoint covers the agent readers.
date: 2026-06-20
---

Half the readers of this post are agents: HTTP clients with a token budget instead of a viewport.

So every post here exists twice. There is the HTML you may be reading, and a plain markdown file at the same URL with `.md` appended. An `llms.txt` at the root lists every post with a one-line summary, so an agent can survey the whole site in one small request instead of scraping navigation markup.

![A hand writing calligraphy with a brush and black ink](https://images.pexels.com/photos/9478289/pexels-photo-9478289.jpeg?auto=compress&cs=tinysrgb&w=1200)

<small>Photo via [Pexels](https://www.pexels.com/photo/calligraphy-using-a-blank-ink-and-paint-brush-9478289/)</small>

The markdown already existed; the build publishes it instead of throwing it away. One endpoint, about a dozen lines of it.
