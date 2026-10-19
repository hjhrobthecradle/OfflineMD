#!/usr/bin/env node
/**
 * 构建 OfflineMD.app
 *   1. 编译 Swift 原生壳
 *   2. 生成本地图标
 *   3. 组装 bundle（含 web/ 资源）
 *   4. ad-hoc 签名
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'OfflineMD.app');
const CONTENTS = path.join(APP, 'Contents');
const MACOS = path.join(CONTENTS, 'MacOS');
const RES = path.join(CONTENTS, 'Resources');

const step = m => console.log('\n\x1b[1m▸ ' + m + '\x1b[0m');
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    throw new Error(`${cmd} 失败（exit ${e.status}）`);
  }
};

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

// 逐项删除（可选，--clean 时使用；失败不影响构建）
function removeTree(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function du(dir) {
  let total = 0;
  const walk = p => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else total += fs.statSync(f).size;
    }
  };
  walk(dir);
  return (total / 1048576).toFixed(1) + ' MB';
}

// ---------- 目录 ----------
step('准备目录');
if (process.argv.includes('--clean')) {
  try { removeTree(APP); console.log('  已清理旧 bundle'); }
  catch (e) { console.log('  清理被系统策略拦截，改为就地覆盖'); }
}
fs.mkdirSync(MACOS, { recursive: true });
fs.mkdirSync(RES, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });
console.log('  ok');

// ---------- 编译 ----------
step('编译 Swift 原生壳');
const sources = fs.readdirSync(path.join(ROOT, 'src/native'))
  .filter(f => f.endsWith('.swift'))
  .map(f => path.join('src/native', f));
const binPath = path.join(MACOS, 'OfflineMD');
const t0 = Date.now();
const ccOut = run('xcrun', [
  'swiftc', '-swift-version', '5', '-O',
  '-target', 'arm64-apple-macos13.0',
  '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'PDFKit',
  '-o', binPath, ...sources
], { cwd: ROOT });
if (ccOut.trim()) console.log(ccOut.trim());
console.log(`  ${sources.length} 个源文件，${((Date.now() - t0) / 1000).toFixed(1)}s，${(fs.statSync(binPath).size / 1048576).toFixed(1)} MB`);

// ---------- 图标 ----------
step('生成图标');
const iconBin = path.join(BUILD, 'makeicon');
run('xcrun', ['swiftc', '-O', '-o', iconBin, 'scripts/makeicon.swift'], { cwd: ROOT });
const iconDir = path.join(BUILD, 'icon');
fs.mkdirSync(iconDir, { recursive: true });
run(iconBin, [iconDir]);

const icns = path.join(BUILD, 'AppIcon.icns');
if (fs.existsSync(icns)) {
  fs.copyFileSync(icns, path.join(RES, 'AppIcon.icns'));
  console.log('  AppIcon.icns ' + (fs.statSync(icns).size / 1024).toFixed(0) + ' KB');
} else {
  console.log('  图标生成跳过');
}

// ---------- 所见即所得内核 ----------
step('打包所见即所得内核');
run(process.execPath, ['scripts/bundle-wysiwyg.js'], { cwd: ROOT });
const wizPath = path.join(ROOT, 'web/vendor/wysiwyg.js');
if (fs.existsSync(wizPath)) console.log('  vendor/wysiwyg.js ' + (fs.statSync(wizPath).size / 1024).toFixed(0) + ' KB');

// ---------- 资源 ----------
step('拷贝前端资源');
// src/ 与 katex-shim.js 只参与打包，不进 bundle（bundle 已含内核逻辑）
copyDir(path.join(ROOT, 'web'), path.join(RES, 'web'),
  name => name === 'src' || name === 'katex-shim.js');
console.log('  web/ → Resources/web  ' + du(path.join(RES, 'web')));

// ---------- Info.plist ----------
step('写入 Info.plist');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>zh_CN</string>
	<key>CFBundleExecutable</key>
	<string>OfflineMD</string>
	<key>CFBundleIdentifier</key>
	<string>local.offlinemd.editor</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>OfflineMD</string>
	<key>CFBundleDisplayName</key>
	<string>OfflineMD</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.productivity</string>
	<key>NSHumanReadableCopyright</key>
	<string>本地构建 · 无授权校验 · 无网络请求</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<false/>
	</dict>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Markdown 文档</string>
			<key>CFBundleTypeRole</key>
			<string>Editor</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>net.daringfireball.markdown</string>
				<string>public.plain-text</string>
			</array>
			<key>CFBundleTypeExtensions</key>
			<array>
				<string>md</string>
				<string>markdown</string>
				<string>mdown</string>
				<string>mkd</string>
				<string>txt</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
fs.writeFileSync(path.join(CONTENTS, 'Info.plist'), plist);
fs.writeFileSync(path.join(CONTENTS, 'PkgInfo'), 'APPL????');
console.log('  ok');

// ---------- 签名 ----------
step('ad-hoc 签名');
try {
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', APP]);
  const verify = run('codesign', ['-dv', '--verbose=2', APP]);
  console.log('  ' + verify.split('\n').filter(Boolean).slice(-2).join(' | '));
} catch (e) {
  console.log('  签名未完成（应用仍可本地运行）');
}

// ---------- 汇总 ----------
step('完成');
console.log('  产物: ' + path.relative(ROOT, APP));
console.log('  体积: ' + du(APP));
console.log('  运行: open "' + APP + '"');
