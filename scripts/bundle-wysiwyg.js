#!/usr/bin/env node
/**
 * 打包所见即所得内核（Milkdown/ProseMirror → 单个 IIFE）
 * KaTeX 用页面已加载的全局实例，避免重复打包 270 KB
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const esbuild = require(path.join(ROOT, '_vendor', 'node_modules', 'esbuild'));

async function main() {
  const t0 = Date.now();
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'web/src/wysiwyg.js')],
    outfile: path.join(ROOT, 'web/vendor/wysiwyg.js'),
    bundle: true,
    format: 'iife',
    globalName: 'WysiwygBundle',
    platform: 'browser',
    target: ['safari16'],
    minify: true,
    legalComments: 'none',
    nodePaths: [path.join(ROOT, '_vendor', 'node_modules')],
    alias: {
      katex: path.join(ROOT, 'web/src/katex-shim.js')
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning'
  });
  const size = fs.statSync(path.join(ROOT, 'web/vendor/wysiwyg.js')).size;
  console.log(`wysiwyg.js  ${(size / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
