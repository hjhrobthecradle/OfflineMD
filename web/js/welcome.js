/* ============================================================
   welcome.js — 首启示例文档（同时是一份自检清单）
   ============================================================ */
window.WELCOME_MD = `# 欢迎使用 OfflineMD

一个**完全离线**的 Markdown 编辑器。没有账号、没有授权码、没有云端同步、没有任何后台请求——
所有渲染（公式、图表、代码高亮）都在本机的 WebView 里完成。

> 这份文档本身就是一份渲染自检清单：如果你能看到下方的公式、流程图和表格，说明渲染管线是通的。

## 快速开始

| 操作 | 快捷键 | 说明 |
|---|---|---|
| 新建 / 打开 | \`⌘N\` / \`⌘O\` | 打开文件夹后可得到左侧文件树 |
| 保存 / 另存为 | \`⌘S\` / \`⌘⇧S\` | 未命名文档会弹出保存面板 |
| 源码 / 分栏 / 预览 | \`⌘1\` / \`⌘2\` / \`⌘3\` | 三种视图随时切换 |
| 查找替换 | \`⌘F\` | 支持区分大小写、全部替换 |
| 专注模式 | \`⌥⌘F\` | 收起干扰，只留正文 |
| 打字机模式 | \`⌥⌘T\` | 光标始终保持在屏幕中部 |
| 导出 | \`⌘E\` / \`⌘⇧E\` | 单文件 HTML / 分页 PDF |

## 数学公式

行内公式：质能方程 $E = mc^2$，欧拉恒等式 $e^{i\\pi} + 1 = 0$。

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

$$
\\hat{H}\\psi = E\\psi, \\qquad
\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}
$$

矩阵与对齐：

$$
\\begin{aligned}
f(x) &= \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(0)}{n!} x^n \\\\
     &= f(0) + f'(0)x + \\frac{f''(0)}{2}x^2 + \\cdots
\\end{aligned}
$$

## 图表

\`\`\`mermaid
flowchart LR
    A[Markdown 源文] --> B{markdown-it}
    B --> C[KaTeX 公式]
    B --> D[Mermaid 图表]
    B --> E[highlight.js]
    C --> F[预览 DOM]
    D --> F
    E --> F
    F --> G[导出 HTML / PDF]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    participant U as 用户
    participant E as 编辑器
    participant N as 原生壳
    U->>E: 输入文字
    E->>E: 防抖后重新渲染
    E->>N: 写入快照
    N-->>E: 完成
\`\`\`

## 代码

\`\`\`swift
func decodePages(_ html: String, width: CGFloat) -> [CGRect] {
    // 按块级元素边界切页，避免把一行文字劈开
    let candidates = blockOffsets(html)
    return paginate(candidates, pageHeight: width * 1.414)
}
\`\`\`

\`\`\`python
def checksum(body: str, alphabet: str = "L23456789ABCDEFGHJKMNPQRSTUVWXYZ") -> str:
    out = []
    for parity in (0, 1):
        total = sum(alphabet.index(body[i + parity]) for i in range(0, 15, 2))
        out.append(alphabet[total % len(alphabet)])
    return "".join(out)
\`\`\`

行内样式：**粗体**、*斜体*、<u>下划线</u>、~~删除线~~、\`行内代码\`，按键：<kbd>⌘</kbd> + <kbd>S</kbd>。

## 列表与任务

- 无序列表
  - 嵌套一层
  - 再来一层
- 第二项

1. 有序列表
2. 第二项
3. 第三项

- [x] 移除授权校验模块
- [x] 移除自动更新（Sparkle）
- [x] 移除遥测上报
- [ ] 接入自己的主题

## 引用与脚注

> 好的工具应该在你不需要它的时候消失。
>
> 它不该在后台连网，也不该在启动时问你要授权码。

脚注示例：离线优先的设计[^1]通常意味着更小的攻击面。

[^1]: 所有资源随包分发，运行时不需要任何远端依赖。

## 表格

| 能力 | 实现方式 | 是否联网 |
|---|---|:---:|
| 公式 | KaTeX 本地渲染 | 否 |
| 图表 | Mermaid 本地渲染 | 否 |
| 代码高亮 | highlight.js | 否 |
| 图片 | 文档同级 \`assets/\` 目录 | 否 |
| 导出 PDF | WKWebView 本地排版 | 否 |

---

## 一些约定

- **图片**：直接粘贴或拖入，会存到当前文档旁的 \`assets/\` 目录，插入相对路径。
- **自动保存**：每次修改都会写一份本地快照；崩溃或异常退出后重启会提示恢复。
- **无网络**：应用内所有 \`http(s)\` 导航都被硬阻断，CSP 里 \`connect-src\` 为 \`none\`。
`;
