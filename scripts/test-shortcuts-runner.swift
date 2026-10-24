import Foundation
import AppKit
import WebKit

// MARK: - Native Menu Inspector

final class MenuInspector {
    static func inspectMenu() -> (items: [String: NSMenuItem], allShortcuts: [(menu: String, title: String, key: String, mods: NSEvent.ModifierFlags)]) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let appDelegate = AppDelegate()
        NSApp.delegate = appDelegate
        appDelegate.buildMenu()
        let main = NSApp.mainMenu!
        var itemMap = [String: NSMenuItem]()
        var shortcuts = [(menu: String, title: String, key: String, mods: NSEvent.ModifierFlags)]()

        func walk(menu: NSMenu, path: String) {
            for item in menu.items {
                let currentPath = path.isEmpty ? item.title : "\(path) > \(item.title)"
                itemMap[currentPath] = item
                if !item.keyEquivalent.isEmpty {
                    shortcuts.append((menu: path, title: item.title, key: item.keyEquivalent, mods: item.keyEquivalentModifierMask))
                }
                if let sub = item.submenu {
                    walk(menu: sub, path: currentPath)
                }
            }
        }
        walk(menu: main, path: "")
        return (itemMap, shortcuts)
    }
}

// MARK: - Web Test Runner

final class HeadlessRunner: NSObject, WKNavigationDelegate {
    var win: NSWindow!
    var webView: WKWebView!
    var schemeHandler: WebSchemeHandler!
    var testBlock: ((WKWebView) -> Void)?

