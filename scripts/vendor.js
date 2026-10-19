// 把 _vendor/node_modules 里需要的浏览器产物抽取到 web/vendor（离线自包含）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const N = path.join(ROOT, '_vendor', 'node_modules');
const OUT = path.join(ROOT, 'web', 'vendor');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function copy(src, dst) {
  mkdirp(path.dirname(dst));
  fs.copyFileSync(src, dst);
  const st = fs.statSync(dst);
  console.log(`  ${path.relative(ROOT, dst).padEnd(46)} ${(st.size / 1024).toFixed(0)} KB`);
}
function copyDir(src, dst) {
  mkdirp(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else copy(s, d);
  }
}

mkdirp(OUT);
console.log('抽取 vendor:');

copy(path.join(N, 'markdown-it/dist/markdown-it.min.js'), path.join(OUT, 'markdown-it.min.js'));
copy(path.join(N, 'markdown-it-footnote/dist/markdown-it-footnote.min.js'), path.join(OUT, 'markdown-it-footnote.min.js'));
copy(path.join(N, 'markdown-it-task-lists/dist/markdown-it-task-lists.min.js'), path.join(OUT, 'markdown-it-task-lists.min.js'));
copy(path.join(N, 'katex/dist/katex.min.js'), path.join(OUT, 'katex.min.js'));
copy(path.join(N, 'katex/dist/katex.min.css'), path.join(OUT, 'katex.min.css'));
copyDir(path.join(N, 'katex/dist/fonts'), path.join(OUT, 'fonts'));
copy(path.join(N, '@highlightjs/cdn-assets/highlight.min.js'), path.join(OUT, 'highlight.min.js'));
copy(path.join(N, 'mermaid/dist/mermaid.min.js'), path.join(OUT, 'mermaid.min.js'));

const cm = path.join(OUT, 'cm');
copy(path.join(N, 'codemirror/lib/codemirror.js'), path.join(cm, 'codemirror.js'));
copy(path.join(N, 'codemirror/lib/codemirror.css'), path.join(cm, 'codemirror.css'));
for (const m of ['markdown', 'xml', 'javascript', 'css', 'clike', 'yaml', 'python', 'shell', 'sql']) {
  copy(path.join(N, 'codemirror/mode', m, m + '.js'), path.join(cm, m + '.js'));
}
for (const a of ['edit/continuelist', 'edit/closebrackets', 'selection/active-line', 'search/searchcursor', 'display/placeholder']) {
  copy(path.join(N, 'codemirror/addon', a + '.js'), path.join(cm, path.basename(a) + '.js'));
}

// 版本与许可清单（离线可查的合规信息）
const pkgs = ['markdown-it', 'markdown-it-footnote', 'markdown-it-task-lists', 'katex', 'highlight.js', '@highlightjs/cdn-assets', 'mermaid', 'codemirror'];
const rows = pkgs.map(p => {
  const j = JSON.parse(fs.readFileSync(path.join(N, p, 'package.json'), 'utf8'));
  return { name: j.name, version: j.version, license: j.license || 'see LICENSE' };
});
fs.writeFileSync(path.join(OUT, 'THIRD-PARTY.json'), JSON.stringify(rows, null, 2));
console.log('\n第三方清单:'); rows.forEach(r => console.log(`  ${r.name}@${r.version}  ${r.license}`));
const total = rows.length && fs.readdirSync(OUT);
console.log('\n完成');
