---
title: Own your source
description: Frameworks lend you abstractions and charge interest. Generated code you can read is a debt-free way to start a project.
date: 2026-08-01
---

Most starters hand you a dependency. This one hands you files.

The difference shows up six months in. When behavior lives in a package, changing it means reading someone else's issue tracker. When behavior lives in your repository, changing it means editing a file you have already read.

![Six calligraphy brushes laid out on paper](https://images.pexels.com/photos/6315632/pexels-photo-6315632.jpeg?auto=compress&cs=tinysrgb&w=1200)

<small>Photo via [Pexels](https://www.pexels.com/photo/close-up-of-ink-brushes-6315632/)</small>

Generated code has a bad reputation because generators used to produce piles you could not maintain. The fix is not less generation; it is generating less. A route file, a layout, a stylesheet with five variables. Small enough to read in one sitting, which means small enough to own.

There is a test for this: delete the tool that made the project. If the project still builds, still deploys, and still makes sense, you own it. If not, you rented it.
