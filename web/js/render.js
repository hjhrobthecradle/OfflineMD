/* ============================================================
   render.js — Markdown 渲染管线
   markdown-it → 标题锚点 / 任务列表 / 脚注 / KaTeX / Mermaid / highlight.js
   全部在本地完成，无任何远程请求
   ============================================================ */
(function () {
  'use strict';

  const md = window.markdownit({
    html: true,
    xhtmlOut: false,
    breaks: false,
    langPrefix: 'language-',
    linkify: false,
    typographer: true,
    quotes: '“”‘’',
    highlight: function (str, lang) {
      if (lang === 'mermaid') return '';   // 交给图表管线
      if (lang && window.hljs && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch (e) { /* fallthrough */ }
      }
      return md.utils.escapeHtml(str);
    }
  });

  if (window.markdownitFootnote) md.use(window.markdownitFootnote);
  if (window.markdownitTaskLists) md.use(window.markdownitTaskLists, { enabled: true, label: true, labelAfter: true });
  if (window.MathPlugin) md.use(window.MathPlugin);

  // 支持 ++下划线++ 语法（标准下划线为 <u>...</u>，二者皆渲染为 <u>）
  md.inline.ruler.after('emphasis', 'ins', function (state, silent) {
    if (state.src.charCodeAt(state.pos) !== 0x2B /* + */ || state.src.charCodeAt(state.pos + 1) !== 0x2B) {
      return false;
    }
    const start = state.pos;
    const match = state.src.slice(start).match(/^\+\+([^\+\n]+)\+\+/);
    if (!match) return false;
    if (!silent) {
      state.push('u_open', 'u', 1);
      const tokenText = state.push('text', '', 0);
      tokenText.content = match[1];
      state.push('u_close', 'u', -1);
    }
    state.pos += match[0].length;
    return true;
  });

  const defaultFence = md.renderer.rules.fence;

  // mermaid 代码块 → 占位容器（内容藏在 hidden pre 里，供 hydrate 读取）
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
    if (info === 'mermaid') {
      return '<div class="mermaid-wrap" data-state="pending">' +
        '<pre class="mermaid-src" hidden>' + md.utils.escapeHtml(token.content) + '</pre>' +
        '<div class="mermaid-pending">Mermaid 图表渲染中…</div>' +
        '</div>';
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  // 标题锚点
  md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    const t = tokens[idx];
    const inline = tokens[idx + 1];
    const raw = inline && inline.type === 'inline' ? inline.content : '';
    const slug = uniqueSlug(env, raw);
    t.attrSet('id', slug);
    return self.renderToken(tokens, idx, options);
  };

  function slugBase(text) {
    return String(text)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`#>]/g, '')
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}\-_.]/gu, '')
      .toLowerCase()
      .slice(0, 64) || 'section';
  }

  function uniqueSlug(env, text) {
    if (!env.__slugs) env.__slugs = Object.create(null);
    const base = slugBase(text);
    let id = base, n = 1;
    while (env.__slugs[id]) { id = base + '-' + (++n); }
    env.__slugs[id] = 1;
    return id;
  }

  // ---------------- 路径处理 ----------------

  function normalize(p) {
    const abs = p.startsWith('/');
    const parts = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (parts.length) parts.pop(); continue; }
      parts.push(seg);
    }
    return (abs ? '/' : '') + parts.join('/');
  }

  function joinPath(dir, rel) {
    if (!dir) return rel;
    if (rel.startsWith('/')) return normalize(rel);
    return normalize(dir.replace(/\/+$/, '') + '/' + rel);
  }

  function localURL(absPath) {
    return 'offline-md://local' + encodeURI(absPath);
  }

  function resolveImgSrc(src, ctx) {
    if (!src) return src;
    if (/^(data:|blob:|offline-md:)/i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;      // http(s) 等保持原样（离线会被拦截）
    let p = src;
    try { p = decodeURI(src); } catch (e) { /* keep */ }
    const abs = joinPath(ctx.docDir, p);
    return localURL(abs);
  }

  // ---------------- Mermaid ----------------

  const mermaidCache = new Map();
  const mermaidQueue = [];
  let mermaidBusy = 0;
  let mermaidSeq = 0;
  let mermaidThemeKey = '';

  function mermaidConfig() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: '-apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif',
      themeVariables: {
        background: v('--bg'),
        primaryColor: v('--bg-panel'),
        primaryTextColor: v('--fg'),
        primaryBorderColor: v('--border-strong'),
        lineColor: v('--fg-muted'),
        secondaryColor: v('--bg-hover'),
        tertiaryColor: v('--bg'),
        mainBkg: v('--bg-panel'),
        nodeBorder: v('--border-strong'),
        clusterBkg: v('--bg-panel'),
        clusterBorder: v('--border'),
        titleColor: v('--fg'),
        edgeLabelBackground: v('--bg'),
        textColor: v('--fg'),
        fontSize: '14px'
      }
    };
  }

  function currentThemeKey() {
    return document.documentElement.dataset.theme || 'paper';
  }

  function ensureMermaid() {
    if (!window.mermaid) return false;
    const key = currentThemeKey();
    if (mermaidThemeKey === key) return true;
    try { window.mermaid.initialize(mermaidConfig()); } catch (e) { console.warn('mermaid init', e); }
    mermaidThemeKey = key;
    mermaidCache.clear();
    return true;
  }

  function enqueueMermaid(node) {
    mermaidQueue.push(node);
    pumpMermaid();
  }

  function pumpMermaid() {
    while (mermaidBusy < 2 && mermaidQueue.length) {
      const node = mermaidQueue.shift();
      if (!node.isConnected) continue;
      const src = (node.querySelector('.mermaid-src') || {}).textContent || '';
      const key = currentThemeKey() + '\u0000' + src;

      if (mermaidCache.has(key)) { paintMermaid(node, mermaidCache.get(key)); continue; }

      mermaidBusy++;
      const id = 'mmd-' + (++mermaidSeq);
      Promise.resolve()
        .then(() => window.mermaid.render(id, src))
        .then(res => {
          const svg = (res && res.svg) || '';
          mermaidCache.set(key, svg);
          paintMermaid(node, svg);
        })
        .catch(err => {
          const box = node.querySelector('.mermaid-pending');
          if (box) {
            box.className = 'mermaid-error';
            box.textContent = '图表语法错误：\n' + String(err && err.message || err);
          }
          node.dataset.state = 'error';
        })
        .finally(() => { mermaidBusy--; pumpMermaid(); });
    }
  }

  function paintMermaid(node, svg) {
    if (!node.isConnected) return;
    node.innerHTML = svg;
    node.dataset.state = 'done';
  }

  // ---------------- 渲染入口 ----------------

  function render(src) {
    const env = {};
    let html = '';
    try {
      html = md.render(src, env);
    } catch (e) {
      html = '<p class="math-error">渲染失败：' + md.utils.escapeHtml(String(e && e.message || e)) + '</p>';
    }

    // 大纲（直接从 token 流取，比 DOM 抓取更准）
    const headings = [];
    try {
      const tokens = md.parse(src, {});
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== 'heading_open') continue;
        const inline = tokens[i + 1];
        const text = inline && inline.type === 'inline' ? inline.content : '';
        headings.push({
          level: parseInt(tokens[i].tag.slice(1), 10),
          text: text.replace(/[*_~`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim() || '(空标题)',
          line: tokens[i].map ? tokens[i].map[0] : 0
        });
      }
    } catch (e) { /* ignore */ }

    // 标题 id 与 headings 顺序一致
    const ids = [];
    try {
      const probe = document.createElement('div');
      probe.innerHTML = html;
      probe.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => ids.push(h.id));
    } catch (e) { /* ignore */ }
    headings.forEach((h, i) => { h.id = ids[i] || ''; });

    return { html: html, headings: headings };
  }

  // ---------------- DOM 后处理 ----------------

  function hydrate(root, ctx) {
    // 1) 代码高亮
    root.querySelectorAll('pre > code').forEach(el => {
      if (el.dataset.hl === '1') return;
      if (el.parentElement.closest('.mermaid-wrap')) return;
      try { window.hljs && hljs.highlightElement(el); el.dataset.hl = '1'; } catch (e) { /* ignore */ }
    });

    // 2) 图片路径
    root.querySelectorAll('img').forEach(img => {
      const raw = img.getAttribute('src') || '';
      if (img.dataset.resolved === raw) return;
      img.dataset.resolved = raw;
      if (/^https?:/i.test(raw)) {
        img.classList.add('remote-img');
        img.title = '离线模式：远程图片不会加载';
        img.setAttribute('data-remote-src', raw);
        return;
      }
      const resolved = resolveImgSrc(raw, ctx);
      if (resolved !== raw) img.setAttribute('src', resolved);
    });

    // 3) 外链标注
    root.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) a.setAttribute('data-external', '1');
      else if (/\.(md|markdown|txt)$/i.test(href)) a.setAttribute('data-doclink', '1');
    });

    // 4) Mermaid
    if (ensureMermaid()) {
      root.querySelectorAll('.mermaid-wrap[data-state="pending"]').forEach(node => {
        if (node.dataset.queued === '1') return;
        node.dataset.queued = '1';
        enqueueMermaid(node);
      });
    } else {
      root.querySelectorAll('.mermaid-wrap[data-state="pending"]').forEach(node => {
        node.dataset.state = 'error';
        const box = node.querySelector('.mermaid-pending');
        if (box) { box.className = 'mermaid-error'; box.textContent = 'Mermaid 未加载'; }
      });
    }
  }

  // ---------------- 导出用 CSS ----------------

  function collectCSS() {
    let out = '';
    for (const sheet of Array.from(document.styleSheets)) {
      const href = sheet.href || '';
      if (!/content\.css|katex\.min\.css/.test(href)) continue;
      try {
        for (const rule of Array.from(sheet.cssRules)) out += rule.cssText + '\n';
      } catch (e) { /* 跨域样式表跳过 */ }
    }
    return out;
  }

  window.Renderer = {
    md: md,
    render: render,
    hydrate: hydrate,
    collectCSS: collectCSS,
    resolveImgSrc: resolveImgSrc,
    localURL: localURL,
    joinPath: joinPath,
    normalize: normalize,
    invalidateMermaid: function () { mermaidCache.clear(); mermaidThemeKey = ''; }
  };
})();
