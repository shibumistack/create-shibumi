---
title: One VPS is plenty
description: A five-euro server runs more blogs than most of us will ever write. The hard part was never capacity; it was confidence.
date: 2026-07-15
---

This site is static files behind a 1.4 MB container on a small VPS. It could serve every reader I will ever have from a machine that also runs four other projects.

What kept people off their own servers was never capacity. It was the deploy story: what happens when the build breaks, how you roll back, whether the thing you tested is the thing that shipped. Platforms answered those questions and charged rent on the answer.

The answers turn out to be portable. Build the exact commit, verify the output, ship the image, health-check before cutover, keep the previous image for rollback. None of that requires a platform; it requires a script you can read.

Rent is fine. Owning is calmer.
