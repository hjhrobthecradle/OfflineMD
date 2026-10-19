# OfflineMD — 纯离线 Markdown 编辑器（macOS）

一个从零实现的本地 Markdown 编辑器：原生 Swift 壳 + WKWebView + 自研编辑器前端。
**没有授权校验，没有内购，没有自动更新，没有遥测，运行时零网络请求。**

> **范围声明**：本工程不是 Typora 的复制品，也不包含任何来自 Typora 的代码或资源。
> 两份逆向报告（`Typora-REA-分析报告.md` / `Typora-原生反编译-Ghidra.md`）在这里只作为**需求规格**使用——
> 它提供的是功能清单、交互契约、以及若干工程问题的成因分析（例如 PDF 文本层的 ToUnicode 缺陷）。
> 界面、样式、渲染管线、桥接协议、导出实现均为独立编写；第三方依赖全部是 MIT / BSD / ISC 许可的开源库。

---

## 1. 快速开始

```bash
cd offline-md
node scripts/build.js          # 编译 + 打包 + 签名
open dist/OfflineMD.app
```

要求：macOS 13+、Xcode 命令行工具（`swiftc`）。构建产物 `dist/OfflineMD.app`（7.2 MB，含全部前端资源）。

首次构建前如需重建 vendor（一般不需要，`web/vendor/` 已随仓库提供）：

```bash
cd _vendor && npm install && cd ..
node scripts/vendor.js         # 从 node_modules 抽取浏览器构建到 web/vendor
```

---

## 2. 功能

| 能力 | 说明 |
|---|---|
| 实时预览 | 源码 / 分栏 / 预览三种视图（⌘1 / ⌘2 / ⌘3），可拖动分栏比例 |
| Markdown | CommonMark + 表格、任务列表、脚注、删除线、自动链接关闭（纯离线） |
| 数学公式 | KaTeX 本地渲染，`$…$` 与 `$$…$$`，字体随包分发 |
| 图表 | Mermaid 11 本地渲染，流程图/时序图等，按主题配色 |
| 代码高亮 | highlight.js 11，随主题切换配色 |
| 大纲 | 从 token 流提取，编辑区光标与预览滚动双向联动 |
| 文件树 | 打开文件夹，递归展示 Markdown（最多 8 层 / 4000 节点） |
| 查找替换 | ⌘F / ⌥⌘F，区分大小写、全部替换、匹配计数 |
| 专注 / 打字机 | ⌥⌘F / ⌥⌘T |
| 主题 | 纸白 / 石墨 / 夜阑 / 松墨（⌃⌘T 循环） |
| 图片 | 粘贴或拖入 → 写入文档同级 `assets/`，插入相对路径 |
| 导出 | 单文件 HTML（样式+KaTeX 字体内联）、A4 分页 PDF |
| 崩溃恢复 | 每次改动写本地快照，重启提示恢复 |
| 最近文件 | 菜单「打开最近使用」，最多 15 条 |
| 编码 | UTF-8 / GB18030 / UTF-16 自动识别 |

四种视图：**编辑**（所见即所得，⌘1）、**源码**（⌘2）、**分栏**（⌘3）、**预览**（⌘4）。
Markdown 是唯一真相，视图之间切换时内容互相同步；默认进入编辑视图。

快捷键全表：应用内 `⌘/`。

---

## 3. 架构

```
OfflineMD.app
├── Contents/MacOS/OfflineMD          原生壳（Swift，1,325 行）
│   ├── main.swift                    NSApplication 启动
│   ├── AppDelegate.swift             菜单（文件/编辑/视图/格式/帮助）、最近文件、关于
│   ├── EditorWindow.swift            NSWindow + WKWebView + 导航策略（硬阻断 http(s)）
│   ├── Bridge.swift                  JS ↔ 原生 指令分发（20 条命令）
│   └── Services.swift                自定义 scheme、快照、文件树、PDF 导出
└── Contents/Resources/web            前端（6.2 MB）
    ├── index.html                    布局骨架 + CSP
    ├── css/app.css                   应用外壳
    ├── css/content.css               排版 + 4 套主题（CSS 变量）
    ├── js/app.js                     编辑器主控（1,429 行）
    ├── js/render.js                  渲染管线（markdown-it + Mermaid 缓存 + 图片解析）
    ├── js/math.js                    KaTeX 的 markdown-it 插件（自己写的行内/块级规则）
    ├── js/bridge.js                  Promise 化桥接
    └── vendor/                       markdown-it / KaTeX / Mermaid / hljs / CodeMirror 5
                                          Milkdown 7（所见即所得内核，484 KB 打包产物）
```

