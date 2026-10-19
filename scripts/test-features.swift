import Foundation
import AppKit
import WebKit

final class FeatureTester: NSObject, WKNavigationDelegate {
    var webView: WKWebView!
    var schemeHandler: WebSchemeHandler!

    func start() {
        let config = WKWebViewConfiguration()
        schemeHandler = WebSchemeHandler(webRoot: Paths.webRoot)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: WebSchemeHandler.scheme)
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let ucc = WKUserContentController()
        let hook = """
        window.__errors = [];
        window.addEventListener('error', function (e) {
            window.__errors.push('error: ' + (e.message || ''));
        });
        window.addEventListener('unhandledrejection', function (e) {
            window.__errors.push('rejection: ' + (e.reason && (e.reason.message || e.reason) || ''));
        });
        """
        ucc.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc

        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
        webView.navigationDelegate = self

        let win = NSWindow(contentRect: webView.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = webView
        win.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        win.orderBack(nil)

        webView.load(URLRequest(url: URL(string: "offline-md://app/index.html")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
            self.runTests()
        }
    }

    func runTests() {
        let testScript = """
        (async function() {
            const results = [];
            function assert(desc, cond, extra) {
                results.push({ desc: desc, ok: !!cond, extra: extra || '' });
            }

            // 1. 测试 markdown-it 渲染下划线
            try {
                const uHtml = Renderer.render("文本 <u>下划线内容</u> 结束").html;
                assert("Renderer: 渲染 <u> 标签", uHtml.includes('<u>下划线内容</u>'), uHtml);

                const insHtml = Renderer.render("文本 ++加号下划线++ 结束").html;
                assert("Renderer: 渲染 ++下划线++ 语法", insHtml.includes('<u>加号下划线</u>'), insHtml);
            } catch(e) {
                assert("Renderer 渲染下划线异常", false, e.message);
            }

            // 2. 测试 WYSIWYG 内核载入下划线与序列化
            try {
                const testDoc = "这是 <u>HTML下划线</u> 以及 ++加号下划线++ 正文。";
                window.__editor.setValue(testDoc);
                await new Promise(r => setTimeout(r, 600));

                const uEls = document.querySelectorAll('#wysiwyg u, #wysiwyg ins');
                assert("WYSIWYG: 渲染 DOM 包含 <u> 节点", uEls.length >= 2, '找到 ' + uEls.length + ' 个');

                if (uEls.length >= 2) {
                    assert("WYSIWYG: 下划线文本内容匹配", uEls[0].textContent.includes('HTML下划线') && uEls[1].textContent.includes('加号下划线'), uEls[0].textContent + ' | ' + uEls[1].textContent);
                    const style0 = window.getComputedStyle(uEls[0]);
                    assert("WYSIWYG: 节点具有 text-decoration underline 样式", style0.textDecoration.includes('underline'), style0.textDecoration);
                }

                const savedMd = window.__editor.getValue();
                assert("WYSIWYG: 序列化回 Markdown 包含 <u>", savedMd.includes('<u>HTML下划线</u>') && savedMd.includes('<u>加号下划线</u>'), savedMd);
            } catch(e) {
                assert("WYSIWYG 下划线测试异常", false, e.message);
            }

            // 3. 测试 源码模式下划线命令
            try {
                window.__debug.setView('source');
                await new Promise(r => setTimeout(r, 300));

                window.__editor.setValue("测试选中文字格式化");
                window.__editor.focus();
                const cm = window.CodeMirror && document.querySelector('.CodeMirror').CodeMirror;
                if (cm) {
                    cm.setSelection({ line: 0, ch: 2 }, { line: 0, ch: 6 }); // 选中 "选中文字"
                    window.__nativeMenu('format.underline');
                    const val = cm.getValue();
                    assert("源码视图: 菜单下划线包裹", val.includes('<u>选中文字</u>'), val);

                    // 再次执行 format.underline 进行反选/清除
                    cm.setSelection({ line: 0, ch: 2 }, { line: 0, ch: 13 }); // 选中 "<u>选中文字</u>"
                    window.__nativeMenu('format.underline');
                    const unwrapped = cm.getValue();
                    assert("源码视图: 再次触发下划线移除包裹", unwrapped === '测试选中文字格式化', unwrapped);
                } else {
                    assert("源码视图: CodeMirror 实例存在", false);
                }

                window.__debug.setView('wysiwyg');
                await new Promise(r => setTimeout(r, 400));
            } catch(e) {
                assert("源码视图下划线命令测试异常", false, e.message);
            }

            // 4. 测试其他格式化命令 (bold, italic, strike, code)
            try {
                window.__debug.setView('source');
                await new Promise(r => setTimeout(r, 200));
                const cm = document.querySelector('.CodeMirror').CodeMirror;

                cm.setValue("hello");
                cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
                window.__nativeMenu('format.bold');
                assert("格式化: 粗体", cm.getValue() === '**hello**', cm.getValue());

                cm.setValue("hello");
                cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
                window.__nativeMenu('format.italic');
                assert("格式化: 斜体", cm.getValue() === '*hello*', cm.getValue());

                cm.setValue("hello");
                cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
                window.__nativeMenu('format.strike');
                assert("格式化: 删除线", cm.getValue() === '~~hello~~', cm.getValue());

                cm.setValue("hello");
                cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
                window.__nativeMenu('format.code');
                assert("格式化: 行内代码", cm.getValue() === '`hello`', cm.getValue());

                window.__debug.setView('wysiwyg');
                await new Promise(r => setTimeout(r, 300));
            } catch(e) {
                assert("其他格式化测试异常", false, e.message);
            }

            // 5. 测试视图切换
            try {
                window.__debug.setView('source');
                assert("视图切换: 源码视图激活", document.getElementById('app').classList.contains('view-editor'));

                window.__debug.setView('split');
                assert("视图切换: 分栏视图激活", document.getElementById('app').classList.contains('view-split'));

                window.__debug.setView('preview');
                assert("视图切换: 预览视图激活", document.getElementById('app').classList.contains('view-preview'));

                window.__debug.setView('wysiwyg');
                assert("视图切换: 所见即所得视图激活", document.getElementById('app').classList.contains('view-wysiwyg'));
            } catch(e) {
                assert("视图切换测试异常", false, e.message);
            }

            // 6. 测试主题切换
            try {
                window.__debug.setTheme('graphite');
                assert("主题切换: graphite", document.documentElement.dataset.theme === 'graphite');

                window.__debug.setTheme('night');
                assert("主题切换: night", document.documentElement.dataset.theme === 'night');

                window.__debug.setTheme('moss');
                assert("主题切换: moss", document.documentElement.dataset.theme === 'moss');

                window.__debug.setTheme('paper');
                assert("主题切换: paper", document.documentElement.dataset.theme === 'paper');
            } catch(e) {
                assert("主题切换测试异常", false, e.message);
            }

            // 7. 测试 HTML 导出生成
            try {
                const exportHtml = await window.__debug.buildExportHTML(false);
                assert("HTML 导出: 包含完整内容和样式", exportHtml.includes('<!DOCTYPE html>') && exportHtml.includes('markdown-body'), 'Length: ' + exportHtml.length);
            } catch(e) {
                assert("HTML 导出测试异常", false, e.message);
            }

            // 8. 测试 WYSIWYG 动态下划线格式化切换
            try {
                window.__debug.setView('wysiwyg');
                await new Promise(r => setTimeout(r, 300));
                window.__editor.setValue("所见即所得动态测试文本");
                await new Promise(r => setTimeout(r, 500));

                const pm = document.querySelector('#wysiwyg .ProseMirror');
                if (pm) {
                    // 在 ProseMirror 中选中 "动态测试" (位置 6 到 10)
                    window.__debug.selectRange(6, 10);
                    await new Promise(r => setTimeout(r, 100));

                    // 执行下划线格式化
                    window.__nativeMenu('format.underline');
                    await new Promise(r => setTimeout(r, 300));

                    const uNode = pm.querySelector('u');
                    assert("WYSIWYG 交互: 选区触发下划线成功生成 <u>", !!uNode && uNode.textContent.includes('动态测试'), uNode ? uNode.outerHTML : 'none');

                    const serializedWithU = window.__editor.getValue();
                    assert("WYSIWYG 交互: 动态下划线序列化为 <u>动态测试</u>", serializedWithU.includes('<u>动态测试</u>'), serializedWithU);

                    // 再次执行下划线进行取消
                    window.__debug.selectRange(6, 10);
                    await new Promise(r => setTimeout(r, 100));
                    window.__nativeMenu('format.underline');
                    await new Promise(r => setTimeout(r, 300));

                    const uNodeAfter = pm.querySelector('u');
                    assert("WYSIWYG 交互: 再次触发下划线取消下划线", !uNodeAfter, uNodeAfter ? uNodeAfter.outerHTML : 'removed');
                } else {
                    assert("WYSIWYG 容器存在", false);
                }
            } catch(e) {
                assert("WYSIWYG 动态格式化测试异常", false, e.message);
            }

            // 9. 测试任务列表勾选与 Markdown 同步
            try {
                window.__editor.setValue(["- [ ] 未完成任务", "- [x] 已完成任务"].join("\\n"));
                await new Promise(r => setTimeout(r, 500));

                const cbs = document.querySelectorAll('#wysiwyg input.task-checkbox');
                assert("任务列表: 渲染出 2 个勾选框", cbs.length === 2, '找到 ' + cbs.length);
                if (cbs.length >= 2) {
                    assert("任务列表: 初始勾选状态正确", !cbs[0].checked && cbs[1].checked);

                    // 点击第一个勾选框
                    cbs[0].click();
                    await new Promise(r => setTimeout(r, 300));

                    const mdAfterCheck = window.__editor.getValue();
                    assert("任务列表: 点击后 Markdown 同步为 [x]", mdAfterCheck.includes('- [x] 未完成任务'), mdAfterCheck);
                }
            } catch(e) {
                assert("任务列表测试异常", false, e.message);
            }

            // 10. 测试 KaTeX 和 Mermaid 渲染
            try {
                window.__editor.setValue(["公式 $E = mc^2$ 演示", "", "```mermaid", "flowchart LR", "  A --> B", "```"].join("\\n"));
                await new Promise(r => setTimeout(r, 1200));

                const katexEl = document.querySelector('#wysiwyg .katex');
                assert("KaTeX: 公式渲染成功", !!katexEl, katexEl ? katexEl.className : 'none');

                const mmdEl = document.querySelector('#wysiwyg .mmd-live');
                assert("Mermaid: 图表容器挂载成功", !!mmdEl, mmdEl ? mmdEl.className : 'none');
            } catch(e) {
                assert("KaTeX / Mermaid 测试异常", false, e.message);
            }

            window.__testResult = JSON.stringify({
                results: results,
                errors: window.__errors || []
            });
        })();
        'started';
        """

        webView.evaluateJavaScript(testScript) { _, err in
            if let err = err as NSError? {
                print("TEST_FATAL_ERROR: \(err.localizedDescription) | \(err.userInfo)")
                exit(1)
            }
            self.waitForResults(attempt: 0)
        }
    }

    func waitForResults(attempt: Int) {
        if attempt > 40 {
            print("TEST_TIMEOUT")
            exit(1)
        }
        webView.evaluateJavaScript("window.__testResult || ''") { res, err in
            guard let jsonStr = res as? String, !jsonStr.isEmpty else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.waitForResults(attempt: attempt + 1)
                }
                return
            }
            guard let data = jsonStr.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = obj["results"] as? [[String: Any]],
                  let errors = obj["errors"] as? [String] else {
                print("TEST_PARSE_FAIL: \(res ?? "nil")")
                exit(1)
            }

            var passCount = 0
            var failCount = 0
            print("================ TEST RESULTS ================")
            for item in list {
                let desc = item["desc"] as? String ?? ""
                let ok = item["ok"] as? Bool ?? false
                let extra = item["extra"] as? String ?? ""
                if ok {
                    passCount += 1
                    print("✅ PASS: \(desc)")
                } else {
                    failCount += 1
                    print("❌ FAIL: \(desc) (extra: \(extra))")
                }
            }
            print("==============================================")
            print("Total: \(list.count) | Passed: \(passCount) | Failed: \(failCount)")
            if !errors.isEmpty {
                print("Page errors during test: \(errors)")
            }
            if failCount > 0 {
                exit(1)
            } else {
                print("ALL_TESTS_PASSED")
                exit(0)
            }
        }
    }
}

@main
struct TesterMain {
    static func main() {
        setvbuf(stdout, nil, _IONBF, 0)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let t = FeatureTester()
        t.start()
        app.run()
    }
}
