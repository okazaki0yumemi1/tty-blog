---
title: Welcome to tty-blog
date: 2026-10-17
tags: [meta, help]
description: What this place is and how to drive the terminal.
---

# Welcome

You are looking at a blog that pretends to be a terminal. There is no real
shell behind it — every command below is handled in your browser against a
**read-only** API. You can read, you cannot break.

## Driving around

| command | what it does |
| ------- | ------------ |
| `ls` | list every post |
| `cat welcome` | read a post (by name or by number from `ls`) |
| `tags` | list all tags |
| `tag help` | filter posts by tag |
| `search terminal` | full-text search |
| `theme amber` | change the CRT phosphor |

## How the blog works

Posts are plain **Markdown files** dropped into the `pages/` folder on the
server — no database, no admin panel. Front matter at the top of each file
carries the metadata:

```yaml
---
title: My Post
date: 2026-10-17
tags: [example, demo]
---
```

Add a file, refresh, done. `ls` picks it up automatically.

> Try `cat markdown-demo` to see every supported Markdown feature, including
> images.
