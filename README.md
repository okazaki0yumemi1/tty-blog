# tty-blog

A blog that renders Markdown files in a **terminal-styled web UI**. Visitors
see a bash-like prompt and read posts with familiar commands — but nothing
behind it is a real shell.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

## Adding posts

Drop a Markdown file into `pages/`. That's the whole publishing workflow.

```markdown
---
title: My Post
date: 2026-10-17
tags: [general, ideas]
description: optional one-liner
---

Post body in Markdown — images, code, tables, everything.
```

- Subfolders work (`pages/notes/idea.md` → `cat notes/idea`).
- Put images anywhere under `pages/` (e.g. `pages/assets/pic.png`) and
  reference them relatively from the Markdown: `![alt](assets/pic.png)`.
- `title` falls back to the file name; `date` and `tags` are optional.

## Terminal commands available to visitors

| command | description |
| --- | --- |
| `ls` / `list` | list folders and posts in the current folder |
| `cd <folder>` | enter a folder (`cd ..` up, `cd -` previous, `cd` = root) |
| `cat <page>` / `read <page>` | open a post (name, path, or number from `ls`) |
| `tags` | list tags with counts |
| `tag <name>` | filter posts by tag |
| `search <query>` | search titles, tags, and bodies |
| `theme green\|amber\|blue` | change the CRT color |
| `help` | show help |

Tab-completion, ↑/↓ history, Ctrl-C / Ctrl-L all work.

## Security model

- **No real terminal.** The UI is a frontend simulation. Commands are matched
  against a fixed allow-list; anything else (including `rm`, `bash`, `sudo`,
  output redirection) is rejected with a message.
- **Read-only API.** The server exposes only `GET /api/posts`,
  `GET /api/posts/<file>.md`, and `GET /files/<image>`. There are no
  mutating routes.
- **Path jailing.** Every requested path is resolved and must stay inside
  `pages/`; post reads only accept `.md` files, `/files/` only serves image
  extensions, and null bytes / traversal sequences are rejected.

## Running under a sub-location (e.g. `https://example.com/tty-blog`)

The frontend derives its own base path from the browser URL (inline script in
`index.html` head), so **assets and API calls work through any prefix without
frontend changes**. The server just needs to receive the routes:

**Mode A — proxy keeps the prefix** → run with `BASE_PATH` so routes are mounted there:

```bash
BASE_PATH=/tty-blog npm start
```

```nginx
location /tty-blog/ {
  proxy_pass http://127.0.0.1:3000;      # no trailing slash: prefix is kept
  proxy_set_header Host $host;
}
```

**Mode B — proxy strips the prefix** → run with **no** `BASE_PATH`; nothing
else to configure:

```nginx
location /tty-blog/ {
  proxy_pass http://127.0.0.1:3000/;     # trailing slash: prefix is stripped
  proxy_set_header Host $host;
}
```

Caddy:

```
handle /tty-blog/* {
  reverse_proxy 127.0.0.1:3000           # keeps prefix → use Mode A (BASE_PATH)
}
# or: handle_path /tty-blog/* { reverse_proxy 127.0.0.1:3000 }  → Mode B
```

## Layout

```
├── server.js          # Express server + read-only JSON API
├── pages/             # ← your blog: one .md file per post
│   └── assets/        # images referenced from posts
└── public/            # the fake-terminal frontend
    ├── index.html
    ├── style.css
    └── app.js
```
