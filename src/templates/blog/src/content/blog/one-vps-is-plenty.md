---
title: One VPS is plenty
description: This blog is static files in a 1.4 MB container on a shared five-euro VPS. The deploy script, not the hardware, is what platforms were selling.
date: 2026-07-15
---

This site is static files behind a 1.4 MB container on a small VPS that also runs four other projects. A five-euro machine serves this traffic without noticing.

People stayed on platforms for the deploy story: what happens when the build breaks, how to roll back, whether the thing you tested is the thing that shipped.

![A single stack of balanced stones by the sea](https://images.pexels.com/photos/289586/pexels-photo-289586.jpeg?auto=compress&cs=tinysrgb&w=1200)

<small>Photo via [Pexels](https://www.pexels.com/photo/289586/)</small>

Those answers fit in a script. Build the exact commit, verify the output, upload the image over SSH, health-check before cutover, keep the previous image for rollback. `bun ship` runs all of it, and the script is short enough to read before you trust it.