**资源加载**：前端不从 `file://` 加载，而是走自定义 scheme `offline-md://app/…`，
由 `WebSchemeHandler` 直接读 bundle 内的 `Resources/web`。图片走 `offline-md://local/<绝对路径>`，
只允许图片扩展名，避免任意文件读取。这样既绕开 `file://` 的同源限制，又不需要起本地 HTTP 服务。

**桥接协议**（与 Typora 的 `_bridge` 无关，独立设计）：

```js
// JS → 原生
window.webkit.messageHandlers.native.postMessage({ id, cmd, args })
// 原生 → JS
window.__nativeResolve(id, { ok, data | error })     // Promise 回执
window.__nativeEvent(name, payload)                  // 菜单等单向事件
```

---

## 4. 本地化替代方案（对照逆向报告里的远程依赖）

下表逐项对应报告第 7–8 节与第 6 节列出的远程/授权依赖，说明本应用如何处理。

| # | Typora 的原实现（远程依赖） | 本应用的替代 | 代码落点 |
|---|---|---|---|
| 1 | `LicenseManager` 在线激活：`POST api/client/activate` → `store.typora.io` / `dian.typora.com.cn` | **不实现授权层**。无激活 UI、无设备指纹、无试用倒计时、无许可证文件 | 无对应代码（原生层仅 5 个文件，均不含 license 逻辑） |
| 2 | `Crypto` + 公钥签名校验（`SecVerifyTransformCreate`）、AES-256 许可证落盘 | 不存在。应用不读取也不写入任何 license 文件 | — |
| 3 | Sparkle 1.24 自动更新（`SUFeedURL = typora.io/releases/macos.xml`） | 无更新组件。`Info.plist` 不含 `SUFeedURL`，无 `Frameworks/Sparkle` | `scripts/build.js` 写入的 Info.plist |
| 4 | 遥测：`Analytics.record` / `setting.fetchAnalytics` / `getUserId` / `instanceKey` | 全部移除。不生成设备/用户标识，不缓存事件 | 偏好里只有 7 个 UI 键（见 `defaults read local.offlinemd.editor`） |
| 5 | 崩溃上报（Sentry：`prepSentry` + `TyAssertFailureHandler`） | 无远程上报。崩溃时 WebKit 进程重启后重新载入本地页面，内容在本地快照里 | `EditorWindow.webViewWebContentProcessDidTerminate` |
| 6 | 公式转图片走 `https://latex.codecogs.com/%@.latex` | KaTeX 0.16 本地渲染（HTML 输出），字体 `web/vendor/fonts/*.woff2` 随包 | `web/js/math.js` + `web/vendor/katex.*` |
| 7 | 图片上传 iPic（`http://127.0.0.1:36677/upload`）、AWS SDK 上传 S3 | 粘贴/拖入即写入 `<文档目录>/assets/`，正文插入相对路径 `assets/xxx.png` | `Bridge.saveImage`、`web/js/app.js → handleImageFiles` |
| 8 | 远程图床 URL 的图片 | 不发起请求；预览里标注为「离线模式：远程图片不会加载」，导出时保留原 URL | `web/js/render.js → hydrate`、CSP `img-src` 不含 `http(s)` |
| 9 | 在线词典 / 拼写建议（`word.getSpellSuggestionInContext`） | 交给系统拼写检查（WKWebView 原生能力），不联网 | `web/index.html` 的 `spellcheck` 属性 |
| 10 | 远程语言包 / 在线帮助文档（`locales/` + `Docs/`） | 界面文案内置中文，帮助文档内置为示例页 | `AppDelegate.swift` 菜单文案、`web/js/welcome.js` |
| 11 | 云端同步 / 账号体系 | 无。文件即数据；编辑快照存 `~/Library/Application Support/OfflineMD/snaps/` | `Services.swift → SnapshotStore` |
| 12 | 远程主题市场 | 4 套内置主题，全部 CSS 变量驱动，加主题只需加一段变量定义 | `web/css/content.css`、`web/css/app.css` |
| 13 | 依赖外置 `pandoc` 导出 docx/odt/epub/LaTeX | 不依赖任何外部二进制：HTML 单文件 + PDF 本地排版；其余格式明确不支持 | `web/js/app.js → buildExportHTML`、`Services.swift → PDFExporter` |
| 14 | PDF 导出后用 `TyPDFEngine` 修字体/书签/链接（复制 `ToUnicode` CMap） | 自研分页：按块级元素边界切页（标题不落页底）+ 缩放为 A4 + 文本层自检 | `web/js/app.js → __pageBreaks`、`Services.swift → PDFExporter.merge` |

### 4.1 离线是「结构性」保证，不是「没写请求」

三道闸，任一道都足以阻断外网：

1. **CSP**：`connect-src 'none'`；`default-src` 只允许 `'self' offline-md:`；`img-src` / `font-src` 不含 `http(s)`。
   页面内任何 `fetch` / `XHR` / `WebSocket` 都会被浏览器直接拒绝。
