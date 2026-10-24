/* ============================================================
   wysiwyg.js — 所见即所得编辑内核
   基于 ProseMirror（经 Milkdown 7）：文档模型 + 可编辑的渲染 DOM，
   Markdown 只作为存盘格式，不再作为编辑表面。
   打包：esbuild → web/vendor/wysiwyg.js（IIFE，全局 WysiwygKit）
   ============================================================ */
import {
  Editor, rootCtx, defaultValueCtx, editorViewCtx,
  serializerCtx, parserCtx, prosePluginsCtx, remarkStringifyOptionsCtx, commandsCtx
} from '@milkdown/core';
import {
  commonmark,
  toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, toggleLinkCommand,
  wrapInHeadingCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand,
  insertHrCommand, turnIntoTextCommand
} from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history, undoCommand, redoCommand } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { indent } from '@milkdown/plugin-indent';
import { math } from '@milkdown/plugin-math';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { toggleMark, lift } from '@milkdown/prose/commands';
import { liftListItem } from '@milkdown/prose/schema-list';
import { markRule } from '@milkdown/prose';
import { $markAttr, $markSchema, $command, $inputRule, $useKeymap, $remark } from '@milkdown/utils';

/* ---------------- Mermaid 实时渲染（带源码缓存） ---------------- */

const mmdCache = new Map();
let mmdBusy = 0;
const mmdQueue = [];

function mmdTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: '-apple-system, "PingFang SC", sans-serif',
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

let mmdThemeKey = '';
function ensureMmd() {
  if (!window.mermaid) return false;
  const key = document.documentElement.dataset.theme || 'paper';
  if (mmdThemeKey !== key) {
    try { window.mermaid.initialize(mmdTheme()); } catch (e) { /* ignore */ }
    mmdThemeKey = key;
    mmdCache.clear();
  }
  return true;
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

  function pumpMmd() {
    while (mmdBusy < 2 && mmdQueue.length) {
      const job = mmdQueue.shift();
      // 注意：PM 在创建挂件 DOM 的瞬间它还未插入文档，所以这里不能检查 isConnected。
      // 渲染完成后再检查（paint 内部处理），必要时静默丢弃。
      const key = mmdThemeKey + '\u0000' + job.code;
      if (mmdCache.has(key)) { paint(job.wrap, mmdCache.get(key)); continue; }

      mmdBusy++;
    const id = 'wm-' + hashStr(job.code) + '-' + Date.now().toString(36);
    dbg('render start ' + id);
    Promise.resolve()
      .then(() => window.mermaid.render(id, job.code))
      .then(res => {
        const svg = (res && res.svg) || '';
        dbg('render ok ' + svg.length);
        mmdCache.set(key, svg);
        paint(job.wrap, svg);
      })
      .catch(err => {
        dbg('render FAIL ' + String((err && err.message) || err).slice(0, 120));
        if (window.__errors) window.__errors.push('mermaid: ' + String((err && err.message) || err).slice(0, 160));
        if (job.wrap.isConnected) {
          job.wrap.innerHTML = '';
          const box = document.createElement('div');
          box.className = 'mmd-error';
          box.textContent = '图表语法错误：' + String((err && err.message) || err);
          job.wrap.appendChild(box);
        }
      })
      .finally(() => { mmdBusy--; pumpMmd(); });
  }
}

function dbg(msg) {
  if (window.__errors) window.__errors.push('mmd: ' + String(msg).slice(0, 200));
  console.log('[mmd] ' + msg);
}

function paint(wrap, svg) {
  if (!wrap.isConnected) { dbg('paint skipped (not connected)'); return; }
  wrap.innerHTML = svg;
  wrap.dataset.state = 'done';
}

function mermaidBox(code) {
  const wrap = document.createElement('div');
  wrap.className = 'mmd-live';
  wrap.setAttribute('contenteditable', 'false');
  if (!ensureMmd()) {
    wrap.innerHTML = '<div class="mmd-error">Mermaid 未加载</div>';
    return wrap;
  }
  dbg('box created len=' + code.length);
  const key = mmdThemeKey + '\u0000' + code;
  if (mmdCache.has(key)) {
    paint(wrap, mmdCache.get(key));
  } else {
    wrap.innerHTML = '<div class="mmd-loading">图表渲染中…</div>';
    mmdQueue.push({ code: code, wrap: wrap });
    pumpMmd();
  }
  return wrap;
}

// 任务列表勾选框（decoration widget，不进入文档模型）
function taskCheckbox(checked, pos, state) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'task-checkbox';
  cb.checked = !!checked;
  cb.setAttribute('contenteditable', 'false');
  cb.addEventListener('change', () => {
    const wiz = taskCheckbox.getWiz && taskCheckbox.getWiz();
    if (!wiz) return;
    wiz.run(null) || wiz.setChecked(pos, cb.checked);
  });
  return cb;
}
taskCheckbox.getWiz = null;

