---
title: Own your source
description: This starter copies routes, styles, and config into your repository as plain files. What that costs you, and what it saves, six months in.
date: 2026-08-01
---

This starter does not install itself as a dependency. It copies files into your repository and gets out of the way.

The difference shows up six months in. To change behavior that lives in a package, you read someone else's issue tracker and wait for a release. To change behavior that lives in your repository, you edit a file you have already read.

![Six calligraphy brushes laid out on paper](https://images.pexels.com/photos/6315632/pexels-photo-6315632.jpeg?auto=compress&cs=tinysrgb&w=1200)

<small>Photo via [Pexels](https://www.pexels.com/photo/close-up-of-ink-brushes-6315632/)</small>

Generated code earned its bad reputation from generators that produced more code than anyone could maintain. So this one generates little: a route file, a layout, a stylesheet with five variables. Reading all of it takes one sitting.

One test tells you whether you own a project: delete the tool that made it. This site still builds, still deploys, and still makes sense with create-shibumi gone.