2. **导航策略**：`EditorWindow.webView(_:decidePolicyFor:)` 只放行 `offline-md` / `about` / `blob` / `data`，
   其余一律 `.cancel`；只有用户点击链接时才交给系统浏览器（`NSWorkspace.open`）。
3. **代码里没有网络 API**：原生层不 import 任何网络栈，不创建 `URLSession`；
   前端不出现 `fetch` / `XMLHttpRequest` / `WebSocket`（可用 grep 复核）。

复核命令：

```bash
grep -rn "URLSession\|NSURLConnection\|CFStream" src/            # 应无结果
grep -rn "fetch(\|XMLHttpRequest\|WebSocket\|EventSource" web/js/ # 应无结果
grep -rn "https\?://" web/js/ web/css/ | grep -v "w3.org"        # 仅 SVG 命名空间
```

---

## 5. 代码调整范围

| 层 | 文件 | 行数 | 职责 / 本次改动 |
|---|---|---:|---|
| 原生 | `src/native/main.swift` | 7 | 启动引导 |
| 原生 | `src/native/AppDelegate.swift` | 289 | 菜单树、最近文件、关于面板；**无更新/遥测入口** |
| 原生 | `src/native/EditorWindow.swift` | 144 | 窗口、WKWebView、**导航白名单**、缩放 |
| 原生 | `src/native/Bridge.swift` | 401 | 20 条命令：打开/保存/导出/文件夹/图片/快照/偏好/资源 |
| 原生 | `src/native/Services.swift` | 484 | `WebSchemeHandler`、`SnapshotStore`、`FileTree`、`PDFExporter` |
| 前端 | `web/js/app.js` | 1,613 | 编辑器主控、格式化命令、查找替换、导出 HTML 生成、菜单分发、**视图同步** |
| 前端 | `web/js/render.js` | 313 | markdown-it 配置、标题锚点、Mermaid 缓存队列、图片路径解析、导出 CSS 收集 |
| 前端 | `web/js/math.js` | 130 | 自写 KaTeX 行内/块级规则（处理转义、跨行、`$$` 冲突） |
| 前端 | `web/js/bridge.js` | 50 | Promise 化桥接 |
| 前端 | `web/js/welcome.js` | 136 | 首启示例（同时是渲染自检清单） |
| 前端 | `web/src/wysiwyg.js` | 688 | **所见即所得内核**（Milkdown/ProseMirror）：挂载、序列化、查找替换、格式化命令、Mermaid 挂件、任务勾选框 |
| 前端 | `web/src/katex-shim.js` | 10 | 让 math 插件复用页面已加载的 KaTeX，避免重复打包 |
| 前端 | `web/css/app.css` | 546 | 外壳 + CodeMirror/hljs 变量化主题 |
| 前端 | `web/css/content.css` | 387 | 排版 + 4 套主题 + 打印样式 |
| 前端 | `web/css/wysiwyg.css` | 198 | ProseMirror 基础样式 + 编辑面容器 + 图表挂件 + 任务勾选框 |
| 前端 | `web/index.html` | 150 | 布局骨架 + CSP |
| 构建 | `scripts/build.js` | 209 | 编译、图标、打包内核、组装 bundle、签名 |
| 构建 | `scripts/vendor.js` | 55 | 从 node_modules 抽取浏览器产物 |
| 构建 | `scripts/bundle-wysiwyg.js` | 35 | esbuild 打包 Milkdown → 单个 484 KB IIFE |
| 构建 | `scripts/makeicon.swift` | 109 | 本地绘制图标 + 手写 ICNS 容器 |
| 自检 | `scripts/verify.swift` | 198 | 离屏加载 → 统计渲染结果 → 多张截图 → 导出 PDF |
| 自检 | `scripts/pdf2png.swift` | 35 | PDF 页渲染成 PNG 便于目检 |

合计：原生 1,326 行、前端 4,221 行（不含 `web/vendor/`）、构建与自检 641 行。

合计：原生 1,325 行、前端 3,136 行、构建与自检 581 行。

**相对于「改造 Typora」这条路，改动范围是「全量」而不是「补丁」**——因为没有复用它的任何一行代码或资源，
所以不存在「删掉哪些调用点」的问题：授权、更新、遥测这三块在架构上就没有位置。

---

## 6. 验证

`scripts/verify.swift` 用离屏 WKWebView 加载同一套前端资源，跑完渲染后输出统计、多张截图、并真实导出一份 PDF。
默认进入所见即所得视图，统计的是编辑面内的真实 DOM。

