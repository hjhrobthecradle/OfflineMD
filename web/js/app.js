/* ============================================================
   app.js — 编辑器主控
   ============================================================ */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);

  const el = {
    app: $('#app'),
    main: $('#main'),
    sidebar: $('#sidebar'),
    editorWrap: $('#editor-wrap'),
    previewWrap: $('#preview-wrap'),
    wysiwygWrap: $('#wysiwyg-wrap'),
    wysiwyg: $('#wysiwyg'),
    preview: $('#preview'),
    splitter: $('#splitter'),
    docTitle: $('#doc-title'),
    dirtyDot: $('#dirty-dot'),
    sbPath: $('#sb-path'),
    sbWords: $('#sb-words'),
    sbChars: $('#sb-chars'),
    sbLines: $('#sb-lines'),
    sbCursor: $('#sb-cursor'),
    outline: $('#outline-list'),
    tree: $('#tree-list'),
    findbar: $('#findbar'),
    findInput: $('#find-input'),
    findCount: $('#find-count'),
    replaceInput: $('#replace-input'),
    restorebar: $('#restorebar'),
    restoreText: $('#restore-text'),
    modal: $('#modal'),
    modalTitle: $('#modal-title'),
    modalBody: $('#modal-body'),
    toast: $('#toast')
  };

  const THEMES = ['paper', 'graphite', 'night', 'moss'];
  const THEME_LABEL = { paper: '纸白', graphite: '石墨', night: '夜阑', moss: '松墨' };
  const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;

  const S = {
    prefs: {
      theme: 'paper', view: 'wysiwyg', sidebar: true, tab: 'outline',
      focus: false, typewriter: false, splitRatio: 0.5
    },
    filePath: null,
    fileName: '未命名',
    dirty: false,
    snapKey: 'untitled-' + Math.random().toString(36).slice(2, 10),
    docDir: null,
    folderRoot: null,
    tree: null,
    headings: [],
    suppress: false,
    renderTimer: 0,
    snapTimer: 0,
    lastSnapContent: null,
    find: { matches: [], index: -1, marks: [], caseSensitive: false },
    scrollLock: false,
    outlineTimer: 0,
    booted: false
  };

  let cm = null;
  let wiz = null;          // 所见即所得编辑器实例（懒加载，失败时降级到分栏）

  /* ------------------------------------------------------------
     工具
     ------------------------------------------------------------ */

  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.classList.remove('show');
      setTimeout(() => { el.toast.hidden = true; }, 200);
    }, ms || 2200);
  }

  function basename(p) { return (p || '').split('/').filter(Boolean).pop() || ''; }
  function dirname(p) { const parts = (p || '').split('/'); parts.pop(); return parts.join('/') || '/'; }

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return (sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function countWords(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const latin = (text.replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ')
      .match(/[A-Za-z0-9_@#$%&'’\-]+/g) || []).length;
    return cjk + latin;
  }

  /* ------------------------------------------------------------
     偏好与外观
     ------------------------------------------------------------ */

  function savePrefs() {
    if (!window.native || !native.available) return;
    native.invoke('prefs.set', { value: S.prefs }).catch(() => {});
  }

  function applyTheme(name, opts) {
    if (!THEMES.includes(name)) name = 'paper';
    S.prefs.theme = name;
    document.documentElement.dataset.theme = name;
    if (window.Renderer) Renderer.invalidateMermaid();
    if (window.WysiwygKit) WysiwygKit.invalidateMermaid();
    if (wiz) wiz.refreshDecorations();
    if (cm) cm.refresh();
    if (!opts || !opts.silent) {
      renderNow();
      if (!opts || !opts.noPersist) savePrefs();
      if (opts && opts.announce) toast('主题：' + THEME_LABEL[name]);
    }
  }

  function cycleTheme() {
    const i = THEMES.indexOf(S.prefs.theme);
    applyTheme(THEMES[(i + 1) % THEMES.length], { announce: true });
  }

  function applyView(mode) {
    if (!['wysiwyg', 'source', 'split', 'preview'].includes(mode)) mode = 'wysiwyg';
    if (mode === 'wysiwyg' && !wiz) mode = 'split';   // 内核不可用时降级
    const prev = S.prefs.view;
    S.prefs.view = mode;
    syncSurfaces(prev, mode);
    el.app.classList.remove('view-wysiwyg', 'view-editor', 'view-split', 'view-preview');
    el.app.classList.add(mode === 'source' ? 'view-editor' : 'view-' + mode);
    el.main.style.gridTemplateColumns = '';
    if (mode === 'split') applySplitRatio();
    document.querySelectorAll('#view-seg button').forEach(b => {
      b.classList.toggle('active', b.dataset.view === mode);
    });
    requestAnimationFrame(() => {
      if (mode === 'wysiwyg') { if (wiz) wiz.focus(); }
      else if (cm) { cm.refresh(); cm.focus(); }
    });
    if (mode === 'split' || mode === 'preview') renderNow();
    else { buildOutline(); updateStats(); }
    savePrefs();
  }

  // 两种编辑表面之间同步内容（Markdown 是唯一真相）
  function syncSurfaces(from, to) {
    if (!wiz || from === to) return;
    if (from === 'wysiwyg' && to !== 'wysiwyg') {
      S.suppress = true;
      cm.setValue(wiz.getMarkdown());
      cm.clearHistory();
      S.suppress = false;
    } else if (from !== 'wysiwyg' && to === 'wysiwyg') {
      wiz.setDocDir(S.docDir);
      wiz.setMarkdown(cm.getValue());
    }
  }

  function getMD() {
    if (S.prefs.view === 'wysiwyg' && wiz) return wiz.getMarkdown();
    return cm.getValue();
  }

  function applySplitRatio() {
    const r = Math.min(0.82, Math.max(0.18, S.prefs.splitRatio || 0.5));
    const side = el.app.classList.contains('no-sidebar') ? 0 : (S.prefs.sidebar ? 232 : 0);
    el.main.style.gridTemplateColumns = `${side}px ${r}fr 0px ${1 - r}fr`;
  }

  function toggleSidebar(force) {
    const on = typeof force === 'boolean' ? force : el.app.classList.contains('no-sidebar');
    el.app.classList.toggle('no-sidebar', !on);
    S.prefs.sidebar = on;
    applySplitRatio();
    savePrefs();
    requestAnimationFrame(() => cm && cm.refresh());
  }

  function toggleFocus() {
    S.prefs.focus = !S.prefs.focus;
    el.app.classList.toggle('focus-mode', S.prefs.focus);
    if (S.prefs.focus) toggleSidebar(false);
    savePrefs();
    toast(S.prefs.focus ? '专注模式：开' : '专注模式：关');
    requestAnimationFrame(() => cm && cm.refresh());
  }

  function toggleTypewriter() {
    S.prefs.typewriter = !S.prefs.typewriter;
    savePrefs();
    toast(S.prefs.typewriter ? '打字机模式：开' : '打字机模式：关');
    if (S.prefs.typewriter) centerCursor();
  }

  function centerCursor() {
    if (!cm || !S.prefs.typewriter) return;
    const pos = cm.getCursor();
    const coords = cm.cursorCoords(pos, 'local');
    const info = cm.getScrollInfo();
    const target = info.top + coords.top - info.clientHeight / 2 + 10;
    cm.scrollTo(null, target);
  }

  /* ------------------------------------------------------------
     文档状态
     ------------------------------------------------------------ */

  function setDirty(v) {
    if (S.dirty === v) return;
    S.dirty = v;
    el.dirtyDot.hidden = !v;
    if (window.native && native.available) {
      native.invoke('win.title', { title: S.fileName, dirty: v }).catch(() => {});
    }
  }

  function updateChrome() {
    el.docTitle.textContent = S.fileName;
    el.docTitle.title = S.filePath || '未保存的文档';
    el.sbPath.textContent = S.filePath || '未保存的文档';
    if (window.native && native.available) {
      native.invoke('win.title', { title: S.fileName, dirty: S.dirty }).catch(() => {});
    }
  }

  function setContent(text, opts) {
    S.suppress = true;
    cm.setValue(text);
    cm.clearHistory();
    cm.setCursor({ line: 0, ch: 0 });
    S.suppress = false;
    if (wiz) wiz.setMarkdown(text);
    setDirty(false);
    S.lastSnapContent = text;
    renderNow();
    updateStats();
    if (opts && opts.focus) {
      if (S.prefs.view === 'wysiwyg' && wiz) wiz.focus();
      else cm.focus();
    }
  }

  function loadDocument(doc, opts) {
    S.filePath = doc.path || null;
    S.fileName = doc.path ? basename(doc.path) : (doc.name || '未命名');
    S.docDir = doc.path ? dirname(doc.path) : null;
    S.snapKey = doc.path || S.snapKey;
    if (wiz) wiz.setDocDir(S.docDir);
    setContent(doc.content || '');
    updateChrome();
    if (doc.path) {
      if (window.native && native.available) native.invoke('recent.add', { path: doc.path }).catch(() => {});
      highlightTreePath(doc.path);
      offerSnapRestore(doc.path);
    }
    if (opts && opts.focus) cm.focus();
  }

  function newDocument() {
    S.filePath = null;
    S.docDir = null;
    S.fileName = '未命名';
    S.snapKey = 'untitled-' + Math.random().toString(36).slice(2, 10);
    S.lastSnapContent = null;
    setContent('', { focus: true });
    updateChrome();
    toast('新建文档');
  }

  /* ------------------------------------------------------------
     文件操作
     ------------------------------------------------------------ */

  async function openFile() {
    if (!native.available) return;
    try {
      const doc = await native.invoke('doc.open', {});
      if (doc) loadDocument(doc, { focus: true });
    } catch (e) { toast('打开失败：' + e.message); }
  }

  async function openPath(path) {
    if (!native.available) return;
    try {
      const doc = await native.invoke('doc.readPath', { path: path });
      if (doc) loadDocument(doc, { focus: true });
    } catch (e) { toast('打开失败：' + e.message); }
  }

  async function openFolder() {
    if (!native.available) return;
    try {
      const res = await native.invoke('folder.open', {});
      if (!res) return;
      S.folderRoot = res.path;
      S.tree = res.tree;
      renderTree();
      switchTab('files');
      toggleSidebar(true);
      toast('已打开文件夹：' + basename(res.path));
    } catch (e) { toast('打开文件夹失败：' + e.message); }
  }

  async function saveDocument(forceAs) {
    if (!native.available) { toast('当前不在应用内运行，无法保存'); return; }
    const content = getMD();
    try {
      const res = await native.invoke('doc.save', {
        path: forceAs ? null : S.filePath,
        content: content,
        suggestedName: S.fileName
      });
      if (!res || !res.path) return;
      const oldKey = S.snapKey;
      S.filePath = res.path;
      S.fileName = basename(res.path);
      S.docDir = dirname(res.path);
      S.snapKey = res.path;
      setDirty(false);
      updateChrome();
      native.invoke('recent.add', { path: res.path }).catch(() => {});
      native.invoke('snap.clear', { key: oldKey }).catch(() => {});
      native.invoke('snap.clear', { key: res.path }).catch(() => {});
      S.lastSnapContent = content;
      highlightTreePath(res.path);
      toast('已保存：' + S.fileName);
    } catch (e) { toast('保存失败：' + e.message); }
  }

  function revealCurrent() {
    if (!S.filePath || !native.available) return;
    native.invoke('doc.reveal', { path: S.filePath }).catch(() => {});
  }

  /* ------------------------------------------------------------
     快照（本地崩溃恢复）
     ------------------------------------------------------------ */

  function scheduleSnap() {
    if (!native.available) return;
    clearTimeout(S.snapTimer);
    S.snapTimer = setTimeout(pushSnap, 900);
  }

  function pushSnap() {
    if (!native.available) return;
    const content = getMD();
    if (content === S.lastSnapContent) return;
    S.lastSnapContent = content;
    native.invoke('snap.save', {
      key: S.snapKey,
      path: S.filePath || '',
      title: S.fileName,
      content: content,
      cursor: cm.indexFromPos(cm.getCursor()),
      scroll: Math.round(cm.getScrollInfo().top)
    }).catch(() => {});
  }

  async function offerSnapRestore(key) {
    if (!native.available) return;
    try {
      const snap = await native.invoke('snap.load', { key: key });
      if (!snap || !snap.content) return;
      if (snap.content === cm.getValue()) return;
      el.restoreText.textContent = '「' + (snap.title || basename(key)) + '」有未保存的编辑快照（' + fmtTime(snap.ts) + '）';
      el.restorebar.hidden = false;
      el.restorebar.dataset.key = key;
    } catch (e) { /* ignore */ }
  }

  async function checkAllSnaps() {
    if (!native.available) return;
    try {
      const list = await native.invoke('snap.list', {});
      if (!list || !list.length) return;
      el.restoreText.textContent = '发现 ' + list.length + ' 份未保存的编辑快照';
      el.restorebar.hidden = false;
      el.restorebar.dataset.key = '';
      S.snapList = list;
    } catch (e) { /* ignore */ }
  }

  async function showSnapList() {
    let list = S.snapList;
    if (!list) { try { list = await native.invoke('snap.list', {}); } catch (e) { list = []; } }
    if (!list.length) { toast('没有可恢复的快照'); el.restorebar.hidden = true; return; }
    const box = document.createElement('div');
    list.forEach(s => {
      const row = document.createElement('div');
      row.className = 'snap-item';
      row.innerHTML = `<span class="sn-time">${fmtTime(s.ts)}</span><span class="sn-path"></span>`;
      row.querySelector('.sn-path').textContent = s.path || s.title || '(未命名)';
      row.addEventListener('click', async () => {
        closeModal();
        try {
          const snap = await native.invoke('snap.load', { key: s.key });
          if (!snap) return;
          loadDocument({ path: snap.path || null, content: snap.content, name: snap.title }, { focus: true });
          setDirty(true);
          el.restorebar.hidden = true;
          toast('已恢复快照，记得保存');
        } catch (e) { toast('恢复失败：' + e.message); }
      });
      box.appendChild(row);
    });
    showModal('未保存的编辑快照', box);
  }

  /* ------------------------------------------------------------
     CodeMirror
     ------------------------------------------------------------ */

  function setupEditor() {
    cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
      mode: { name: 'markdown', highlightFormatting: true, xml: true },
      lineWrapping: true,
      lineNumbers: false,
      styleActiveLine: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      viewportMargin: 80,
      autoCloseBrackets: true,
      placeholder: '开始写作，或把 .md 文件拖进窗口…',
      extraKeys: {
        Tab: editorTab,
        'Shift-Tab': () => cm.indentLess()
      }
    });

    cm.on('change', () => {
      if (S.suppress) return;
      setDirty(true);
      scheduleRender();
      scheduleSnap();
    });

    cm.on('cursorActivity', () => {
      updateStats();
      if (S.prefs.typewriter) centerCursor();
      syncActiveHeadingFromEditor();
    });

    cm.on('scroll', () => {
      if (S.prefs.view !== 'split' || S.scrollLock) return;
      S.scrollLock = true;
      const info = cm.getScrollInfo();
      const max = Math.max(1, info.height - info.clientHeight);
      const ratio = info.top / max;
      const pMax = Math.max(1, el.previewWrap.scrollHeight - el.previewWrap.clientHeight);
      el.previewWrap.scrollTop = ratio * pMax;
      requestAnimationFrame(() => { S.scrollLock = false; });
    });
  }

  function editorTab() {
    if (cm.somethingSelected()) { cm.indentSelection('add'); return; }
    const pos = cm.getCursor();
    const line = cm.getLine(pos.line).slice(0, pos.ch);
    // 列表 / 引用后 Tab 继续缩进
    if (/^\s*([-*+]|\d+\.)\s|^\s*>/.test(line)) { cm.indentLine(pos.line, 'add'); return; }
    cm.replaceSelection('  ');
  }

  /* ------------------------------------------------------------
     渲染
     ------------------------------------------------------------ */

  function scheduleRender() {
    clearTimeout(S.renderTimer);
    S.renderTimer = setTimeout(renderNow, 110);
  }

  function renderNow(force) {
    if (S.prefs.view === 'wysiwyg' && !force) { buildOutline(); updateStats(); return; }
    if (S.prefs.view === 'editor' && !force) { buildOutline(); updateStats(); return; }
    const src = cm.getValue();
    const keepTop = el.previewWrap.scrollTop;
    const result = Renderer.render(src);
    S.headings = result.headings;
    el.preview.innerHTML = result.html;
    Renderer.hydrate(el.preview, { docDir: S.docDir });
    el.previewWrap.scrollTop = keepTop;
    buildOutline();
    updateStats();
  }

  /* ------------------------------------------------------------
     大纲
     ------------------------------------------------------------ */

  function outlineFromSource(text) {
    const out = [];
    text.split('\n').forEach((line, i) => {
      const m = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
      if (m) out.push({
        level: m[1].length,
        text: m[2].replace(/[*_`~]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim() || '(空标题)',
        line: i
      });
    });
    return out;
  }

  function currentOutline() {
    if (S.prefs.view === 'wysiwyg' && wiz) {
      return wiz.getOutline().map(h => ({ level: h.level, text: h.text, pos: h.pos, line: 0 }));
    }
    if (S.prefs.view === 'source') return outlineFromSource(cm.getValue());
    return S.headings;
  }

  function buildOutline() {
    const heads = currentOutline();
    if (!heads || !heads.length) {
      el.outline.innerHTML = '<div class="ol-empty">当前文档没有标题。<br>用 <b>#</b> 开头创建标题。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    heads.forEach(h => {
      const item = document.createElement('div');
      item.className = 'ol-item';
      item.dataset.level = h.level;
      item.dataset.id = h.id || '';
      item.dataset.line = h.line;
      item.dataset.pos = h.pos != null ? h.pos : '';
      item.textContent = h.text;
      item.title = h.text;
      item.addEventListener('click', () => {
        if (S.prefs.view === 'wysiwyg') {
          if (h.pos != null && wiz) {
            wiz.gotoPos(h.pos);
            setActiveOutline('pos-' + h.pos);
            return;
          }
          // 兜底：如果 h.pos 为 null 但处在所见即所得模式
          const hNodes = Array.from(document.querySelectorAll('#wysiwyg h1, #wysiwyg h2, #wysiwyg h3, #wysiwyg h4, #wysiwyg h5, #wysiwyg h6'));
          const match = hNodes.find(n => n.textContent.trim() === (h.text || '').trim());
          if (match && el.wysiwygWrap) {
            const wrapRect = el.wysiwygWrap.getBoundingClientRect();
            const elRect = match.getBoundingClientRect();
            let targetScrollTop = el.wysiwygWrap.scrollTop + (elRect.top - wrapRect.top) - 18;
            if (targetScrollTop < 80) targetScrollTop = 0;
            el.wysiwygWrap.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
          }
          setActiveOutline(h.id || (h.pos != null ? ('pos-' + h.pos) : ('line-' + h.line)));
          return;
        }

        const target = h.id ? el.preview.querySelector('#' + CSS.escape(h.id)) : null;
        if (target) {
          el.previewWrap.scrollTo({ top: target.offsetTop - 16, behavior: 'smooth' });
        }
        if (S.prefs.view !== 'preview') {
          cm.setCursor({ line: h.line, ch: 0 });
          cm.scrollIntoView({ line: h.line, ch: 0 }, 120);
        }
        setActiveOutline(h.id || (h.pos != null ? ('pos-' + h.pos) : ('line-' + h.line)));
      });
      frag.appendChild(item);
    });
    el.outline.innerHTML = '';
    el.outline.appendChild(frag);
    if (S.activeHeadingId) setActiveOutline(S.activeHeadingId);
  }

  function setActiveOutline(id) {
    S.activeHeadingId = id;
    el.outline.querySelectorAll('.ol-item').forEach(n => {
      n.classList.toggle('active', n.dataset.id === id || ('pos-' + n.dataset.pos) === id || ('line-' + n.dataset.line) === id);
    });
    const active = el.outline.querySelector('.ol-item.active');
    if (active) {
      const box = el.outline.parentElement;
      const top = active.offsetTop, bottom = top + active.offsetHeight;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = top - box.clientHeight / 2;
      }
    }
  }

  function syncActiveHeadingFromEditor() {
    if (!S.headings.length) return;
    const line = cm.getCursor().line;
    let cur = S.headings[0];
    for (const h of S.headings) { if (h.line <= line) cur = h; else break; }
    if (cur && cur.id) setActiveOutline(cur.id);
  }

  function updateOutlineFromScroll() {
    if (!S.headings.length || S.prefs.view === 'editor') return;
    const top = el.previewWrap.scrollTop + 24;
    let cur = S.headings[0];
    for (const h of S.headings) {
      const node = h.id ? el.preview.querySelector('#' + CSS.escape(h.id)) : null;
      if (node && node.offsetTop <= top) cur = h; else if (node) break;
    }
    if (cur && cur.id && cur.id !== S.activeHeadingId) setActiveOutline(cur.id);
  }

  function updateOutlineFromWysiwygScroll() {
    if (S.prefs.view !== 'wysiwyg' || !el.wysiwygWrap) return;
    const items = el.outline.querySelectorAll('.ol-item');
    if (!items.length) return;
    const hNodes = Array.from(document.querySelectorAll('#wysiwyg h1, #wysiwyg h2, #wysiwyg h3, #wysiwyg h4, #wysiwyg h5, #wysiwyg h6'));
    if (!hNodes.length) return;
    const wrapTop = el.wysiwygWrap.getBoundingClientRect().top;
    let currentMatch = hNodes[0];
    for (const node of hNodes) {
      const rect = node.getBoundingClientRect();
      if (rect.top - wrapTop <= 60) {
        currentMatch = node;
      } else {
        break;
      }
    }
    const idx = hNodes.indexOf(currentMatch);
    if (idx >= 0 && idx < items.length) {
      const targetItem = items[idx];
      const activeId = targetItem.dataset.pos ? ('pos-' + targetItem.dataset.pos) : (targetItem.dataset.id || ('line-' + targetItem.dataset.line));
      if (activeId && activeId !== S.activeHeadingId) {
        setActiveOutline(activeId);
      }
    }
  }

  /* ------------------------------------------------------------
     文件树
     ------------------------------------------------------------ */

  function renderTree() {
    el.tree.innerHTML = '';
    if (!S.tree) {
      el.tree.innerHTML = '<div class="tree-empty">还没有打开文件夹。<br>用「打开文件夹…」选择 Markdown 目录。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    walkTree(S.tree, 0, frag);
    el.tree.appendChild(frag);
  }

  function walkTree(node, depth, frag) {
    const isDir = node.isDir;
    const row = document.createElement('div');
    row.className = 'tree-row' + (isDir ? ' tree-folder' : '');
    row.style.paddingLeft = (8 + depth * 13) + 'px';
    row.dataset.path = node.path;

    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = isDir ? (node.expanded ? '▾' : '▸') : '';
    row.appendChild(tw);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = node.name;
    row.appendChild(nm);

    if (!isDir) {
      const dot = node.name.lastIndexOf('.');
      if (dot > 0) {
        const ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = node.name.slice(dot + 1).toLowerCase();
        row.appendChild(ext);
      }
    }

    row.addEventListener('click', () => {
      if (isDir) {
        node.expanded = !node.expanded;
        renderTree();
      } else {
        openPath(node.path);
      }
    });
    frag.appendChild(row);

    if (isDir && node.expanded !== false) {
      (node.children || []).forEach(c => walkTree(c, depth + 1, frag));
    }
  }

  function highlightTreePath(path) {
    el.tree.querySelectorAll('.tree-row').forEach(n => {
      n.classList.toggle('active', n.dataset.path === path);
    });
  }

  /* ------------------------------------------------------------
     查找与替换
     ------------------------------------------------------------ */

  function openFind(withReplace) {
    el.findbar.hidden = false;
    $('#replace-row').hidden = !withReplace;
    const sel = cm.getSelection();
    if (sel && !sel.includes('\n')) el.findInput.value = sel;
    el.findInput.focus();
    el.findInput.select();
    runSearch();
  }

  function closeFind() {
    el.findbar.hidden = true;
    clearFindMarks();
    cm.focus();
  }

  function clearFindMarks() {
    S.find.marks.forEach(m => { try { m.clear(); } catch (e) { /* ignore */ } });
    S.find.marks = [];
  }

  function runSearch() {
    clearFindMarks();
    S.find.matches = [];
    S.find.index = -1;
    const q = el.findInput.value;
    if (!q) { el.findCount.textContent = ''; return; }
    S.find.caseSensitive = $('#find-case').checked;

    if (S.prefs.view === 'wysiwyg' && wiz) {
      S.find.matches = wiz.find(q, S.find.caseSensitive);
      el.findCount.textContent = S.find.matches.length ? '0/' + S.find.matches.length : '无结果';
      if (S.find.matches.length) selectMatch(0); else el.findInput.focus();
      return;
    }

    let cur = cm.getSearchCursor(q, CodeMirror.Pos(cm.firstLine(), 0), { caseFold: !S.find.caseSensitive });
    while (cur.findNext()) {
      S.find.matches.push({ from: cur.from(), to: cur.to() });
      if (S.find.matches.length > 3000) break;
    }
    el.findCount.textContent = S.find.matches.length ? '0/' + S.find.matches.length : '无结果';
    if (S.find.matches.length) {
      // 定位到光标之后的第一个
      const pos = cm.getCursor();
      let idx = S.find.matches.findIndex(m => CodeMirror.cmpPos(m.from, pos) >= 0);
      if (idx < 0) idx = 0;
      selectMatch(idx);
    } else {
      el.findInput.focus();
    }
  }

  function selectMatch(idx) {
    const m = S.find.matches[idx];
    if (!m) return;
    S.find.index = idx;
    if (S.prefs.view === 'wysiwyg' && wiz) {
      el.findCount.textContent = (idx + 1) + '/' + S.find.matches.length;
      wiz.selectRange(m.from, m.to);
      return;
    }
    cm.setSelection(m.from, m.to);
    cm.scrollIntoView({ from: m.from, to: m.to }, 80);
    el.findCount.textContent = (idx + 1) + '/' + S.find.matches.length;
    el.findInput.focus();
  }

  function findStep(dir) {
    if (el.findbar.hidden) { openFind(false); return; }
    if (!S.find.matches.length) { runSearch(); return; }
    if (!S.find.matches.length) return;
    let idx = S.find.index + dir;
    if (idx < 0) idx = S.find.matches.length - 1;
    if (idx >= S.find.matches.length) idx = 0;
    selectMatch(idx);
  }

  function replaceOne() {
    const m = S.find.matches[S.find.index];
    const rep = el.replaceInput.value;
    if (!m) { findStep(1); return; }
    if (S.prefs.view === 'wysiwyg' && wiz) {
      wiz.replaceRange(m.from, m.to, rep);
      runSearch();
      findStep(1);
      return;
    }
    cm.replaceRange(rep, m.from, m.to);
    runSearch();
    findStep(1);
  }

  function replaceAll() {
    const q = el.findInput.value;
    const rep = el.replaceInput.value;
    if (!q) return;

    if (S.prefs.view === 'wysiwyg' && wiz) {
      const list = wiz.find(q, $('#find-case').checked);
      if (!list.length) { toast('没有匹配项'); return; }
      for (let i = list.length - 1; i >= 0; i--) wiz.replaceRange(list[i].from, list[i].to, rep);
      toast('已替换 ' + list.length + ' 处');
      runSearch();
      return;
    }

    const caseFold = !$('#find-case').checked;
    const matches = [];
    let cur = cm.getSearchCursor(q, CodeMirror.Pos(cm.firstLine(), 0), { caseFold: caseFold });
    while (cur.findNext()) matches.push({ from: cur.from(), to: cur.to() });
    if (!matches.length) { toast('没有匹配项'); return; }
    cm.operation(() => {
      for (let i = matches.length - 1; i >= 0; i--) {
        cm.replaceRange(rep, matches[i].from, matches[i].to);
      }
    });
    toast('已替换 ' + matches.length + ' 处');
    runSearch();
  }

  /* ------------------------------------------------------------
     格式化命令
     ------------------------------------------------------------ */

  function format(kind) {
    if (S.prefs.view === 'wysiwyg' && wiz) {
      if (kind === 'image') {
        toast('编辑模式下请直接粘贴或拖入图片，它会存到文档旁的 assets/ 目录', 3200);
        return;
      }
      if (kind === 'task') kind = 'tasklist';
      wiz.format(kind);
      return;
    }
    const sel = cm.getSelection();
    switch (kind) {
      case 'bold': wrapSel('**', '**', '粗体'); break;
      case 'italic': wrapSel('*', '*', '斜体'); break;
      case 'underline': wrapSel('<u>', '</u>', '下划线'); break;
      case 'strike': wrapSel('~~', '~~', '删除线'); break;
      case 'code': wrapSel('`', '`', 'code'); break;
      case 'link': {
        const text = sel || '链接文字';
        cm.replaceSelection('[' + text + '](url)');
        const c = cm.getCursor();
        cm.setSelection({ line: c.line, ch: c.ch - 5 }, { line: c.line, ch: c.ch - 1 });
        break;
      }
      case 'image': {
        cm.replaceSelection('![' + (sel || '图片说明') + '](path/to/image.png)');
        const c = cm.getCursor();
        cm.setSelection({ line: c.line, ch: c.ch - 21 }, { line: c.line, ch: c.ch - 1 });
        break;
      }
      case 'h1': setHeading(1); break;
      case 'h2': setHeading(2); break;
      case 'h3': setHeading(3); break;
      case 'h4': setHeading(4); break;
      case 'quote': toggleLinePrefix(/^\s*>\s?/, '> '); break;
      case 'ul': toggleLinePrefix(/^\s*[-*+]\s+/, '- '); break;
      case 'ol': toggleOrderedList(); break;
      case 'task': toggleLinePrefix(/^\s*[-*+]\s+\[[ xX]\]\s+/, '- [ ] '); break;
      case 'table': insertBlock('\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'); break;
      case 'hr': insertBlock('\n---\n'); break;
      case 'codeblock': insertFence(''); break;
      case 'math': insertFence('$$', '$$\n\n$$\n'); break;
      case 'mermaid': insertFence('mermaid', '```mermaid\nflowchart LR\n    A --> B\n```\n'); break;
    }
    cm.focus();
  }

  function wrapSel(left, right, placeholder) {
    const sel = cm.getSelection();
    if (sel && sel.startsWith(left) && sel.endsWith(right) && sel.length >= left.length + right.length) {
      cm.replaceSelection(sel.slice(left.length, sel.length - right.length));
      return;
    }
    const text = sel || placeholder;
    cm.replaceSelection(left + text + right);
    if (!sel) {
      const c = cm.getCursor();
      cm.setSelection(
        { line: c.line, ch: c.ch - right.length - text.length },
        { line: c.line, ch: c.ch - right.length }
      );
    }
  }

  function setHeading(level) {
    const line = cm.getCursor().line;
    const text = cm.getLine(line).replace(/^\s*#{1,6}\s+/, '');
    cm.replaceRange('#'.repeat(level) + ' ' + text, { line: line, ch: 0 }, { line: line, ch: cm.getLine(line).length });
    cm.setCursor({ line: line, ch: level + 1 + text.length });
  }

  function toggleLinePrefix(pattern, prefix) {
    const ranges = cm.listSelections();
    cm.operation(() => {
      ranges.forEach(r => {
        const from = Math.min(r.anchor.line, r.head.line);
        const to = Math.max(r.anchor.line, r.head.line);
        let all = true;
        for (let l = from; l <= to; l++) { if (!pattern.test(cm.getLine(l))) { all = false; break; } }
        for (let l = from; l <= to; l++) {
          const line = cm.getLine(l);
          if (all) {
            cm.replaceRange(line.replace(pattern, ''), { line: l, ch: 0 }, { line: l, ch: line.length });
          } else {
            cm.replaceRange(prefix + line, { line: l, ch: 0 }, { line: l, ch: 0 });
          }
        }
      });
    });
  }

  function toggleOrderedList() {
    const line = cm.getCursor().line;
    const text = cm.getLine(line);
    if (/^\s*\d+\.\s+/.test(text)) {
      cm.replaceRange(text.replace(/^\s*\d+\.\s+/, ''), { line: line, ch: 0 }, { line: line, ch: text.length });
    } else {
      cm.replaceRange('1. ' + text, { line: line, ch: 0 }, { line: line, ch: 0 });
    }
  }

  function insertBlock(text) {
    const c = cm.getCursor();
    const lineText = cm.getLine(c.line);
    const prefix = lineText.trim().length ? '\n' : '';
    cm.replaceSelection(prefix + text.replace(/^\n/, ''));
  }

  function insertFence(lang, full) {
    if (full) { insertBlock('\n' + full); return; }
    insertBlock('\n```' + (lang || '') + '\n\n```\n');
    const c = cm.getCursor();
    cm.setCursor({ line: c.line - 2, ch: 0 });
  }

  /* ------------------------------------------------------------
     图片（本地化：写入文档同级 assets/）
     ------------------------------------------------------------ */

  async function handleImageFiles(files) {
    if (!S.filePath) {
      toast('请先保存文档（⌘S），图片会存到文档旁的 assets/ 目录', 3200);
      return;
    }
    for (const file of files) {
      try {
        const dataUrl = await readAsDataURL(file);
        const res = await native.invoke('image.save', {
          dataUrl: dataUrl,
          docPath: S.filePath,
          name: file.name || 'image.png'
        });
        if (!res || !res.rel) continue;
        const alt = (file.name || 'image').replace(/\.[^.]+$/, '');
        cm.replaceSelection('\n![' + alt + '](' + res.rel + ')\n');
        toast('已插入图片：' + res.rel);
      } catch (e) {
        toast('图片保存失败：' + e.message);
      }
    }
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(file);
    });
  }

  /* ------------------------------------------------------------
     导出
     ------------------------------------------------------------ */

  function stripInteractive(root) {
    root.querySelectorAll('.mermaid-src, script').forEach(n => n.remove());
    // 只删除文档级 <style>，SVG 内部的 <style> 是图表样式，必须保留
    root.querySelectorAll('style').forEach(n => { if (!n.closest('svg')) n.remove(); });
    root.querySelectorAll('.anchor').forEach(n => n.remove());
    root.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  }

  async function inlineLocalImages(root) {
    const imgs = Array.from(root.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('offline-md://local')) continue;
      try {
        const abs = decodeURIComponent(src.slice('offline-md://local'.length));
        const b64 = await native.invoke('asset.base64', { path: abs });
        if (b64 && b64.data) {
          img.setAttribute('src', 'data:' + b64.mime + ';base64,' + b64.data);
        }
      } catch (e) { /* 保留原样 */ }
    }
  }

  async function buildExportCSS() {
    let css = Renderer.collectCSS();
    // KaTeX 字体内联，保证导出的单文件 HTML 脱离本机也能正确显示公式
    const woff2 = Array.from(new Set(Array.from(css.matchAll(/url\((fonts\/[^)]+?\.woff2)\)/g)).map(m => m[1])));
    const map = {};
    for (const rel of woff2) {
      try {
        const b64 = await native.invoke('asset.base64', { path: 'vendor/' + rel });
        if (b64 && b64.data) map[rel] = b64.data;
      } catch (e) { /* ignore */ }
    }
    css = css.replace(/url\((fonts\/[^)]+?\.woff2)\)/g, (m, rel) => {
      return map[rel] ? `url(data:font/woff2;base64,${map[rel]})` : m;
    });
    css = css.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
    return css;
  }

  async function waitForMermaid(root, timeout) {
    const box = root || el.preview;
    const start = Date.now();
    while (Date.now() - start < (timeout || 2500)) {
      if (!box.querySelector('.mermaid-wrap[data-state="pending"]')) return true;
      await new Promise(r => setTimeout(r, 90));
    }
    return false;
  }

  async function buildExportHTML(forPrint) {
    // 从当前编辑内容渲染出一份干净 DOM，再内联资源。
    // 不依赖可见的预览区——所见即所得模式下用户看到的编辑面就是渲染结果，
    // 导出必须走同一条渲染管线才能保证一致。
    const scratch = document.getElementById('export-scratch');
    scratch.innerHTML = Renderer.render(getMD()).html;
    Renderer.hydrate(scratch, { docDir: S.docDir });
    await waitForMermaid(scratch, forPrint ? 3000 : 1500);

    const article = document.createElement('article');
    article.className = 'markdown-body';
    article.innerHTML = scratch.innerHTML;
    stripInteractive(article);
    scratch.innerHTML = '';

    const holder = document.createElement('div');
    holder.className = 'export-root';
    holder.appendChild(article);
    await inlineLocalImages(holder);

    const css = await buildExportCSS();
    const theme = forPrint ? 'paper' : S.prefs.theme;
    const title = S.fileName.replace(MD_EXT, '') || '未命名';

    const printCSS = forPrint
      ? `
      html, body { margin:0; padding:0; background:#fff; }
      body { width: 794px; }
      .export-root { width: 794px; box-sizing: border-box; padding: 52px 56px 64px; }
      .markdown-body { max-width: none !important; margin: 0 !important; padding: 0 !important;
        font-size: 16px; line-height: 1.72; color: #1a1a1a; }
      .markdown-body a { color: #1a1a1a !important; border: none !important; }
      .markdown-body pre, .markdown-body table, .markdown-body blockquote { break-inside: avoid; }
      .markdown-body h1, .markdown-body h2, .markdown-body h3 { break-after: avoid; }
      .markdown-body img { break-inside: avoid; }
      .markdown-body pre > code {
        color: #1a1a1a !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere;
        font-size: .78em;
        overflow: visible !important;
      }
      .markdown-body table { display: table; width: 100%; font-size: .86em; }
      .markdown-body .mermaid-wrap { break-inside: avoid; }
      .markdown-body .mermaid-wrap svg { max-width: 100% !important; height: auto !important; }
      `
      : `
      html, body { margin:0; padding:0; background: var(--bg); }
      .export-root { padding: 48px 16px; }
      .markdown-body { max-width: 46em; margin: 0 auto; padding: 0 28px; }
      `;

    const pageScript = forPrint ? `
<script>
window.__pageBreaks = function (pageH) {
  var root = document.getElementById('export-root');
  var H = Math.max(root.scrollHeight, document.body.scrollHeight);
  var sel = 'p,pre,blockquote,ul,ol,table,hr,figure,.mermaid-wrap,.math-block,img,h1,h2,h3,h4,h5,h6';
  var cands = [];
  root.querySelectorAll(sel).forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.height <= 0) return;
    cands.push({ y: Math.round(r.bottom + window.scrollY), heading: /^H[1-6]$/.test(el.tagName) });
  });
  cands.sort(function (a, b) { return a.y - b.y; });

  var breaks = [0];
  var target = pageH;
  while (target < H - 6) {
    var idx = -1;
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].y <= target - 4) idx = i; else break;
    }
    // 断点落在标题之后会导致标题孤行，回退到上一个块
    while (idx > 0 && cands[idx].heading) idx--;
    var pick = idx >= 0 ? cands[idx].y : target;
    var last = breaks[breaks.length - 1];
    if (pick <= last + 24) pick = target;
    breaks.push(pick);
    target = pick + pageH;
  }
  breaks.push(H);
  return breaks;
};
<\/script>` : '';

    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="generator" content="OfflineMD">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
${css}
${printCSS}
</style>
</head>
<body>
<div id="export-root" class="export-root">
${holder.innerHTML}
</div>${pageScript}
</body>
</html>`;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function exportHTML() {
    if (!native.available) { toast('当前不在应用内运行'); return; }
    try {
      toast('正在生成 HTML…', 1200);
      const html = await buildExportHTML(false);
      const res = await native.invoke('doc.exportHTML', {
        html: html,
        suggestedName: (S.fileName.replace(MD_EXT, '') || '未命名') + '.html'
      });
      if (res && res.path) toast('已导出：' + basename(res.path));
    } catch (e) { toast('导出失败：' + e.message); }
  }

  async function exportPDF() {
    if (!native.available) { toast('当前不在应用内运行'); return; }
    try {
      toast('正在排版 PDF…', 1600);
      const html = await buildExportHTML(true);
      const res = await native.invoke('doc.exportPDF', {
        html: html,
        suggestedName: (S.fileName.replace(MD_EXT, '') || '未命名') + '.pdf'
      });
      if (res && res.path) {
        const note = res.textOK === false
          ? '（部分汉字可能无法正确复制，属 WebKit 导出 PDF 的已知文本层问题）'
          : '';
        toast('已导出 PDF：' + res.pages + ' 页' + note, res.textOK === false ? 5200 : 3200);
      }
    } catch (e) { toast('导出失败：' + e.message); }
  }

  /* ------------------------------------------------------------
     统计
     ------------------------------------------------------------ */

  function updateStats() {
    if (S.prefs.view === 'wysiwyg' && wiz) {
      const s = wiz.getStats();
      el.sbWords.textContent = s.words + ' 字';
      el.sbChars.textContent = s.chars + ' 字符';
      el.sbLines.textContent = s.blocks + ' 段';
      el.sbCursor.textContent = '所见即所得';
      return;
    }
    if (!cm) return;
    const text = cm.getValue();
    const words = countWords(text);
    const chars = text.length;
    const lines = cm.lineCount();
    const pos = cm.getCursor();
    el.sbWords.textContent = words + ' 字';
    el.sbChars.textContent = chars + ' 字符';
    el.sbLines.textContent = lines + ' 行';
    el.sbCursor.textContent = '行 ' + (pos.line + 1) + '，列 ' + (pos.ch + 1);
  }

  /* ------------------------------------------------------------
     浮层
     ------------------------------------------------------------ */

  function showModal(title, body) {
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = '';
    if (typeof body === 'string') el.modalBody.innerHTML = body;
    else el.modalBody.appendChild(body);
    el.modal.hidden = false;
  }

  function closeModal() { el.modal.hidden = true; }

  function showShortcuts() {
    const rows = [
      ['新建 / 打开 / 打开文件夹', '⌘N / ⌘O / ⌘⇧O'],
      ['保存 / 另存为', '⌘S / ⌘⇧S'],
      ['撤销 / 重做', '⌘Z / ⇧⌘Z'],
      ['剪切 / 拷贝 / 粘贴 / 全选', '⌘X / ⌘C / ⌘V / ⌘A'],
      ['导出 HTML / PDF', '⌘E / ⌘⇧E'],
      ['编辑 / 源码 / 分栏 / 预览', '⌘1 / ⌘2 / ⌘3 / ⌘4'],
      ['侧栏 / 专注 / 打字机', '⌘⇧L / ⌘⇧J (F8) / ⌥⌘T (F9)'],
      ['查找 / 替换', '⌘F / ⌥⌘F'],
      ['下一个 / 上一个匹配', '⌘G / ⇧⌘G'],
      ['粗体 / 斜体 / 下划线 / 删除线 / 行内代码', '⌘B / ⌘I / ⌘U / ⌥⌘S / ⇧⌘`'],
      ['链接 / 图片', '⌘K / ⌃⌘I'],
      ['标题 1–4', '⌃⌘1 … ⌃⌘4'],
      ['引用 / 无序 / 有序 / 任务', '⌥⌘Q / ⌃⌘U / ⌃⌘L / ⌥⌘X'],
      ['代码块 / 公式块 / 图表', '⇧⌘K / ⌃⌘M / ⌃⌘D'],
      ['表格 / 分隔线', '⌃⌘K / ⌃⌘H'],
      ['切换主题', '⌃⌘T'],
      ['缩放', '⌘= (⌘+) / ⌘- / ⌘0']
    ];
    const html = '<table>' + rows.map(r => `<tr><td>${escapeHTML(r[0])}</td><td>${r[1].split(' / ').map(k => '<kbd>' + escapeHTML(k) + '</kbd>').join(' ')}</td></tr>`).join('') + '</table>' +
      '<h4>关于离线</h4><p>本应用不包含任何网络请求：授权校验、自动更新、遥测上报均已移除；公式与图表在本地渲染；图片保存到文档同级 <code>assets/</code> 目录；导出为纯本地文件操作。</p>';
    showModal('快捷键与说明', html);
  }

  /* ------------------------------------------------------------
     UI 绑定
     ------------------------------------------------------------ */

  function switchTab(tab) {
    S.prefs.tab = tab;
    document.querySelectorAll('.side-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    el.outline.hidden = tab !== 'outline';
    el.tree.hidden = tab !== 'files';
    savePrefs();
  }

  function bindUI() {
    $('#btn-sidebar').addEventListener('click', () => toggleSidebar());
    $('#btn-new').addEventListener('click', newDocument);
    $('#btn-open').addEventListener('click', openFile);
    $('#btn-save').addEventListener('click', () => saveDocument(false));
    $('#btn-find').addEventListener('click', () => openFind(false));
    $('#btn-theme').addEventListener('click', cycleTheme);
    $('#btn-open-folder').addEventListener('click', openFolder);

    document.querySelectorAll('#view-seg button').forEach(b => {
      b.addEventListener('click', () => applyView(b.dataset.view));
    });

    document.querySelectorAll('.side-tabs button').forEach(b => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    // 查找栏
    el.findInput.addEventListener('input', runSearch);
    el.findInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    el.replaceInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('#find-next').addEventListener('click', () => findStep(1));
    $('#find-prev').addEventListener('click', () => findStep(-1));
    $('#find-close').addEventListener('click', closeFind);
    $('#find-case').addEventListener('change', runSearch);
    $('#replace-one').addEventListener('click', replaceOne);
    $('#replace-all').addEventListener('click', replaceAll);

    // 恢复条
    $('#restore-open').addEventListener('click', showSnapList);
    $('#restore-dismiss').addEventListener('click', async () => {
      el.restorebar.hidden = true;
      const key = el.restorebar.dataset.key;
      if (key && native.available) {
        try { await native.invoke('snap.clear', { key: key }); } catch (e) { /* ignore */ }
      }
    });

    // 模态
    $('#modal-close').addEventListener('click', closeModal);
    el.modal.addEventListener('click', e => { if (e.target === el.modal) closeModal(); });

    // 分栏拖动
    el.splitter.addEventListener('mousedown', e => {
      e.preventDefault();
      el.splitter.classList.add('dragging');
      const rect = el.main.getBoundingClientRect();
      const side = el.app.classList.contains('no-sidebar') ? 0 : 232;
      const move = ev => {
        const usable = rect.width - side;
        let x = ev.clientX - rect.left - side;
        x = Math.max(240, Math.min(usable - 260, x));
        S.prefs.splitRatio = x / usable;
        applySplitRatio();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        el.splitter.classList.remove('dragging');
        savePrefs();
        if (cm) cm.refresh();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // 预览区滚动 → 大纲联动 + 编辑区同步
    el.previewWrap.addEventListener('scroll', () => {
      updateOutlineFromScroll();
      if (S.prefs.view !== 'split' || S.scrollLock) return;
      S.scrollLock = true;
      const pMax = Math.max(1, el.previewWrap.scrollHeight - el.previewWrap.clientHeight);
      const ratio = el.previewWrap.scrollTop / pMax;
      const info = cm.getScrollInfo();
      cm.scrollTo(null, ratio * Math.max(1, info.height - info.clientHeight));
      requestAnimationFrame(() => { S.scrollLock = false; });
    });

    // 所见即所得编辑区滚动 → 大纲联动
    if (el.wysiwygWrap) {
      el.wysiwygWrap.addEventListener('scroll', () => {
        if (S.prefs.view !== 'wysiwyg') return;
        updateOutlineFromWysiwygScroll();
      });
    }

    // 预览区交互
    el.preview.addEventListener('click', onPreviewClick);
    el.preview.addEventListener('change', onPreviewChange);

    // 拖放
    document.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', async e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      const mdFile = files.find(f => MD_EXT.test(f.name));
      if (mdFile) {
        const text = await mdFile.text();
        loadDocument({ path: null, content: text, name: mdFile.name }, { focus: true });
        setDirty(true);
        toast('已载入：' + mdFile.name + '（未保存路径，⌘S 可保存）');
        return;
      }
      const images = files.filter(f => /^image\//.test(f.type));
      if (images.length) handleImageFiles(images);
    });

    // 粘贴图片
    document.addEventListener('paste', e => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const imgs = items.filter(i => i.kind === 'file' && /^image\//.test(i.type));
      if (!imgs.length) return;
      e.preventDefault();
      const files = imgs.map(i => i.getAsFile()).filter(Boolean);
      handleImageFiles(files);
    });

    // 统一捕获阶段快捷键分发（阻止 ProseMirror / CodeMirror 内部 keymap 与冒泡层双重触发抵消）
    function matchKey(e, code, ch) {
      if (e.code && e.code === code) return true;
      if (!e.code && e.key && ch) {
        const k = e.key.toLowerCase();
        if (Array.isArray(ch)) return ch.includes(k);
        return k === ch.toLowerCase();
      }
      return false;
    }

    function consumeKey(e) {
      e.preventDefault();
      e.stopPropagation();
      S.lastKeyShortcutTs = Date.now();
    }

    window.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Escape') { closeFind(); closeModal(); return; }
      if (e.key === 'F8' || e.code === 'F8') { consumeKey(e); toggleFocus(); return; }
      if (e.key === 'F9' || e.code === 'F9') { consumeKey(e); toggleTypewriter(); return; }

      if (!e.metaKey) return;

      const isInput = document.activeElement &&
        (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') &&
        !document.activeElement.closest('.CodeMirror') &&
        !document.activeElement.closest('#wysiwyg');

      // 1. 仅 ⌘ (Command)
      if (!e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (matchKey(e, 'KeyZ', 'z')) {
          if (!isInput) {
            consumeKey(e);
            if (S.prefs.view === 'wysiwyg' && wiz) wiz.undo();
            else if (cm) cm.undo();
          }
        }
        else if (matchKey(e, 'KeyB', 'b') && !isInput) { consumeKey(e); format('bold'); }
        else if (matchKey(e, 'KeyI', 'i') && !isInput) { consumeKey(e); format('italic'); }
        else if (matchKey(e, 'KeyU', 'u') && !isInput) { consumeKey(e); format('underline'); }
        else if (matchKey(e, 'KeyK', 'k') && !isInput) { consumeKey(e); format('link'); }
        else if (matchKey(e, 'KeyS', 's')) { consumeKey(e); saveDocument(false); }
        else if (matchKey(e, 'KeyN', 'n')) { consumeKey(e); newDocument(); }
        else if (matchKey(e, 'KeyO', 'o')) { consumeKey(e); openFile(); }
        else if (matchKey(e, 'KeyE', 'e')) { consumeKey(e); exportHTML(); }
        else if (matchKey(e, 'KeyF', 'f')) { consumeKey(e); openFind(false); }
        else if (matchKey(e, 'KeyG', 'g')) { consumeKey(e); findStep(1); }
        else if (matchKey(e, 'Digit1', '1')) { consumeKey(e); applyView('wysiwyg'); }
        else if (matchKey(e, 'Digit2', '2')) { consumeKey(e); applyView('source'); }
        else if (matchKey(e, 'Digit3', '3')) { consumeKey(e); applyView('split'); }
        else if (matchKey(e, 'Digit4', '4')) { consumeKey(e); applyView('preview'); }
        else if (matchKey(e, 'Slash', '/')) { consumeKey(e); showShortcuts(); }
        else if (matchKey(e, 'Equal', ['=', '+']) || e.code === 'NumpadAdd') {
          consumeKey(e);
          if (window.native && native.available) native.invoke('window.zoom', { delta: 0.1 }).catch(() => {});
        }
        else if (matchKey(e, 'Minus', '-') || e.code === 'NumpadSubtract') {
          consumeKey(e);
          if (window.native && native.available) native.invoke('window.zoom', { delta: -0.1 }).catch(() => {});
        }
        else if (matchKey(e, 'Digit0', '0') || e.code === 'Numpad0') {
          consumeKey(e);
          if (window.native && native.available) native.invoke('window.resetZoom', {}).catch(() => {});
        }
      }
      // 2. ⇧⌘ (Shift + Command)
      else if (e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (matchKey(e, 'KeyZ', 'z')) {
          if (!isInput) {
            consumeKey(e);
            if (S.prefs.view === 'wysiwyg' && wiz) wiz.redo();
            else if (cm) cm.redo();
          }
        }
        else if (matchKey(e, 'KeyS', 's')) { consumeKey(e); saveDocument(true); }
        else if (matchKey(e, 'KeyO', 'o')) { consumeKey(e); openFolder(); }
        else if (matchKey(e, 'KeyE', 'e')) { consumeKey(e); exportPDF(); }
        else if (matchKey(e, 'KeyG', 'g')) { consumeKey(e); findStep(-1); }
        else if (matchKey(e, 'KeyL', 'l')) { consumeKey(e); toggleSidebar(); }
        else if (matchKey(e, 'KeyJ', 'j')) { consumeKey(e); toggleFocus(); }
        else if (matchKey(e, 'KeyK', 'k') && !isInput) { consumeKey(e); format('codeblock'); }
        else if ((matchKey(e, 'Backquote', ['`', '~', '·', '～']) || e.key === '`' || e.key === '~') && !isInput) {
          consumeKey(e);
          format('code');
        }
        else if (matchKey(e, 'Equal', ['=', '+'])) {
          consumeKey(e);
          if (window.native && native.available) native.invoke('window.zoom', { delta: 0.1 }).catch(() => {});
        }
      }
      // 3. ⌥⌘ (Option + Command)
      else if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (matchKey(e, 'KeyF', ['f', 'ƒ'])) { consumeKey(e); openFind(true); }
        else if (matchKey(e, 'KeyS', ['s', 'ß']) && !isInput) { consumeKey(e); format('strike'); }
        else if (matchKey(e, 'KeyQ', ['q', 'œ']) && !isInput) { consumeKey(e); format('quote'); }
        else if (matchKey(e, 'KeyX', ['x', '≈']) && !isInput) { consumeKey(e); format('task'); }
        else if (matchKey(e, 'KeyT', ['t', '†'])) { consumeKey(e); toggleTypewriter(); }
      }
      // 4. ⌃⌘ (Control + Command)
      else if (e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (matchKey(e, 'Digit1', '1') && !isInput) { consumeKey(e); format('h1'); }
        else if (matchKey(e, 'Digit2', '2') && !isInput) { consumeKey(e); format('h2'); }
        else if (matchKey(e, 'Digit3', '3') && !isInput) { consumeKey(e); format('h3'); }
        else if (matchKey(e, 'Digit4', '4') && !isInput) { consumeKey(e); format('h4'); }
        else if (matchKey(e, 'KeyU', 'u') && !isInput) { consumeKey(e); format('ul'); }
        else if (matchKey(e, 'KeyL', 'l') && !isInput) { consumeKey(e); format('ol'); }
        else if (matchKey(e, 'KeyK', 'k') && !isInput) { consumeKey(e); format('table'); }
        else if (matchKey(e, 'KeyH', 'h') && !isInput) { consumeKey(e); format('hr'); }
        else if (matchKey(e, 'KeyM', 'm') && !isInput) { consumeKey(e); format('math'); }
        else if (matchKey(e, 'KeyD', 'd') && !isInput) { consumeKey(e); format('mermaid'); }
        else if (matchKey(e, 'KeyI', 'i') && !isInput) { consumeKey(e); format('image'); }
        else if (matchKey(e, 'KeyT', 't')) { consumeKey(e); cycleTheme(); }
      }
    }, true);
  }

  async function onPreviewClick(e) {
    const box = e.target.closest('.task-list-item input[type="checkbox"]');
    if (box) { return; } // change 事件处理

    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href) return;
    e.preventDefault();
    openHref(href);
  }

  function onPreviewChange(e) {
    const box = e.target;
    if (!box.matches('.task-list-item input[type="checkbox"]')) return;
    const boxes = Array.from(el.preview.querySelectorAll('.task-list-item input[type="checkbox"]'));
    const idx = boxes.indexOf(box);
    if (idx < 0) return;
    const li = box.closest('.task-list-item');
    if (li) li.classList.toggle('is-checked', box.checked);

    const re = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/gm;
    const text = cm.getValue();
    let i = 0, replaced = false;
    const next = text.replace(re, (m, a, c, b) => {
      if (i++ === idx) { replaced = true; return a + (box.checked ? 'x' : ' ') + b; }
      return m;
    });
    if (replaced) {
      const scroll = cm.getScrollInfo().top;
      cm.setValue(next);
      cm.scrollTo(null, scroll);
    }
  }

  /* ------------------------------------------------------------
     原生事件
     ------------------------------------------------------------ */

  function bindNative() {
    if (!window.native) return;
    if (!native.available) {
      console.warn('[OfflineMD] 未检测到原生桥，降级为浏览器模式');
    }

    native.on('menu', payload => {
      if (S.lastKeyShortcutTs && (Date.now() - S.lastKeyShortcutTs < 45)) {
        S.lastKeyShortcutTs = 0;
        return;
      }
      let action = payload && payload.action;
      let arg = payload && payload.arg;
      if (action && action.startsWith('view.theme:') && !arg) {
        arg = action.slice('view.theme:'.length);
        action = 'view.theme';
      }
      switch (action) {
        case 'file.new': newDocument(); break;
        case 'file.open': openFile(); break;
        case 'file.openFolder': openFolder(); break;
        case 'file.openPath': openPath(arg); break;
        case 'file.save': saveDocument(false); break;
        case 'file.saveAs': saveDocument(true); break;
        case 'file.exportHTML': exportHTML(); break;
        case 'file.exportPDF': exportPDF(); break;
        case 'file.reveal': revealCurrent(); break;
        case 'edit.undo': {
          const isExternalInput = document.activeElement && 
            (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') && 
            !document.activeElement.closest('.CodeMirror') && 
            !document.activeElement.closest('#wysiwyg');
          if (isExternalInput) {
            document.execCommand('undo');
          } else if (S.prefs.view === 'wysiwyg' && wiz) {
            wiz.undo();
          } else if (cm) {
            cm.undo();
          }
          break;
        }
        case 'edit.redo': {
          const isExternalInput = document.activeElement && 
            (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') && 
            !document.activeElement.closest('.CodeMirror') && 
            !document.activeElement.closest('#wysiwyg');
          if (isExternalInput) {
            document.execCommand('redo');
          } else if (S.prefs.view === 'wysiwyg' && wiz) {
            wiz.redo();
          } else if (cm) {
            cm.redo();
          }
          break;
        }
        case 'edit.find': openFind(false); break;
        case 'edit.replace': openFind(true); break;
        case 'edit.findNext': findStep(1); break;
        case 'edit.findPrev': findStep(-1); break;
        case 'view.wysiwyg': applyView('wysiwyg'); break;
        case 'view.source': applyView('source'); break;
        case 'view.split': applyView('split'); break;
        case 'view.preview': applyView('preview'); break;
        case 'view.sidebar': toggleSidebar(); break;
        case 'view.focus': toggleFocus(); break;
        case 'view.typewriter': toggleTypewriter(); break;
        case 'view.theme': applyTheme(arg, { announce: true }); break;
        case 'view.themeNext': cycleTheme(); break;
        case 'format.bold': format('bold'); break;
        case 'format.italic': format('italic'); break;
        case 'format.underline': format('underline'); break;
        case 'format.strike': format('strike'); break;
        case 'format.code': format('code'); break;
        case 'format.link': format('link'); break;
        case 'format.image': format('image'); break;
        case 'format.h1': format('h1'); break;
        case 'format.h2': format('h2'); break;
        case 'format.h3': format('h3'); break;
        case 'format.h4': format('h4'); break;
        case 'format.quote': format('quote'); break;
        case 'format.ul': format('ul'); break;
        case 'format.ol': format('ol'); break;
        case 'format.task': format('task'); break;
        case 'format.table': format('table'); break;
        case 'format.hr': format('hr'); break;
        case 'format.codeblock': format('codeblock'); break;
        case 'format.math': format('math'); break;
        case 'format.mermaid': format('mermaid'); break;
        case 'help.shortcuts': showShortcuts(); break;
        case 'doc.reloaded': if (arg && arg.content != null) loadDocument(arg); break;
        default: console.warn('unknown menu action', action);
      }
    });

    native.on('file.externalChange', payload => {
      // 文件被外部修改
      if (!payload || payload.path !== S.filePath) return;
      if (!S.dirty) {
        native.invoke('doc.readPath', { path: payload.path }).then(doc => {
          if (doc) { setContent(doc.content); toast('文件已在外部更新，已重新载入'); }
        }).catch(() => {});
      } else {
        toast('文件已在外部修改（本地有未保存改动，未覆盖）', 3000);
      }
    });

    native.on('window.focusEditor', () => { if (cm) cm.focus(); });
  }

  // 所见即所得内核（ProseMirror）。懒加载：失败则降级到「源码 / 分栏」
  async function ensureWysiwyg() {
    if (wiz) return wiz;
    if (!window.WysiwygKit || !window.WysiwygKit.create) {
      console.warn('[OfflineMD] 所见即所得内核未加载');
      return null;
    }
    try {
      const inst = WysiwygKit.create();
      await inst.mount(document.getElementById('wysiwyg'), cm.getValue(), {
        docDir: S.docDir,
        onChange: () => {
          setDirty(true);
          scheduleSnap();
          scheduleOutline();
        },
        onSelection: () => updateStats(),
        onImageFiles: files => handleImageFiles(files),
        onLinkClick: href => openHref(href)
      });
      wiz = inst;
    } catch (e) {
      console.error('[OfflineMD] 所见即所得内核初始化失败，降级为分栏', e);
      wiz = null;
    }
    return wiz;
  }

  function scheduleOutline() {
    clearTimeout(S.outlineTimer);
    S.outlineTimer = setTimeout(() => { buildOutline(); updateStats(); }, 120);
  }

  // 预览区 / 编辑区共用的链接处理
  function openHref(href) {
    if (!href) return;
    if (href.startsWith('#')) {
      const anchor = decodeURIComponent(href.slice(1));
      if (S.prefs.view === 'wysiwyg' && el.wysiwygWrap) {
        const hNodes = Array.from(document.querySelectorAll('#wysiwyg h1, #wysiwyg h2, #wysiwyg h3, #wysiwyg h4, #wysiwyg h5, #wysiwyg h6'));
        const match = hNodes.find(n => n.id === anchor || n.textContent.trim().toLowerCase() === anchor.toLowerCase().replace(/-/g, ' '));
        if (match) {
          const wrapRect = el.wysiwygWrap.getBoundingClientRect();
          const elRect = match.getBoundingClientRect();
          const targetScrollTop = el.wysiwygWrap.scrollTop + (elRect.top - wrapRect.top) - 18;
          el.wysiwygWrap.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
          return;
        }
      }
      const target = el.preview.querySelector('#' + CSS.escape(anchor));
      if (target) el.previewWrap.scrollTo({ top: target.offsetTop - 16, behavior: 'smooth' });
      return;
    }
    if (S.docDir && !/^[a-z]+:/i.test(href)) {
      openPath(Renderer.joinPath(S.docDir, href));
      return;
    }
    if (/^https?:/i.test(href) && native.available) {
      native.invoke('shell.openExternal', { url: href }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */

  async function boot() {
    if (window.native && native.available) {
      try {
        const p = await native.invoke('prefs.get', {});
        if (p && typeof p === 'object') S.prefs = Object.assign(S.prefs, p);
      } catch (e) { /* ignore */ }
    }
    // 旧版本的视图名兼容
    if (S.prefs.view === 'editor') S.prefs.view = 'source';
    if (S.prefs.view !== 'wysiwyg' && S.prefs.view !== 'source' && S.prefs.view !== 'split' && S.prefs.view !== 'preview') {
      S.prefs.view = 'wysiwyg';
    }

    applyTheme(S.prefs.theme, { silent: true });
    el.app.classList.toggle('no-sidebar', !S.prefs.sidebar);
    el.app.classList.toggle('focus-mode', !!S.prefs.focus);
    setupEditor();
    bindUI();
    bindNative();

    await ensureWysiwyg();
    if (!wiz) S.prefs.view = 'split';

    applyView(S.prefs.view || 'wysiwyg');
    switchTab(S.prefs.tab || 'outline');
    applySplitRatio();

    setContent(window.WELCOME_MD || '# 欢迎\n', { focus: true });
    updateChrome();
    setDirty(false);
    renderNow();

    if (window.native && native.available) checkAllSnaps();

    // 主题切换后重绘（mermaid 颜色跟随）
    window.addEventListener('resize', () => { if (cm) cm.refresh(); applySplitRatio(); });

    S.booted = true;
  }

  // 供原生调用
  window.__nativeMenu = function (action, arg) {
    window.__nativeEvent('menu', { action: action, arg: arg });
  };
  window.__editor = {
    getValue: () => getMD(),
    setValue: t => setContent(t),
    format: kind => format(kind),
    focus: () => {
      if (S.prefs.view === 'wysiwyg' && wiz) wiz.focus();
      else if (cm) cm.focus();
    }
  };

  // 供自检脚本调用（不影响正常使用）
  window.__debug = {
    buildExportHTML: buildExportHTML,
    renderNow: renderNow,
    setTheme: n => applyTheme(n),
    setView: v => applyView(v),
    selectRange: (from, to) => {
      if (S.prefs.view === 'wysiwyg' && wiz) wiz.selectRange(from, to);
      else if (cm) cm.setSelection(cm.posFromIndex(from), cm.posFromIndex(to));
    },
    lineCount: () => cm.lineCount(),
    stats: () => ({
      katex: document.querySelectorAll('.katex').length,
      mermaidSvg: document.querySelectorAll('.mermaid-wrap svg').length,
      mermaidPending: document.querySelectorAll('.mermaid-wrap[data-state="pending"]').length,
      mermaidError: document.querySelectorAll('.mermaid-wrap[data-state="error"]').length,
      hljsTokens: document.querySelectorAll('pre code [class^="hljs-"]').length,
      headings: document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3').length,
      outline: document.querySelectorAll('#outline-list .ol-item').length,
      tables: document.querySelectorAll('.markdown-body table').length,
      taskItems: document.querySelectorAll('.task-list-item').length,
      footnotes: document.querySelectorAll('.footnotes li').length,
      previewHeight: document.getElementById('preview').scrollHeight,
      wysiwygRoot: !!document.querySelector('#wysiwyg .ProseMirror'),
      wizHeadings: document.querySelectorAll('#wysiwyg h1, #wysiwyg h2, #wysiwyg h3, #wysiwyg h4').length,
      wizParagraphs: document.querySelectorAll('#wysiwyg p').length,
      wizTables: document.querySelectorAll('#wysiwyg table th').length,
      wizTaskItems: document.querySelectorAll('#wysiwyg li.task-item input[type="checkbox"]').length,
      wizTaskListLi: document.querySelectorAll('#wysiwyg li[data-checked], #wysiwyg li.task-list-item').length,
      wizLiSample: (function () {
        const li = document.querySelector('#wysiwyg ul li');
        return li ? li.outerHTML.slice(0, 160) : '';
      })(),
      wizTaskHTML: (function () {
        const li = document.querySelector('#wysiwyg li[data-checked]');
        return li ? li.outerHTML.slice(0, 320) : '';
      })(),
      wizKatex: document.querySelectorAll('#wysiwyg .katex').length,
      wizMermaid: document.querySelectorAll('#wysiwyg .mmd-live svg').length,
      wizMermaidPending: document.querySelectorAll('#wysiwyg .mmd-loading').length,
      wizImages: document.querySelectorAll('#wysiwyg img').length,
      wizOrderedLists: document.querySelectorAll('#wysiwyg ol').length,
      wizBulletLists: document.querySelectorAll('#wysiwyg ul:not(.task-list)').length,
      wizCodeBlocks: document.querySelectorAll('#wysiwyg pre').length,
      wizBlockquotes: document.querySelectorAll('#wysiwyg blockquote').length,
      wizUnderlines: document.querySelectorAll('#wysiwyg u, #wysiwyg ins').length,
      wizFootnotes: document.querySelectorAll('#wysiwyg .footnotes li').length
    })
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