/* ---------------- 图片路径 ---------------- */

function localURL(abs) { return 'offline-md://local' + encodeURI(abs); }
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

/* ---------------- 下划线（<u>...</u> / <ins>...</ins> / ++...++） ---------------- */

const underlineAttr = $markAttr('underline');

const underlineSchema = $markSchema('underline', ctx => ({
  parseDOM: [
    { tag: 'u' },
    { tag: 'ins' },
    {
      style: 'text-decoration',
      getAttrs: value => (value && String(value).includes('underline')) ? null : false
    }
  ],
  toDOM: mark => ['u', ctx.get(underlineAttr.key)(mark)],
  parseMarkdown: {
    match: node => node.type === 'underline',
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    }
  },
  toMarkdown: {
    match: mark => mark.type.name === 'underline',
    runner: (state, mark) => {
      state.withMark(mark, 'underline');
    }
  }
}));

const toggleUnderlineCommand = $command('ToggleUnderline', ctx => () => {
  return toggleMark(underlineSchema.type(ctx));
});

const underlineInputRule = $inputRule(ctx => {
  return markRule(
    /(?:<u>|<ins>|\+\+)(.+?)(?:<\/u>|<\/ins>|\+\+)$/,
    underlineSchema.type(ctx)
  );
});

const underlineKeymap = $useKeymap('underlineKeymap', {
  ToggleUnderline: {
    shortcuts: ['Mod-u', 'Mod-U'],
    command: ctx => {
      const commands = ctx.get(commandsCtx);
      return () => commands.call(toggleUnderlineCommand.key);
    }
  }
});

function remarkUnderline() {
  function walk(node) {
    if (!node || !Array.isArray(node.children)) return;
    for (const c of node.children) walk(c);

    // 1. 文本节点里的 ++text++ 拆成 underline 节点
    const splitChildren = [];
    for (const child of node.children) {
      if (child.type === 'text' && /\+\+[^\+\n]+\+\+/.test(child.value)) {
        const parts = child.value.split(/(\+\+[^\+\n]+\+\+)/);
        for (const p of parts) {
          if (!p) continue;
          if (p.startsWith('++') && p.endsWith('++')) {
            splitChildren.push({
              type: 'underline',
              children: [{ type: 'text', value: p.slice(2, -2) }]
            });
          } else {
            splitChildren.push({ type: 'text', value: p });
          }
        }
      } else {
        splitChildren.push(child);
      }
    }

    // 2. 将 <u>...</u> / <ins>...</ins> 配对成 underline 节点
    const nextChildren = [];
    let inU = false;
    let uChildren = [];

    for (let i = 0; i < splitChildren.length; i++) {
      const child = splitChildren[i];
      if (child.type === 'html' && /^<\s*(?:u|ins)\b[^>]*>/i.test(child.value)) {
        inU = true;
        uChildren = [];
      } else if (child.type === 'html' && /^<\/\s*(?:u|ins)\s*>/i.test(child.value)) {
        if (inU) {
          nextChildren.push({ type: 'underline', children: uChildren });
          inU = false;
          uChildren = [];
        } else {
          nextChildren.push(child);
        }
      } else if (inU) {
        uChildren.push(child);
      } else {
        nextChildren.push(child);
      }
    }
    if (inU) {
      nextChildren.push({ type: 'html', value: '<u>' }, ...uChildren);
    }
    node.children = nextChildren;
  }

  // @ts-ignore
  const self = this;
  const data = self && typeof self.data === 'function' ? self.data() : {};
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  toMarkdownExtensions.push({
    handlers: {
      underline(node, _, state, info) {
        const tracker = state.createTracker(info);
        const exit = state.enter('underline');
        let value = tracker.move('<u>');
        value += state.containerPhrasing(node, {
          ...tracker.current(),
          before: value,
          after: '</u>'
        });
        value += tracker.move('</u>');
        exit();
        return value;
      }
    }
  });

  return tree => {
    walk(tree);
  };
}