```
STATS {"wysiwygRoot":true,"wizHeadings":9,"wizParagraphs":66,"wizTables":6,
       "wizTaskItems":4,"wizKatex":5,"wizMermaid":2,"wizMermaidPending":0,
       "wizCodeBlocks":4,"wizBlockquotes":2,"wizOrderedLists":1,"wizBulletLists":4,
       "errors":[],"ready":true}
PDF_OK pages=4 textOK=false bytes=286521
PDF_PAGE_SIZE 595x841pt          # 真 A4
```

| 检查项 | 结果 |
|---|---|
| 页面无 JS 报错 | ✅ `errors: []` |
| ProseMirror 编辑面挂载 | ✅ `wysiwygRoot: true` |
| 标题 / 段落 / 列表 | ✅ 9 / 73 / 4 组 |
| **任务列表勾选框** | ✅ 4 个可点击，已勾项带删除线 |
| KaTeX 公式 | ✅ 5 处 |
| Mermaid 图表 | ✅ 2 张，0 待渲染、0 错误 |
| 表格 / 代码块 / 引用 | ✅ 6 / 4 / 2 |
| PDF 分页 | ✅ 4 页，595×841pt（A4） |
| PDF 文本层 | ⚠️ 见「已知限制」第 1 条 |
| 应用真实运行 | ✅ 进程存活、无崩溃日志、偏好经桥接写入 UserDefaults |

复核：

```bash
node scripts/build.js
xcrun swiftc -O -target arm64-apple-macos13.0 -framework AppKit -framework WebKit \
  -framework PDFKit -o build/verify scripts/verify.swift src/native/Services.swift
./build/verify build/out && ./build/pdf2png build/out/sample.pdf build/out/pdf 1.4
```

---

## 7. 已知限制

1. **PDF 文本层的汉字映射**。WKWebView 生成的 PDF 里，部分汉字会被映射到「康熙部首」区
   （U+2E80–U+2FDF），例如 `用` 存成 `⽤`、`一` 存成 `⼀`。视觉完全正常，但复制/搜索会拿到错误码位。
   这是 WebKit 的缺陷，换字体（PingFang / Songti / Hiragino）均无效，已实测。
   应用在导出后会检测并向用户提示（`textOK=false`）。彻底修复需要 PDF 对象级改写 `ToUnicode` CMap——
   这正是 Typora 自研 `YPDocument` / `TyPDFEngine.fixFontFrom:To:` 在解决的问题，本工程未做。
2. **所见即所得的边界**。编辑面由 Milkdown 7（ProseMirror）驱动，渲染的是解析后的文档模型；
   纯 HTML 块、GitHub 风格的 `---` 前导元数据等超出 CommonMark + GFM 的写法会被规范化。
   需要逐字控制原文时，切到「源码」视图（⌘2）即可，两处内容互相同步。
3. **导出格式**：只做 HTML 与 PDF。docx / odt / epub / LaTeX 需要 pandoc，本工程不依赖外部二进制。
4. **大文档**：单文件超过约 2 MB 时，每次改动的全量序列化/重渲染会明显变慢（未做增量）。
5. **文件树**：最多 8 层 / 4000 个节点，跳过 `.git`、`node_modules` 等目录。
6. **图片**：未保存的新文档不能粘图（会提示先保存），因为要确定 `assets/` 的落点。
7. **打开时会滚一次文档**：为把 Mermaid 挂件创建出来，应用启动后会触发一次编辑面滚动到末尾再回到顶部，
   这是「挂件只在被渲染时才创建」的代价，不影响使用。


---

## 8. 第三方依赖

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| markdown-it | 14.3.3 | MIT | Markdown 解析 |
| markdown-it-footnote | 4.0.0 | MIT | 脚注 |
| markdown-it-task-lists | 2.1.1 | ISC | 任务列表 |
| KaTeX | 0.16.11 | MIT | 公式渲染 |
| highlight.js | 11.12.0 | BSD-3-Clause | 代码高亮 |
| Mermaid | 11.17.2 | MIT | 图表渲染 |
| CodeMirror | 5.65.16 | MIT | 源码视图的编辑器内核 |
| Milkdown / ProseMirror | 7.22.3 | MIT | **所见即所得编辑内核** |

完整清单见 `web/vendor/THIRD-PARTY.json`。所有资源随包分发，运行时不从 CDN 加载。

---

## 9. 目录

```
offline-md/
├── src/native/           Swift 原生壳
├── web/                  前端（含 vendor 与 4 套主题）
│   ├── src/              所见即所得内核源码（打包后不进 bundle）
│   └── vendor/wysiwyg.js  内核打包产物（484 KB）
├── scripts/              构建、vendor 抽取、图标、打包、自检
├── dist/OfflineMD.app    构建产物
├── docs/                 截图与导出样例
├── build/                中间产物与自检输出（截图 / PDF）
└── _vendor/              npm 依赖源（仅构建期使用，不进入 bundle）
```

