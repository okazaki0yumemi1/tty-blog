/**
 * ttu-blog — terminal-styled read-only Markdown blog.
 *
 * Security model:
 *  - The visitor never touches a real shell. The terminal is a pure frontend
 *    simulation; the only backend surface is these read-only JSON endpoints.
 *  - Every requested path is resolved and verified to stay inside ./pages.
 *  - Post endpoints only accept *.md files; file endpoints only accept images.
 *  - There are no POST/PUT/DELETE routes at all: writing is impossible.
 *
 * Sub-location support:
 *  - Set BASE_PATH (e.g. "/ttu-blog") when running behind a reverse proxy
 *    that mounts the app under a prefix. All routes are mounted there, and a
 *    <base href> tag is injected into index.html so the frontend's relative
 *    URLs keep working. Leave empty to serve at the root.
 */
const path = require('path');
const fsp = require('fs/promises');
const express = require('express');
const matter = require('gray-matter');

const PORT = process.env.PORT || 3000;
const PAGES_DIR = path.resolve(__dirname, 'pages');

/** Normalise BASE_PATH: '' or '/ttu-blog' (leading slash, no trailing slash). */
function normalizeBase(raw) {
  if (!raw || raw === '/') return '';
  let b = String(raw).trim();
  if (!b.startsWith('/')) b = '/' + b;
  return b.replace(/\/+$/, '');
}
const BASE_PATH = normalizeBase(process.env.BASE_PATH);

const MD_EXT = '.md';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico']);

/** Resolve a user-supplied relative path, guaranteeing it stays inside pages/. */
function safeResolve(userPath) {
  if (typeof userPath !== 'string' || userPath.length === 0) return null;
  // Reject null bytes and backslashes (Windows-style traversal tricks).
  if (userPath.includes('\0')) return null;
  const cleaned = userPath.replace(/\\/g, '/');
  const resolved = path.resolve(PAGES_DIR, cleaned);
  if (resolved !== PAGES_DIR && !resolved.startsWith(PAGES_DIR + path.sep)) return null;
  return resolved;
}

/** Recursively collect all .md files under pages/, as posix-relative paths. */
async function listMarkdownFiles(dir, rel = '') {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listMarkdownFiles(abs, relPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(MD_EXT)) {
      out.push(relPath);
    }
  }
  return out;
}

async function postMeta(relPath) {
  const raw = await fsp.readFile(path.join(PAGES_DIR, relPath), 'utf8');
  const { data } = matter(raw);
  let date = null;
  if (data.date instanceof Date && !isNaN(data.date)) {
    date = data.date.toISOString();
  } else if (data.date) {
    date = String(data.date);
  }
  return {
    file: relPath,
    title: data.title || relPath.replace(/\.md$/i, '').replace(/[-_]/g, ' '),
    date,
    tags: Array.isArray(data.tags)
      ? data.tags.map(String)
      : data.tags
        ? [String(data.tags)]
        : [],
    description: data.description || null,
  };
}

// ---------- Build the app on a router so it can be mounted anywhere ----------
// index.html derives its own <base href> from location.pathname (see head of
// index.html), so the frontend works behind any proxy prefix without the
// server having to know it. BASE_PATH only needs to match proxy modes that
// KEEP the prefix (see README).
const app = express();
const blog = express.Router();

// Static frontend (index.html, style.css, app.js, …) — all referenced relatively.
blog.use(express.static(path.join(__dirname, 'public')));

// Static frontend (style.css, app.js, …) — all referenced relatively.
blog.use(express.static(path.join(__dirname, 'public')));

// Serve the marked library (Markdown renderer used by the frontend) locally.
blog.get('/vendor/marked.umd.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
});

// ---------- Read-only API ----------

// List all posts (with tags), newest first.
blog.get('/api/posts', async (_req, res) => {
  try {
    const files = await listMarkdownFiles(PAGES_DIR);
    const posts = await Promise.all(files.map(postMeta));
    posts.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file));
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: 'failed to list posts' });
  }
});

// Read a single post. Allows nested paths like "notes/idea.md".
blog.get(/^\/api\/posts\/(.+)$/, async (req, res) => {
  const rel = decodeURIComponent(req.params[0]);
  if (!rel.toLowerCase().endsWith(MD_EXT)) {
    return res.status(400).json({ error: 'only .md files can be read' });
  }
  const abs = safeResolve(rel);
  if (!abs) return res.status(403).json({ error: 'forbidden path' });
  try {
    const raw = await fsp.readFile(abs, 'utf8');
    const { data, content } = matter(raw);
    const meta = await postMeta(path.relative(PAGES_DIR, abs));
    res.json({ ...meta, content });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return res.status(404).json({ error: 'no such post' });
    }
    res.status(500).json({ error: 'failed to read post' });
  }
});

// Serve images referenced from posts (e.g. pages/assets/diagram.svg).
blog.get(/^\/files\/(.+)$/, async (req, res) => {
  const rel = decodeURIComponent(req.params[0]);
  const abs = safeResolve(rel);
  if (!abs) return res.status(403).json({ error: 'forbidden path' });
  if (!IMAGE_EXTS.has(path.extname(abs).toLowerCase())) {
    return res.status(400).json({ error: 'only image files are served here' });
  }
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
  });
});

// Anything else under /api is a 404 (and no mutating routes exist by design).
blog.all('/api/*', (_req, res) => res.status(404).json({ error: 'not found' }));

// Mount the whole app under BASE_PATH ('' = root).
app.use(BASE_PATH || '/', blog);

// Convenience: when mounted under a prefix, guide bare-root visitors there.
if (BASE_PATH) {
  app.get('/', (_req, res) => res.redirect(302, BASE_PATH + '/'));
}

app.listen(PORT, () => {
  console.log(`ttu-blog listening on http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`pages directory: ${PAGES_DIR}`);
});
