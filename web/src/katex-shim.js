/* ============================================================
   katex-shim.js — 让 @milkdown/plugin-math 复用页面已加载的 katex 全局
   （避免把 270 KB 的 KaTeX 再打包一遍）
   ============================================================ */
const k = window.katex;

export default k;
export const render = (...args) => k.render(...args);
export const renderToString = (...args) => k.renderToString(...args);
export const version = k.version;