const remarkUnderlinePlugin = $remark('remarkUnderline', () => remarkUnderline);

/* ---------------- 编辑器 ---------------- */

class WysiwygEditor {
  constructor() {
    this.editor = null;
    this.root = null;
    this.md = '';
    this.suppress = false;
    this.docDir = null;
    this.opts = {};
    this.onChange = null;
    this.onSelection = null;
  }

  async mount(root, markdown, opts) {
    this.root = root;
    this.opts = opts || {};
    this.onChange = this.opts.onChange || null;
    this.onSelection = this.opts.onSelection || null;
    this.docDir = this.opts.docDir || null;

    const self = this;
    taskCheckbox.getWiz = () => self;

    this.editor = await Editor.make()
      .config(ctx => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown || '');
        try {
          ctx.update(remarkStringifyOptionsCtx, o => Object.assign({}, o, {
            bullet: '-', emphasis: '*', strong: '*', fence: '`', listItemIndent: 'one'
          }));
        } catch (e) { /* ignore */ }

        const l = ctx.get(listenerCtx);
        l.markdownUpdated((_ctx, md, prev) => {
          if (md === prev) return;
          self.md = md;
          if (self.suppress) return;
          if (self.onChange) self.onChange(md);
        });
        l.updated(() => {
          self.fixImages();
          self.fixTaskLists();
        });
        l.selectionUpdated(() => {
          if (self.onSelection) self.onSelection(self.getStats());
        });

        try {
          ctx.update(prosePluginsCtx, plugins => plugins.concat([self.mermaidPlugin()]));
        } catch (e) {
          console.warn('[wysiwyg] mermaid plugin 注册失败', e);
        }
      })
      .use(commonmark)
      .use(gfm)
      .use(math)
      .use(history)
      .use(clipboard)
      .use(cursor)
      .use(indent)
      .use(listener)
      .use(underlineAttr)
      .use(underlineSchema)
      .use(toggleUnderlineCommand)
      .use(underlineInputRule)
      .use(underlineKeymap)
      .use(remarkUnderlinePlugin)
      .create();

    this.md = markdown || '';
    this.bindInput();
    this.fixImages();
    try {
      this.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        const names = Object.keys(view.state.schema.nodes).filter(n => /list|task/i.test(n));
        dbg('node types: ' + names.join(','));
        const li = view.state.schema.nodes.list_item;
        if (li) dbg('list_item attrs: ' + Object.keys(li.spec.attrs || {}).join(','));
        let seen = new Set();
        view.state.doc.descendants(n => seen.add(n.type.name));
        dbg('doc node names: ' + Array.from(seen).join(','));
      });
    } catch (e) { dbg('schema dump failed ' + e); }
    return this;
  }

  // 代码块里的 mermaid：在块尾挂一个只读预览挂件（不进入文档模型，不破坏 Markdown）
  // 任务列表：Milkdown 默认不渲染 <input>，这里用 node view 补上可点击的勾选框
  mermaidPlugin() {
    const self = this;
    return new Plugin({
      key: new PluginKey('offline-md-mermaid'),
      props: {
        decorations(state) {
          const decos = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'list_item' && node.attrs.checked != null) {
              const done = !!node.attrs.checked;
              decos.push(Decoration.node(pos, pos + node.nodeSize, {
                class: 'task-item',
                'data-checked': String(done)
              }));
              decos.push(Decoration.widget(
                pos + 1,
                () => taskCheckbox(done, pos, state),
                { side: -1, key: 'task-cb-' + pos + '-' + done }
              ));
              return;
            }
            if (node.type.name !== 'code_block') return;
            const lang = String(node.attrs.language || '').toLowerCase();
            if (lang !== 'mermaid') return;
            const code = node.textContent;
            if (!code.trim()) return;
            // 注意：挂件必须放在节点之后（pos + nodeSize），
            // 放进节点内部会插进 <pre> 里，破坏代码块的 DOM 结构
            decos.push(Decoration.widget(
              pos + node.nodeSize,
              () => mermaidBox(code),
              { side: 1, key: 'mmd-' + hashStr(code) }
            ));
          });
          return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
        },
        nodeViews: {} // 保留字段：Milkdown 自带 view 会覆盖插件 props，这里留空由 decoration 承担
      }
    });
  }

  // 相对路径图片 → 自定义 scheme（只改 DOM，不改文档，存盘仍是相对路径）
  fixImages() {
    if (!this.root) return;
    this.root.querySelectorAll('img').forEach(img => {
      const raw = img.getAttribute('src') || '';
      if (!raw || img.dataset.fixed === raw) return;
      if (/^(data:|blob:|offline-md:|https?:)/i.test(raw)) {
        img.dataset.fixed = raw;
        if (/^https?:/i.test(raw)) img.classList.add('remote-img');
        return;
      }
      const abs = joinPath(this.docDir, raw);
      img.dataset.fixed = raw;
      img.setAttribute('src', localURL(abs));
    });
  }

  fixTaskLists() {
    if (!this.root) return;
    this.root.querySelectorAll('li').forEach(li => {
      const cb = li.querySelector(':scope > input[type="checkbox"]');
      if (!cb) return;
      li.classList.add('task-list-item');
      li.classList.toggle('is-checked', cb.checked);
    });
  }

  // 粘贴 / 拖入图片
  bindInput() {
    const self = this;
    const root = this.root;

    root.addEventListener('paste', e => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const imgs = items.filter(i => i.kind === 'file' && /^image\//.test(i.type));
      if (!imgs.length) return;
      e.preventDefault();
      e.stopPropagation();
      const files = imgs.map(i => i.getAsFile()).filter(Boolean);
      if (self.opts.onImageFiles) self.opts.onImageFiles(files);
    }, true);

    root.addEventListener('drop', e => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const imgs = files.filter(f => /^image\//.test(f.type));
      if (!imgs.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (self.opts.onImageFiles) self.opts.onImageFiles(imgs);
    }, true);

    // ⌘+点击打开链接
    root.addEventListener('mousedown', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (self.opts.onLinkClick) self.opts.onLinkClick(a.getAttribute('href'));
    }, true);

    // 主题切换后重画图表
    root.__refreshMermaid = () => {
      if (ensureMmd()) { /* 缓存已在 ensureMmd 中清空 */ }
      this.refreshDecorations();
    };
  }

  refreshDecorations() {
    if (!this.editor) return;
    this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta('addToHistory', false).setMeta('offline-md-refresh', true));
    });
  }

  /* ---------- 文档读写 ---------- */

  getMarkdown() {
    if (!this.editor) return this.md;
    try {
      return this.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        const serializer = ctx.get(serializerCtx);
        return serializer(view.state.doc);
      });
    } catch (e) {
      console.warn('[wysiwyg] serialize failed', e);
      return this.md;
    }
  }

  setMarkdown(md) {
    if (!this.editor) { this.md = md || ''; return; }
    this.suppress = true;
    try {
      this.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const doc = parser(md || '');
        if (!doc) return;
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
        tr.setMeta('addToHistory', false);
        view.dispatch(tr);
      });
    } catch (e) {
      console.warn('[wysiwyg] parse failed', e);
    }
    this.suppress = false;
    this.md = md || '';
    this.fixImages();
  }

  setDocDir(dir) {
    this.docDir = dir;
    this.fixImages();
  }

  focus() {
    if (!this.editor) return;
    this.editor.action(ctx => ctx.get(editorViewCtx).focus());
  }

  /* ---------- 统计 / 大纲 ---------- */

  getStats() {
    if (!this.editor) return { words: 0, chars: 0, blocks: 0, paragraphs: 0 };
    return this.editor.action(ctx => {
      const doc = ctx.get(editorViewCtx).state.doc;
      const text = doc.textContent || '';
      const cjk = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
      const latin = (text.replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ')
        .match(/[A-Za-z0-9_@#$%&'’\-]+/g) || []).length;
      let blocks = 0;
      doc.descendants(n => { if (n.isBlock && n.isTextblock) blocks++; });
      return { words: cjk + latin, chars: text.length, blocks: blocks, paragraphs: blocks };
    });
  }

  getOutline() {
    if (!this.editor) return [];
    return this.editor.action(ctx => {
      const out = [];
      const doc = ctx.get(editorViewCtx).state.doc;
      doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          out.push({
            level: node.attrs.level,
            text: node.textContent || '(空标题)',
            pos: pos
          });
        }
      });
      return out;
    });
  }

  gotoPos(pos) {
    if (!this.editor) return;
    this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const max = view.state.doc.content.size;
      const p = Math.min(Math.max(1, pos + 1), Math.max(1, max - 1));
      const sel = TextSelection.near(view.state.doc.resolve(p));
      view.dispatch(view.state.tr.setSelection(sel));
      view.focus();

      // 定位目标 DOM 元素，并平滑滚动到编辑区顶部
      let targetEl = null;
      try {
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
          targetEl = dom;
        } else {
          const domAt = view.domAtPos(p);
          if (domAt && domAt.node) {
            const el = domAt.node instanceof HTMLElement ? domAt.node : domAt.node.parentElement;
            targetEl = (el && el.closest) ? (el.closest('h1, h2, h3, h4, h5, h6') || el) : el;
          }
        }
      } catch (e) {
        // ignore
      }

      const wrap = document.getElementById('wysiwyg-wrap');
      if (wrap) {
        if (targetEl && targetEl.getBoundingClientRect) {
          const wrapRect = wrap.getBoundingClientRect();
          const elRect = targetEl.getBoundingClientRect();
          let targetScrollTop = wrap.scrollTop + (elRect.top - wrapRect.top) - 18;
          if (pos === 0 || targetScrollTop < 80) targetScrollTop = 0;
          wrap.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
        } else {
          try {
            const coords = view.coordsAtPos(p);
            if (coords) {
              const wrapRect = wrap.getBoundingClientRect();
              let targetScrollTop = wrap.scrollTop + (coords.top - wrapRect.top) - 18;
              if (pos === 0 || targetScrollTop < 80) targetScrollTop = 0;
              wrap.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
            }
          } catch (e) {
            view.dispatch(view.state.tr.scrollIntoView());
          }
        }
      }
    });
  }

  /* ---------- 格式化 ---------- */

  run(cmd, payload) {
    if (!this.editor || !cmd) return false;
    return this.editor.action(ctx => {
      try {
        if (cmd.key) {
          return !!ctx.get(commandsCtx).call(cmd.key, payload);
        }
        if (typeof cmd.run === 'function') {
          return !!cmd.run(payload);
        }
        const view = ctx.get(editorViewCtx);
        return !!cmd(payload)(view.state, view.dispatch, view);
      } catch (e) {
        console.warn('[wysiwyg] command failed', e);
        return false;
      }
    });
  }

  undo() {
    return this.run(undoCommand);
  }

  redo() {
    return this.run(redoCommand);
  }

  format(kind) {
    switch (kind) {
      case 'bold': return this.toggleMarkByName('strong');
      case 'italic': return this.toggleMarkByName('emphasis');
      case 'code': return this.toggleMarkByName('inlineCode');
      case 'strike': return this.toggleMarkByName('strike_through');
      case 'underline': return this.toggleMarkByName('underline');
      case 'link': return this.toggleLink();
      case 'h1': return this.toggleHeading(1);
      case 'h2': return this.toggleHeading(2);
      case 'h3': return this.toggleHeading(3);
      case 'h4': return this.toggleHeading(4);
      case 'paragraph': return this.run(turnIntoTextCommand);
      case 'quote': return this.toggleQuote();
      case 'ul': return this.toggleList('bullet_list');
      case 'ol': return this.toggleList('ordered_list');
      case 'hr': return this.run(insertHrCommand);
      case 'tasklist': return this.turnTaskList();
      case 'table': return this.insertTable();
      case 'codeblock': return this.insertCodeBlock('');
      case 'math': return this.insertMathBlock();
      case 'mermaid': return this.insertCodeBlock('mermaid');
      default: return false;
    }
  }

  findMarkSpan($pos, markType) {
    const parent = $pos.parent;
    const base = $pos.start();
    const target = $pos.parentOffset;
    let spanStart = -1;
    let spanEnd = -1;
    let found = null;
    parent.forEach((child, offset) => {
      if (found) return;
      const end = offset + child.nodeSize;
      if (child.isText && markType.isInSet(child.marks)) {
        if (spanStart < 0) spanStart = offset;
        spanEnd = end;
      } else {
        if (spanStart >= 0 && target >= spanStart && target <= spanEnd) {
          found = { from: base + spanStart, to: base + spanEnd };
          return;
        }
        spanStart = -1;
        spanEnd = -1;
      }
    });
    if (!found && spanStart >= 0 && target >= spanStart && target <= spanEnd) {
      found = { from: base + spanStart, to: base + spanEnd };
    }
    return found;
  }

  toggleMarkByName(markName) {
    if (!this.editor) return false;
    const placeholders = {
      strong: '粗体',
      emphasis: '斜体',
      underline: '下划线',
      strike_through: '删除线',
      inlineCode: '代码'
    };
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const mark = state.schema.marks[markName];
      if (!mark) return false;
      const { from, to, empty, $from } = state.selection;
      if (empty) {
        const stored = state.storedMarks || $from.marks();
        const inSet = !!mark.isInSet(stored);
        const span = $from.parent.isTextblock ? this.findMarkSpan($from, mark) : null;
        if (span) {
          if (from < span.to || !inSet) {
            view.dispatch(state.tr.removeMark(span.from, span.to, mark));
            view.focus();
            return true;
          }
          view.dispatch(state.tr.removeStoredMark(mark));
          view.focus();
          return true;
        }
        if (inSet) {
          view.dispatch(state.tr.removeStoredMark(mark));
          view.focus();
          return true;
        }
        const label = placeholders[markName] || '文本';
        const baseMarks = (state.storedMarks || $from.marks()).filter(m => {
          if (markName === 'inlineCode') return false;
          return m.type.name !== 'inlineCode';
        });
        const textNode = state.schema.text(label, baseMarks.concat([mark.create()]));
        const tr = state.tr.replaceSelectionWith(textNode, false);
        const sel = TextSelection.create(tr.doc, from, from + label.length);
        view.dispatch(tr.setSelection(sel).scrollIntoView());
        view.focus();
        return true;
      }
      const has = state.doc.rangeHasMark(from, to, mark);
      if (has) {
        view.dispatch(state.tr.removeMark(from, to, mark));
      } else {
        const tr = state.tr;
        if (markName === 'inlineCode') {
          Object.keys(state.schema.marks).forEach(k => {
            if (k !== 'inlineCode') tr.removeMark(from, to, state.schema.marks[k]);
          });
        } else if (state.schema.marks.inlineCode) {
          tr.removeMark(from, to, state.schema.marks.inlineCode);
        }
        view.dispatch(tr.addMark(from, to, mark.create()));
      }
      view.focus();
      return true;
    });
  }

  toggleStrike() {
    return this.toggleMarkByName('strike_through');
  }

  toggleUnderline() {
    return this.toggleMarkByName('underline');
  }

  toggleLink() {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const mark = state.schema.marks.link;
      if (!mark) return false;
      const { from, to, empty, $from } = state.selection;
      if (empty) {
        const span = this.findMarkSpan($from, mark);
        if (span) {
          view.dispatch(state.tr.removeMark(span.from, span.to, mark));
          view.focus();
          return true;
        }
        const label = '链接文字';
        const linkNode = state.schema.text(label, [mark.create({ href: 'https://' })]);
        const tr = state.tr.replaceSelectionWith(linkNode, false);
        const sel = TextSelection.create(tr.doc, from, from + label.length);
        view.dispatch(tr.setSelection(sel).scrollIntoView());
        view.focus();
        return true;
      }
      const has = state.doc.rangeHasMark(from, to, mark);
      if (has) {
        view.dispatch(state.tr.removeMark(from, to, mark));
      } else {
        view.dispatch(state.tr.addMark(from, to, mark.create({ href: 'https://' })));
      }
      view.focus();
      return true;
    });
  }

  toggleHeading(level) {
    if (!this.editor) return false;
    const isSame = this.editor.action(ctx => {
      const { state } = ctx.get(editorViewCtx);
      const parent = state.selection.$from.parent;
      return parent.type.name === 'heading' && parent.attrs.level === level;
    });
    const ok = isSame ? this.run(turnIntoTextCommand) : this.run(wrapInHeadingCommand, level);
    this.focus();
    return ok;
  }

  toggleQuote() {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const $from = state.selection.$from;
      let inQuote = false;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'blockquote') {
          inQuote = true;
          break;
        }
      }
      if (inQuote) {
        const ok = lift(state, view.dispatch);
        view.focus();
        return ok;
      }
      const ok = !!ctx.get(commandsCtx).call(wrapInBlockquoteCommand.key);
      view.focus();
      return ok;
    });
  }

  toggleList(listType) {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const $from = state.selection.$from;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'list_item') {
          const parentList = d > 1 ? $from.node(d - 1) : null;
          if (listType === 'bullet_list' && node.attrs.checked != null) {
            view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, Object.assign({}, node.attrs, { checked: null })));
            view.focus();
            return true;
          }
          if (parentList && parentList.type.name === listType) {
            const liType = state.schema.nodes.list_item;
            const ok = liType ? liftListItem(liType)(state, view.dispatch) : false;
            view.focus();
            return ok;
          }
          break;
        }
      }
      const cmd = listType === 'ordered_list' ? wrapInOrderedListCommand : wrapInBulletListCommand;
      const ok = !!ctx.get(commandsCtx).call(cmd.key);
      view.focus();
      return ok;
    });
  }

  insertTable() {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const tableType = state.schema.nodes.table;
      const rowType = state.schema.nodes.table_row;
      const cellType = state.schema.nodes.table_cell || state.schema.nodes.table_header;
      if (!tableType || !rowType || !cellType) return false;
      const cell = () => cellType.createAndFill();
      const row = () => rowType.create(null, [cell(), cell(), cell()]);
      const node = tableType.create(null, [row(), row(), row()]);
      view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
      view.focus();
      return true;
    });
  }

  // 当前块转成任务列表项（gfm 的任务列表通过输入规则创建，这里补上命令版）
  turnTaskList() {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const $from = state.selection.$from;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'list_item') {
          if (node.attrs.checked != null) {
            view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, Object.assign({}, node.attrs, { checked: null })));
            const liType = view.state.schema.nodes.list_item;
            if (liType) liftListItem(liType)(view.state, view.dispatch);
            view.focus();
            return true;
          } else {
            view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, Object.assign({}, node.attrs, { checked: false })));
            view.focus();
            return true;
          }
        }
      }
      const wrapped = !!ctx.get(commandsCtx).call(wrapInBulletListCommand.key);
      if (wrapped) {
        const nextState = view.state;
        const $nextFrom = nextState.selection.$from;
        for (let d = $nextFrom.depth; d > 0; d--) {
          const node = $nextFrom.node(d);
          if (node.type.name === 'list_item') {
            view.dispatch(nextState.tr.setNodeMarkup($nextFrom.before(d), undefined, Object.assign({}, node.attrs, { checked: false })));
            break;
          }
        }
      }
      view.focus();
      return wrapped;
    });
  }

  setChecked(pos, checked) {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'list_item') return false;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { checked: checked }));
      return true;
    });
  }

  insertMathBlock() {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const type = state.schema.nodes.math_block;
      if (!type) return this.insertCodeBlock('math');
      const node = type.create({ value: '' });
      view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
      return true;
    });
  }

  insertCodeBlock(lang) {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const type = state.schema.nodes.code_block;
      if (!type) return false;
      const node = type.create({ language: lang || '' }, lang === 'mermaid' ? state.schema.text('flowchart LR\n    A --> B') : null);
      const tr = state.tr.replaceSelectionWith(node);
      view.dispatch(tr.scrollIntoView());
      const pos = tr.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
      return true;
    });
  }

  insertImage(attrs) {
    if (!this.editor) return false;
    return this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const type = view.state.schema.nodes.image;
      if (!type) return false;
      const node = type.create({ src: attrs.src, alt: attrs.alt || '', title: attrs.title || null });
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
      return true;
    });
  }

  /* ---------- 查找替换 ---------- */

  buildIndex() {
    return this.editor.action(ctx => {
      const doc = ctx.get(editorViewCtx).state.doc;
      let text = '';
      const pos = [];
      doc.descendants((node, p) => {
        if (node.isText) {
          const t = node.text || '';
          for (let i = 0; i < t.length; i++) { text += t[i]; pos.push(p + i); }
        } else if (node.isBlock && text.length && text[text.length - 1] !== '\n') {
          text += '\n';
          pos.push(p);
        }
      });
      return { text: text, pos: pos };
    });
  }

  find(query, caseSensitive) {
    if (!this.editor || !query) return [];
    const idx = this.buildIndex();
    const hay = caseSensitive ? idx.text : idx.text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const out = [];
    let at = hay.indexOf(needle);
    while (at !== -1 && out.length < 3000) {
      const endChar = at + needle.length - 1;
      const from = idx.pos[at];
      const to = idx.pos[endChar] + 1;
      if (from != null && to != null && to > from) out.push({ from: from, to: to });
      at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
    return out;
  }

  selectRange(from, to) {
    if (!this.editor) return;
    this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const sel = TextSelection.create(view.state.doc, from, to);
      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
      view.focus();
    });
  }

  replaceRange(from, to, text) {
    if (!this.editor) return;
    this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(text, from, to));
    });
  }

  destroy() {
    if (this.editor) {
      try { this.editor.destroy(); } catch (e) { /* ignore */ }
      this.editor = null;
    }
    this.root = null;
  }
}

window.WysiwygKit = {
  create: () => new WysiwygEditor(),
  invalidateMermaid: () => { mmdCache.clear(); mmdThemeKey = ''; }
};
