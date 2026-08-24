---
title: Writing for readers who curl
description: Half your readers are now agents. Serving markdown alternates and an llms.txt costs one endpoint and respects both audiences.
date: 2026-06-20
---

Someone will read this post in a browser. Something will read it with an HTTP client and a token budget.

The polite response is to serve both well. Every post here exists twice: the HTML you may be reading, and a plain markdown file at the same path with `.md` on the end. An `llms.txt` at the root lists them all with one-line summaries, so an agent can survey the whole site in a single small request instead of scraping navigation markup.

![A hand writing calligraphy with a brush and black ink](https://images.pexels.com/photos/9478289/pexels-photo-9478289.jpeg?auto=compress&cs=tinysrgb&w=1200)

<small>Photo via [Pexels](https://www.pexels.com/photo/calligraphy-using-a-blank-ink-and-paint-brush-9478289/)</small>

This is not much work. The markdown already exists; the build just refrains from destroying it. One endpoint, a dozen lines.

Formats are a courtesy. HTML for eyes, markdown for context windows, RSS for the patient. The content is the same; only the reader changes.
