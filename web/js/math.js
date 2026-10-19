/* ============================================================
   math.js — markdown-it 数学公式插件（KaTeX 本地渲染，无远程服务）
   支持 $...$ / $$...$$（Typora 的默认语法）
   ============================================================ */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderTex(tex, display) {
    try {
      return window.katex.renderToString(tex, {
        displayMode: !!display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'html',
        macros: { '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}' }
      });
    } catch (e) {
      return '<span class="math-error">' + escapeHtml(tex) + '</span>';
    }
  }

  function mathPlugin(md) {
    // ---- 块级 $$ ... $$ ----
    function blockRule(state, startLine, endLine, silent) {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (start + 2 > max) return false;
      if (state.src.slice(start, start + 2) !== '$$') return false;
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;

      let nextLine = startLine;
      let body = state.src.slice(start + 2, max);
      let closed = false;
      const trimmed = body.trim();

      if (trimmed.length >= 2 && trimmed.endsWith('$$')) {
        body = trimmed.slice(0, -2);
        closed = true;
      } else if (trimmed === '$$') {
        body = '';
        closed = true;
      } else {
        const lines = [body];
        for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
          const ls = state.bMarks[nextLine] + state.tShift[nextLine];
          const le = state.eMarks[nextLine];
          const line = state.src.slice(ls, le);
          const t = line.trim();
          if (t.endsWith('$$')) {
            lines.push(t.slice(0, -2));
            closed = true;
            break;
          }
          lines.push(line);
        }
        if (!closed) return false;
        body = lines.join('\n');
      }

      if (silent) return true;

      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = body;
      token.markup = '$$';
      token.map = [startLine, nextLine + 1];
      state.line = nextLine + 1;
      return true;
    }

    // ---- 行内 $ ... $ ----
    function inlineRule(state, silent) {
      const src = state.src;
      const start = state.pos;
      if (src.charCodeAt(start) !== 0x24) return false;                 // '$'
      if (start > 0 && src.charCodeAt(start - 1) === 0x5c) return false; // 被转义
      const next = src.charCodeAt(start + 1);
      if (Number.isNaN(next) || next === 0x20 || next === 0x09 || next === 0x0a) return false;
      if (next === 0x24) return false;                                   // '$$' 交给块级

      let pos = start + 1;
      let close = -1;
      while (pos < src.length) {
        const ch = src.charCodeAt(pos);
        if (ch === 0x5c) { pos += 2; continue; }
        if (ch === 0x0a) {
          // 允许跨行，但不允许空行
          if (src.charCodeAt(pos + 1) === 0x0a) break;
          pos++;
          continue;
        }
        if (ch === 0x24) {
          const prev = src.charCodeAt(pos - 1);
          if (prev === 0x20 || prev === 0x09 || prev === 0x0a) { pos++; continue; }
          if (src.charCodeAt(pos + 1) === 0x24) { pos += 2; continue; }
          close = pos;
          break;
        }
        pos++;
      }
      if (close < 0) return false;

      const tex = src.slice(start + 1, close);
      if (!tex.trim() || tex.length > 800) return false;

      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.content = tex;
        token.markup = '$';
      }
      state.pos = close + 1;
      return true;
    }

    md.inline.ruler.before('escape', 'math_inline', inlineRule);
    md.block.ruler.before('fence', 'math_block', blockRule, {
      alt: ['paragraph', 'reference', 'blockquote', 'list']
    });

    md.renderer.rules.math_inline = (tokens, idx) => renderTex(tokens[idx].content, false);
    md.renderer.rules.math_block = (tokens, idx) => '<div class="math-block">' + renderTex(tokens[idx].content, true) + '</div>';
  }

  window.MathPlugin = mathPlugin;
})();