    func run(test: @escaping (WKWebView) -> Void) {
        self.testBlock = test
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

        win = NSWindow(contentRect: webView.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = webView
        win.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        win.orderBack(nil)

        webView.load(URLRequest(url: URL(string: "offline-md://app/index.html")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.testBlock?(webView)
        }
    }
}

// MARK: - Main

@main
struct ShortcutsTestRunner {
    static func main() {
        let args = CommandLine.arguments

        if args.contains("--test-native-menu") {
            let (items, _) = MenuInspector.inspectMenu()

            var passed = true
            func check(_ name: String, _ cond: Bool, _ detail: String = "") {
                if !cond {
                    print("❌ FAIL: \(name) - \(detail)")
                    passed = false
                } else {
                    print("✅ PASS: \(name)")
                }
            }

            // 1. 撤销/重做走 menuAction 路由且 target 为 self (AppDelegate)
            if let undo = items["编辑 > 撤销"] {
                check("撤销 menuAction payload", (undo.representedObject as? String) == "edit.undo", "payload: \(undo.representedObject ?? "")")
                check("撤销 target 非空 (AppDelegate)", undo.target != nil, "target: \(String(describing: undo.target))")
                check("撤销快捷键 ⌘Z", undo.keyEquivalent == "z" && undo.keyEquivalentModifierMask == .command)
            } else {
                check("存在 编辑 > 撤销", false)
            }

            if let redo = items["编辑 > 重做"] {
                check("重做 menuAction payload", (redo.representedObject as? String) == "edit.redo", "payload: \(redo.representedObject ?? "")")
                check("重做 target 非空 (AppDelegate)", redo.target != nil)
                check("重做快捷键 ⇧⌘Z", redo.keyEquivalent == "z" && redo.keyEquivalentModifierMask == [.command, .shift])
            } else {
                check("存在 编辑 > 重做", false)
            }

            // 2. 剪切/拷贝/粘贴/全选 走 responder chain (target == nil)
            let responderItems = [
                ("编辑 > 剪切", #selector(NSText.cut(_:))),
                ("编辑 > 拷贝", #selector(NSText.copy(_:))),
                ("编辑 > 粘贴", #selector(NSText.paste(_:))),
                ("编辑 > 全选", #selector(NSText.selectAll(_:))),
                ("文件 > 关闭窗口", #selector(NSWindow.performClose(_:)))
            ]
            for (name, action) in responderItems {
                if let it = items[name] {
                    check("\(name) target 为 nil（走响应链）", it.target == nil, "target is \(String(describing: it.target))")
                    check("\(name) action 匹配", it.action == action, "action: \(String(describing: it.action))")
                } else {
                    check("存在 \(name)", false)
                }
            }

            if passed {
                print("G2_NATIVE_MENU_PASSED")
                exit(0)
            } else {
                print("G2_NATIVE_MENU_FAILED")
                exit(1)
            }
        }

        if args.contains("--test-shortcuts-contract") {
            let (items, shortcuts) = MenuInspector.inspectMenu()
            var passed = true
            func check(_ name: String, _ cond: Bool, _ detail: String = "") {
                if !cond {
                    print("❌ FAIL: \(name) - \(detail)")
                    passed = false
                } else {
                    print("✅ PASS: \(name)")
                }
            }

            // 1. 无快捷键冲突（除允许的别名外，如放大 ⌘= 与 ⌘+）
            var seen = [String: String]()
            for s in shortcuts {
                let sig = "\(s.mods.rawValue):\(s.key)"
                let fullTitle = "\(s.menu) > \(s.title)"
                if let existing = seen[sig] {
                    if s.title == "放大" && existing.contains("放大") {
                        continue
                    }
                    check("快捷键无冲突: \(s.key) [mods: \(s.mods)]", false, "冲突项: \(existing) 与 \(fullTitle)")
                } else {
                    seen[sig] = fullTitle
                }
            }
            check("全部快捷键无内部键位冲突", passed)

            // 2. 核心快捷键规格验证
            if let rep = items["编辑 > 替换…"] {
                check("替换快捷键为 ⌥⌘F", rep.keyEquivalent == "f" && rep.keyEquivalentModifierMask == [.command, .option])
            }
            if let focus = items["视图 > 专注模式"] {
                check("专注模式快捷键为 ⇧⌘J（不与替换 ⌥⌘F 冲突）", focus.keyEquivalent == "j" && focus.keyEquivalentModifierMask == [.command, .shift])
            }
            if let quote = items["格式 > 引用"] {
                check("引用快捷键为 ⌥⌘Q（避开系统锁屏 ⌃⌘Q）", quote.keyEquivalent == "q" && quote.keyEquivalentModifierMask == [.command, .option])
            }
            if let task = items["格式 > 任务列表"] {
                check("任务列表快捷键为 ⌥⌘X（Typora Mac 标准，避开下一个主题 ⌃⌘T）", task.keyEquivalent == "x" && task.keyEquivalentModifierMask == [.command, .option])
            }
            if let theme = items["视图 > 视图 > 主题 > 下一个主题"] ?? items["视图 > 主题 > 下一个主题"] {
                check("下一个主题快捷键保留 ⌃⌘T", theme.keyEquivalent == "t" && theme.keyEquivalentModifierMask == [.command, .control])
            }
            if let code = items["格式 > 行内代码"] {
                check("行内代码快捷键为 ⇧⌘`（避开 macOS 窗口循环 ⌘`）", code.keyEquivalent == "`" && code.keyEquivalentModifierMask == [.command, .shift])
            }
            if let zoomEq = items["视图 > 放大"] {
                check("放大支持 ⌘=", zoomEq.keyEquivalent == "=" && zoomEq.keyEquivalentModifierMask == .command)
            }

            if passed {
                print("G3_SHORTCUTS_CONTRACT_PASSED")
                exit(0)
            } else {
                print("G3_SHORTCUTS_CONTRACT_FAILED")
                exit(1)
            }
        }

        if args.contains("--test-wysiwyg") {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let runner = HeadlessRunner()

            runner.run { wv in
                let testScript = """
                (async function() {
                    const results = [];
                    function assert(desc, ok, extra) { results.push({ desc, ok: !!ok, extra: extra || '' }); }

                    try {
                        window.__debug.setView('wysiwyg');
                        window.__editor.setValue("这是一段测试文字用于WYSIWYG格式化验证\\n\\n第二段测试引用与列表\\n\\n第三段正文");

                        const pm = document.querySelector('#wysiwyg .ProseMirror');
                        assert("WYSIWYG 编辑面已挂载", !!pm);

                        function pressKey(target, opts) {
                            const ev = new KeyboardEvent('keydown', Object.assign({
                                bubbles: true,
                                cancelable: true
                            }, opts));
                            target.dispatchEvent(ev);
                        }

                        // 1. 测试真实按键 ⌘B 粗体格式化（验证不发生冒泡二次抵消）
                        window.__debug.selectRange(1, 5);
                        pressKey(pm, { key: 'b', code: 'KeyB', metaKey: true });
                        let strongTag = pm.querySelector('strong');
                        assert("WYSIWYG 真实按键 ⌘B 生成 <strong>（无二次抵消）", !!strongTag, strongTag ? strongTag.outerHTML : 'none');

                        // 再次按 ⌘B 应取消粗体
                        pressKey(pm, { key: 'b', code: 'KeyB', metaKey: true });
                        assert("WYSIWYG 再次按 ⌘B 取消 <strong>", !pm.querySelector('strong'));

                        // 菜单触发 format.bold 同样有效（等待 >45ms 去重窗口）
                        await new Promise(r => setTimeout(r, 60));
                        window.__nativeMenu('format.bold');
                        strongTag = pm.querySelector('strong');
                        assert("WYSIWYG 菜单触发粗体生成 <strong>", !!strongTag);

                        // 2. 测试真实按键 ⌘I 斜体格式化
                        window.__debug.selectRange(6, 10);
                        pressKey(pm, { key: 'i', code: 'KeyI', metaKey: true });
                        const emTag = pm.querySelector('em');
                        assert("WYSIWYG 真实按键 ⌘I 生成 <em>（无二次抵消）", !!emTag, emTag ? emTag.outerHTML : 'none');

                        // 3. 测试真实按键 ⌘U 下划线格式化
                        window.__debug.selectRange(11, 15);
                        pressKey(pm, { key: 'u', code: 'KeyU', metaKey: true });
                        const uTag = pm.querySelector('u');
                        assert("WYSIWYG 真实按键 ⌘U 生成 <u>（无二次抵消）", !!uTag, uTag ? uTag.outerHTML : 'none');

                        // 4. 测试真实按键 ⌥⌘S 删除线（模拟 macOS Option 死键 key='ß', code='KeyS'）
                        window.__debug.selectRange(15, 19);
                        pressKey(pm, { key: 'ß', code: 'KeyS', metaKey: true, altKey: true });
                        const delTag = pm.querySelector('del');
                        assert("WYSIWYG 真实按键 ⌥⌘S 生成 <del>", !!delTag, delTag ? delTag.outerHTML : 'none');

                        // 5. 测试真实按键 ⇧⌘` 行内代码（模拟 Shift+` 下 key='~', code='Backquote'）
                        window.__debug.selectRange(19, 23);
                        pressKey(pm, { key: '~', code: 'Backquote', metaKey: true, shiftKey: true });
                        const codeTag = pm.querySelector('code');
                        assert("WYSIWYG 真实按键 ⇧⌘` 生成 <code>", !!codeTag, codeTag ? codeTag.outerHTML : 'none');

                        // 6. 测试无选区（折叠光标）下按 ⌘B / ⌘I / ⌘U 直接插入可见占位并选中
                        window.__editor.setValue("空选区测试");
                        window.__debug.selectRange(3, 3);
                        pressKey(pm, { key: 'b', code: 'KeyB', metaKey: true });
                        assert("WYSIWYG 无选区按 ⌘B 插入可见 <strong>粗体</strong>", !!pm.querySelector('strong') && pm.querySelector('strong').textContent === '粗体');

                        // 7. 测试标题 1 格式化与再次按键取消 (⌃⌘1)
                        window.__editor.setValue("标题行测试\\n\\n第二段测试引用\\n\\n第三段任务");
                        window.__debug.selectRange(1, 4);
                        pressKey(pm, { key: '1', code: 'Digit1', metaKey: true, ctrlKey: true });
                        assert("WYSIWYG ⌃⌘1 生成 <h1>", !!pm.querySelector('h1'));
                        pressKey(pm, { key: '1', code: 'Digit1', metaKey: true, ctrlKey: true });
                        assert("WYSIWYG 再次按 ⌃⌘1 恢复普通段落", !pm.querySelector('h1'));

                        // 8. 测试引用格式化 (⌥⌘Q)
                        window.__debug.selectRange(8, 12);
                        pressKey(pm, { key: 'œ', code: 'KeyQ', metaKey: true, altKey: true });
                        const bqTag = pm.querySelector('blockquote');
                        assert("WYSIWYG ⌥⌘Q 引用生成 <blockquote>", !!bqTag, bqTag ? bqTag.outerHTML : 'none');

                        // 9. 测试任务列表 (⌥⌘X，验证不被 GFM 删除线抢占且单次按键即生成复选框)
                        window.__editor.setValue("普通任务文字项");
                        window.__debug.selectRange(1, 4);
                        pressKey(pm, { key: '≈', code: 'KeyX', metaKey: true, altKey: true });
                        const taskItem = pm.querySelector('li.task-item input[type="checkbox"]');
                        assert("WYSIWYG ⌥⌘X 一次按键生成未勾选任务列表项", !!taskItem && !taskItem.checked && !pm.querySelector('del'));

                        // 10. 测试无序列表 (⌃⌘U)
                        window.__editor.setValue("普通列表文字项");
                        window.__debug.selectRange(1, 4);
                        pressKey(pm, { key: 'u', code: 'KeyU', metaKey: true, ctrlKey: true });
                        const ulTag = pm.querySelector('ul');
                        assert("WYSIWYG ⌃⌘U 列表生成 <ul>", !!ulTag, ulTag ? ulTag.outerHTML : 'none');

                        // 11. 验证过程中无 uncaught exception
                        const errs = (window.__errors || []).filter(e => e.startsWith('error:') || e.startsWith('rejection:'));
                        assert("WYSIWYG 格式化执行无运行时抛错", errs.length === 0, errs.join('; '));
                    } catch (e) {
                        assert("WYSIWYG 测试执行异常: " + e.message, false);
                    }

                    window.__testResult = JSON.stringify(results);
                })();
                'started';
                """

                wv.evaluateJavaScript(testScript) { _, err in
                    if let err = err {
                        print("JS Init Error: \(err)")
                        exit(1)
                    }
                    func checkResult(retries: Int = 80) {
                        wv.evaluateJavaScript("window.__testResult") { res, err in
                            if let json = res as? String,
                               let data = json.data(using: .utf8),
                               let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                                var allOk = true
                                for item in list {
                                    let desc = item["desc"] as? String ?? ""
                                    let ok = item["ok"] as? Bool ?? false
                                    let extra = item["extra"] as? String ?? ""
                                    if ok {
                                        print("✅ PASS: \(desc)")
                                    } else {
                                        print("❌ FAIL: \(desc) (extra: \(extra))")
                                        allOk = false
                                    }
                                }
                                if allOk {
                                    print("G1_WYSIWYG_FORMAT_PASSED")
                                    exit(0)
                                } else {
                                    print("G1_WYSIWYG_FORMAT_FAILED")
                                    exit(1)
                                }
                            } else if retries > 0 {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                                    checkResult(retries: retries - 1)
                                }
                            } else {
                                wv.evaluateJavaScript("[window.__errors, document.querySelector('#wysiwyg .ProseMirror')?.innerHTML]") { dbg, _ in
                                    print("Timeout waiting for WYSIWYG test results, dbg:", dbg ?? "nil")
                                    exit(1)
                                }
                            }
                        }
                    }
                    checkResult()
                }
            }
            app.run()
        }

        if args.contains("--test-undo-redo") {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let runner = HeadlessRunner()

            runner.run { wv in
                let testScript = """
                (async function() {
                    const results = [];
                    function assert(desc, ok, extra) { results.push({ desc, ok: !!ok, extra: extra || '' }); }

                    try {
                        function pressKey(target, opts) {
                            const ev = new KeyboardEvent('keydown', Object.assign({
                                bubbles: true,
                                cancelable: true
                            }, opts));
                            target.dispatchEvent(ev);
                        }

                        // 1. WYSIWYG 撤销与重做（含真实按键 ⌘Z / ⇧⌘Z 单步验证）
                        window.__debug.setView('wysiwyg');
                        window.__editor.setValue("初始文本行");

                        let pm = document.querySelector('#wysiwyg .ProseMirror');
                        window.__debug.selectRange(1, 5);
                        pressKey(pm, { key: 'b', code: 'KeyB', metaKey: true });

                        assert("加粗后包含 strong", !!pm.querySelector('strong'));

                        // 触发真实按键 ⌘Z 撤销
                        pressKey(pm, { key: 'z', code: 'KeyZ', metaKey: true });
                        pm = document.querySelector('#wysiwyg .ProseMirror');
                        assert("WYSIWYG ⌘Z 成功撤销加粗", !pm.querySelector('strong'));

                        // 触发真实按键 ⇧⌘Z 重做
                        pressKey(pm, { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true });
                        pm = document.querySelector('#wysiwyg .ProseMirror');
                        assert("WYSIWYG ⇧⌘Z 成功重做加粗", !!pm.querySelector('strong'));

                        // 2. 源码模式真实按键 ⌘B / ⌘I / ⌘U 与 ⌘Z / ⇧⌘Z 撤销重做
                        window.__debug.setView('source');
                        window.__editor.setValue("源码文本");

                        const cmInput = document.querySelector('.CodeMirror textarea') || document.body;
                        window.__debug.selectRange(0, 2);
                        pressKey(cmInput, { key: 'b', code: 'KeyB', metaKey: true });
                        assert("源码模式 ⌘B 加粗包装（无二次抵消）", window.__editor.getValue() === "**源码**文本", window.__editor.getValue());

                        window.__debug.selectRange(6, 8);
                        pressKey(cmInput, { key: 'u', code: 'KeyU', metaKey: true });
                        assert("源码模式 ⌘U 下划线包装（无二次抵消）", window.__editor.getValue() === "**源码**<u>文本</u>", window.__editor.getValue());

                        // 真实按键 ⌘Z 撤销
                        pressKey(cmInput, { key: 'z', code: 'KeyZ', metaKey: true });
                        assert("源码模式 ⌘Z 撤销成功", !window.__editor.getValue().includes('<u>'), window.__editor.getValue());

                        // 真实按键 ⇧⌘Z 重做
                        pressKey(cmInput, { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true });
                        assert("源码模式 ⇧⌘Z 重做成功", window.__editor.getValue().includes('<u>'), window.__editor.getValue());

                        // 3. 验证快捷键弹窗内容
                        await new Promise(r => setTimeout(r, 60));
                        window.__nativeMenu('help.shortcuts');
                        const modal = document.getElementById('modal');
                        const modalText = modal ? modal.textContent : '';
                        assert("说明弹窗显示且包含 ⌥⌘F", modalText.includes('⌥⌘F'));
                        assert("说明弹窗显示且包含 ⌥⌘X", modalText.includes('⌥⌘X'));
                        assert("说明弹窗显示且包含 ⌥⌘Q", modalText.includes('⌥⌘Q'));
                        assert("说明弹窗显示且包含 ⇧⌘`", modalText.includes('⇧⌘`'));
                        assert("说明弹窗显示且包含 ⌘Z / ⇧⌘Z", modalText.includes('⌘Z') && modalText.includes('⇧⌘Z'));
                    } catch (e) {
                        assert("Undo/Redo 测试执行异常: " + e.message, false);
                    }

                    window.__testResult = JSON.stringify(results);
                })();
                'started';
                """

                wv.evaluateJavaScript(testScript) { _, err in
                    if let err = err {
                        print("JS Init Error: \(err)")
                        exit(1)
                    }
                    func checkResult(retries: Int = 80) {
                        wv.evaluateJavaScript("window.__testResult") { res, err in
                            if let json = res as? String,
                               let data = json.data(using: .utf8),
                               let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                                var allOk = true
                                for item in list {
                                    let desc = item["desc"] as? String ?? ""
                                    let ok = item["ok"] as? Bool ?? false
                                    let extra = item["extra"] as? String ?? ""
                                    if ok {
                                        print("✅ PASS: \(desc)")
                                    } else {
                                        print("❌ FAIL: \(desc) (extra: \(extra))")
                                        allOk = false
                                    }
                                }
                                if allOk {
                                    print("G4_UNDO_REDO_PASSED")
                                    exit(0)
                                } else {
                                    print("G4_UNDO_REDO_FAILED")
                                    exit(1)
                                }
                            } else if retries > 0 {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                                    checkResult(retries: retries - 1)
                                }
                            } else {
                                print("Timeout waiting for Undo/Redo test results")
                                exit(1)
                            }
                        }
                    }
                    checkResult()
                }
            }
            app.run()
        }

        print("Usage: test-shortcuts [--test-native-menu | --test-shortcuts-contract | --test-wysiwyg | --test-undo-redo]")
    }
}
