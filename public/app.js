/**
 * ttu-blog terminal UI.
 *
 * This is a pure frontend simulation. There is no real shell anywhere:
 * commands are matched against a fixed allow-list and can only call the
 * read-only HTTP endpoints (/api/posts, /api/posts/<file>, /files/<img>).
 */
(() => {
  'use strict';

  const screen = document.getElementById('screen');
  const output = document.getElementById('output');
  const cmdInput = document.getElementById('cmdInput');

  // All URLs are relative; the <base href> tag injected by server.js resolves
  // them correctly whether the app is served at "/" or "/ttu-blog/".
  const url = (...parts) => new URL(parts.join('/'), document.baseURI).href;

  let posts = [];          // cached from /api/posts
  let lastList = [];       // what `ls` last showed (for numeric `cat 3`)
  let history = [];        // command history
  let histIdx = -1;
  let currentPost = null;  // file currently open (for image URL rewriting)

  // ---------------------------------------------------------------- utilities
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const print = (html, cls = 'out') => {
    output.appendChild(el('div', cls, html));
    scrollDown();
  };

  const scrollDown = () => { screen.scrollTop = screen.scrollHeight; };

  const promptHtml = () =>
    '<span class="prompt"><span class="p-user">guest</span>@<span class="p-host">ttu-blog</span>:<span class="p-path">~</span><span class="p-dollar">$</span></span>';

  function echo(cmd) {
    output.appendChild(el('div', 'echo-line', promptHtml() + esc(cmd)));
  }

  const refreshPosts = async () => {
    try {
      const r = await fetch(url('api', 'posts'));
      const data = await r.json();
      posts = data.posts || [];
    } catch {
      print('<span class="err">error: could not reach the blog API</span>');
    }
  };

  // Split a command line into argv, supporting 'quoted strings' and "doubles".
  function tokenize(line) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(line))) tokens.push(m[1] ?? m[2] ?? m[3]);
    return tokens;
  }

  // ---------------------------------------------------------------- commands
  const BANNED = ['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'write', 'save', 'append',
    'chmod', 'chown', 'sudo', 'su', 'bash', 'sh', 'zsh', 'fish', 'dash', 'nano', 'vim',
    'vi', 'emacs', 'ed', 'dd', 'mkfs', 'passwd', 'kill', 'reboot', 'shutdown', 'curl',
    'wget', 'ssh', 'scp', 'ftp', 'nc', 'apt', 'apt-get', 'yum', 'npm', 'pip', 'git',
    'python', 'python3', 'node', 'eval', 'exec', 'systemctl', 'service', 'crontab'];

  function denyWrite(cmd) {
    print(`<span class="err">read-only filesystem: '${esc(cmd)}' is not permitted here.</span>`);
    print('<span class="dim">This blog is a simulated terminal for reading only — there is no real shell behind it.</span>');
  }

  const HELP = [
    ['ls | list', 'list all blog posts'],
    ['cat <page> | read <page>', 'open and read a post (name, number from ls, or path.md)'],
    ['tags', 'list all tags'],
    ['tag <name>', 'list posts with a given tag'],
    ['search <query>', 'search post titles, tags and bodies'],
    ['open <n>', 'alias of cat, takes the number from the last listing'],
    ['clear', 'clear the screen'],
    ['theme [green|amber|blue]', 'switch the CRT colour'],
    ['whoami', 'who are you?'],
    ['help', 'show this help'],
  ];

  function cmdHelp() {
    print('<span class="cy">Available commands</span>');
    const rows = HELP.map(([c, d]) =>
      `  <span class="ok">${esc(c.padEnd(30))}</span><span class="dim">${esc(d)}</span>`).join('\n');
    print(rows);
    print('<span class="dim">Tip: use Tab to complete page names, ↑/↓ for history.</span>');
  }

  function fmtDate(d) { return d ? d.slice(0, 10) : '—'; }

  function renderTable(list, { highlight = null } = {}) {
    if (!list.length) {
      print('<span class="dim">nothing here.</span>');
      lastList = [];
      return;
    }
    lastList = list;
    const rows = list.map((p, i) => {
      const mark = highlight === p.file ? '<span class="ok">▶</span> ' : '&nbsp;&nbsp;';
      const tags = p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ') || '<span class="dim">—</span>';
      return `<tr><td class="dim">${String(i + 1).padStart(2)}</td>` +
        `<td class="name">${mark}${esc(p.file.replace(/\.md$/i, ''))}</td>` +
        `<td>${esc(p.title)}</td><td class="dim">${fmtDate(p.date)}</td><td>${tags}</td></tr>`;
    }).join('');
    print(`<table class="ls"><tr><th>#</th><th>page</th><th>title</th><th>date</th><th>tags</th></tr>${rows}</table>`);
    print(`<span class="dim">${list.length} page(s). Read one with: cat &lt;name&gt; or cat &lt;number&gt;</span>`);
  }

  async function cmdLs(args) {
    await refreshPosts();
    if (args[0] === '-t' || args[0] === '--tags') return cmdTags();
    renderTable(posts);
  }

  function findPost(query) {
    const q = query.toLowerCase().replace(/\.md$/, '');
    return posts.find((p) => {
      const stem = p.file.replace(/\.md$/i, '').toLowerCase();
      return stem === q || p.file.toLowerCase() === q + '.md';
    });
  }

  // Rewrite relative image src in rendered markdown to go through the
  // read-only "files/" endpoint (resolved against <base href>).
  // Fallback: a post in a subfolder that references "assets/x.jpg" first
  // tries pages/<subfolder>/assets/x.jpg, then pages/assets/x.jpg.
  function setImgSrc(img, src, dir) {
    if (/^(https?:|data:|\/\/)/i.test(src)) return; // external images load as-is
    const rel = src.replace(/^\.\//, '');
    const candidates = [];
    if (src.startsWith('/')) {
      // root-absolute in the post: map /assets/x.png -> <base>/files/assets/x.png
      candidates.push(url('files', rel.replace(/^\/+/, '')));
    } else {
      candidates.push(url('files', (dir ? dir + '/' : '') + rel));
      if (dir) candidates.push(url('files', rel)); // try pages-root fallback
    }
    let i = 0;
    img.src = candidates[0];
    img.addEventListener('error', () => {
      if (++i < candidates.length) img.src = candidates[i];
    }, { once: false });
  }

  function rewriteImages(container, postFile) {
    const dir = postFile.includes('/') ? postFile.slice(0, postFile.lastIndexOf('/')) : '';
    container.querySelectorAll('img').forEach((img) => {
      setImgSrc(img, img.getAttribute('src') || '', dir);
    });
    container.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      // markdown links to other posts -> run cat instead of navigating
      if (!/^(https?:|#|mailto:)/i.test(href) && /\.md($|#)/i.test(href)) {
        a.href = 'javascript:void(0)';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const [pathPart, anchor] = href.split('#');
          run(`cat ${pathPart}`);
          if (anchor) {
            const target = document.getElementById(decodeURIComponent(anchor));
            if (target) target.scrollIntoView();
          }
        });
      }
    });
  }

  async function cmdCat(args) {
    if (!args.length) {
      print('<span class="err">usage: cat &lt;page&gt;</span> <span class="dim">— see `ls` for page names</span>');
      return;
    }
    const q = args.join(' ');
    let post;
    if (/^\d+$/.test(q) && lastList.length) {
      post = lastList[parseInt(q, 10) - 1];
    } else {
      await refreshPosts();
      post = findPost(q) || posts.find((p) => p.file.replace(/\.md$/i, '').toLowerCase().includes(q.toLowerCase()));
    }
    if (!post) {
      print(`<span class="err">cat: ${esc(q)}: no such page</span> <span class="dim">— try \`ls\`</span>`);
      return;
    }
    let data;
    try {
      const r = await fetch(url('api', 'posts', post.file.split('/').map(encodeURIComponent).join('/')));
      if (!r.ok) throw new Error();
      data = await r.json();
    } catch {
      print(`<span class="err">cat: ${esc(post.file)}: could not read page</span>`);
      return;
    }
    currentPost = post.file;
    const metaHtml =
      `<div class="post-meta">file: <span class="cy">${esc(post.file)}</span>` +
      (data.date ? ` · date: ${esc(fmtDate(data.date))}` : '') +
      (data.tags.length ? ` · tags: ${data.tags.map((t) => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join(' ')}` : '') +
      `</div>`;
    const node = el('div', 'md');
    node.innerHTML = metaHtml + window.marked.parse(data.content);
    rewriteImages(node, post.file);
    node.querySelectorAll('.tag[data-tag]').forEach((t) =>
      t.addEventListener('click', () => run(`tag ${t.dataset.tag}`)));
    output.appendChild(node);
    scrollDown();
    print('<span class="dim">— end of file —</span>');
  }

  async function cmdTags() {
    await refreshPosts();
    const counts = new Map();
    for (const p of posts) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
    if (!counts.size) { print('<span class="dim">no tags yet.</span>'); return; }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => `  <span class="mg">#${esc(t)}</span>${' '.repeat(Math.max(1, 18 - t.length))}<span class="dim">${n} post(s) — see: tag ${esc(t)}</span>`)
      .join('\n');
    print('<span class="cy">Tags</span>\n' + rows);
  }

  async function cmdTag(args) {
    if (!args.length) { print('<span class="err">usage: tag &lt;name&gt;</span> <span class="dim">— see `tags`</span>'); return; }
    await refreshPosts();
    const name = args.join(' ').toLowerCase().replace(/^#/, '');
    const hits = posts.filter((p) => p.tags.some((t) => t.toLowerCase() === name));
    if (!hits.length) print(`<span class="err">no posts tagged #${esc(name)}</span> <span class="dim">— see \`tags\`</span>`);
    else { print(`<span class="mg">#${esc(name)}</span> — ${hits.length} post(s)`); renderTable(hits); }
  }

  async function cmdSearch(args) {
    if (!args.length) { print('<span class="err">usage: search &lt;query&gt;</span>'); return; }
    await refreshPosts();
    const q = args.join(' ').toLowerCase();
    const hits = [];
    for (const p of posts) {
      if (p.title.toLowerCase().includes(q) || p.file.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q))) {
        hits.push(p);
        continue;
      }
      try {
        const r = await fetch(url('api', 'posts', p.file.split('/').map(encodeURIComponent).join('/')));
        if (r.ok) {
          const d = await r.json();
          if ((d.content || '').toLowerCase().includes(q)) hits.push(p);
        }
      } catch { /* skip unreadable */ }
    }
    print(`<span class="cy">search: "${esc(args.join(' '))}"</span>`);
    renderTable(hits);
  }

  const THEMES = {
    green: { fg: '#9af5b1', accent: '#35ff70', glow: '0 0 6px rgba(53, 255, 112, 0.35)', border: '#16351f' },
    amber: { fg: '#f5deb0', accent: '#ffb347', glow: '0 0 6px rgba(255, 179, 71, 0.35)', border: '#3a2c14' },
    blue:  { fg: '#b0d4f5', accent: '#4da6ff', glow: '0 0 6px rgba(77, 166, 255, 0.35)', border: '#14304a' },
  };

  function cmdTheme(args) {
    const t = THEMES[(args[0] || 'green').toLowerCase()];
    if (!t) { print(`<span class="err">unknown theme: ${esc(args[0])}</span> <span class="dim">— try: green, amber, blue</span>`); return; }
    const r = document.documentElement.style;
    r.setProperty('--fg', t.fg);
    r.setProperty('--accent', t.accent);
    r.setProperty('--glow', t.glow);
    r.setProperty('--border', t.border);
    localStorage.setItem('ttu-theme', args[0].toLowerCase());
    print(`<span class="ok">theme set to ${esc(args[0].toLowerCase())}</span>`);
  }

  // ---------------------------------------------------------------- dispatch
  const COMMANDS = {
    help: cmdHelp, '?': cmdHelp,
    ls: cmdLs, list: cmdLs, dir: cmdLs, pages: cmdLs,
    cat: cmdCat, read: cmdCat, open: cmdCat, show: cmdCat,
    tags: cmdTags,
    tag: cmdTag,
    search: cmdSearch, grep: cmdSearch, find: cmdSearch,
    clear: () => { output.innerHTML = ''; },
    cls: () => { output.innerHTML = ''; },
    theme: cmdTheme,
    whoami: () => print('<span class="ok">guest</span> <span class="dim">— a visitor of a read-only blog. You can read, you cannot write. 🙂</span>'),
    pwd: () => print('/home/guest <span class="dim">(simulated — there is no real filesystem here)</span>'),
    date: () => print(new Date().toString()),
    exit: () => print('<span class="dim">There is no place like home… just close the tab. 🙂</span> <span class="err">(this terminal was never real anyway)</span>'),
    cd: () => print('<span class="dim">~/ is the only directory you need. Everything is in \`ls\`.</span>'),
    man: (a) => a.length ? run('help') : cmdHelp(),
  };

  async function dispatch(line) {
    const argv = tokenize(line);
    if (!argv.length) return;
    const [cmd, ...args] = argv;
    const key = cmd.toLowerCase();

    if (COMMANDS[key]) { await COMMANDS[key](args); return; }
    if (BANNED.includes(key)) { denyWrite(key); return; }
    if (/[<>]/.test(line)) {
      print('<span class="err">redirection is not permitted — this filesystem is read-only.</span>');
      return;
    }
    print(`<span class="err">command not found: ${esc(cmd)}</span> <span class="dim">— type \`help\` to see what works here.</span>`);
  }

  async function run(line) {
    echo(line);
    if (line.trim()) { history.push(line); }
    histIdx = history.length;
    await dispatch(line);
    scrollDown();
  }

  // ---------------------------------------------------------------- input loop
  // The visible <input> IS the command line — no mirrored text node, so the
  // IME owns its buffer and Backspace/composition behave natively.

  // --- Tab completion, bash-style -------------------------------------------
  // * first word      -> complete command names
  // * cat/read/...    -> complete page names
  // * tag             -> complete tag names
  // unique match      -> insert it + a trailing space
  // several matches   -> insert the longest common prefix and list them;
  //                      pressing Tab again cycles through the candidates.
  let comp = null; // { line, list, idx } — state for cycling; cleared on typing

  function commonPrefix(list) {
    let p = list[0];
    for (const s of list) {
      while (p && s.toLowerCase().indexOf(p.toLowerCase()) !== 0) p = p.slice(0, -1);
    }
    return p;
  }

  function completePool(cmdWord, isFirstWord) {
    if (isFirstWord) return Object.keys(COMMANDS).sort();
    if (/^(cat|read|open|show)$/i.test(cmdWord)) {
      return posts.map((p) => p.file.replace(/\.md$/i, '')).sort();
    }
    if (/^tag$/i.test(cmdWord)) return [...new Set(posts.flatMap((p) => p.tags))].sort();
    return null;
  }

  function tabComplete() {
    const v = cmdInput.value;
    const lsp = v.lastIndexOf(' ');
    const word = lsp === -1 ? v : v.slice(lsp + 1);   // word being completed
    const head = lsp === -1 ? '' : v.slice(0, lsp + 1); // everything before it (incl. space)
    const cmdWord = v.split(/\s+/)[0] || '';
    const isFirstWord = lsp === -1;

    const pool = completePool(cmdWord, isFirstWord);
    if (!pool) return;
    const matches = pool.filter((x) => x.toLowerCase().startsWith(word.toLowerCase()));
    if (!matches.length) return;

    const lineFor = (w) => head + w;

    if (matches.length === 1) {
      cmdInput.value = lineFor(matches[0]) + ' '; // unique: bash appends a space
      comp = null;
      return;
    }

    // repeated Tab on the same line -> cycle candidates
    if (comp && comp.line === v) {
      comp.idx = (comp.idx + 1) % matches.length;
      if (comp.idx === 0) { // wrapped around: show the options again, like bash
        print('<span class="dim">' + matches.map((h) => `<span class="cy">${esc(h)}</span>`).join('   ') + '</span>');
      }
      cmdInput.value = lineFor(matches[comp.idx]);
      comp.line = cmdInput.value;
      return;
    }

    // first Tab -> insert the longest common prefix, then list the options
    const p = commonPrefix(matches);
    cmdInput.value = lineFor(p.length > word.length ? p : word);
    comp = { line: cmdInput.value, list: matches, idx: -1 };
    print('<span class="dim">' + matches.map((h) => `<span class="cy">${esc(h)}</span>`).join('   ') + '</span>');
  }

  cmdInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // let the IME finish first (Android)
    if (e.key === 'Enter') {
      const line = cmdInput.value;
      cmdInput.value = '';
      run(line);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx > 0) { histIdx--; cmdInput.value = history[histIdx]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < history.length - 1) { histIdx++; cmdInput.value = history[histIdx]; }
      else { histIdx = history.length; cmdInput.value = ''; }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      tabComplete();
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      output.innerHTML = '';
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      echo(cmdInput.value + '^C');
      cmdInput.value = '';
    }
  });

  // keep the input focused so typing (and mobile keyboards) work,
  // without breaking text selection or letting focus scroll anything
  const focusInput = () => cmdInput.focus({ preventScroll: true });
  screen.addEventListener('mouseup', focusInput);
  document.addEventListener('click', focusInput);
  // any typing invalidates an in-progress completion/cycle
  cmdInput.addEventListener('input', () => { comp = null; });

  // Safety net: the document itself must never scroll. If the browser ever
  // scrolls the root element (e.g. to reveal a focused element), snap back.
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  // ---------------------------------------------------------------- boot
  function showBanner() {
    print('<span class="dim">A blog you read through a (fake) terminal. Markdown files in <span class="cy">./pages</span> become pages.</span>');
    print('');
    print('<span class="ok">Type</span> <span class="cy">help</span> <span class="dim">to get started,</span> <span class="cy">ls</span> <span class="dim">to list posts,</span> <span class="cy">cat welcome</span> <span class="dim">to read the first one.</span>');
    print('');
  }

  // restore theme
  const saved = localStorage.getItem('ttu-theme');
  if (saved && THEMES[saved]) {
    const t = THEMES[saved], r = document.documentElement.style;
    r.setProperty('--fg', t.fg); r.setProperty('--accent', t.accent);
    r.setProperty('--glow', t.glow); r.setProperty('--border', t.border);
  }

  showBanner();
  refreshPosts().then(() => {
    print(`<span class="dim">${posts.length} post(s) available. ${posts.length ? `Try: cat ${posts[0].file.replace(/\.md$/i, '')}` : ''}</span>`);
  });
  focusInput();
})();
