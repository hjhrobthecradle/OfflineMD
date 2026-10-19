import Foundation
import AppKit
import WebKit

final class ScrollTester: NSObject, WKNavigationDelegate {
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
        window.__logs = [];
        window.addEventListener('error', function (e) {
            window.__errors.push('error: ' + (e.message || ''));
        });
        const origLog = console.log;
        console.log = function(...args) {
            window.__logs.push('log: ' + args.join(' '));
            origLog.apply(console, args);
        };
        const origWarn = console.warn;
        console.warn = function(...args) {
            window.__logs.push('warn: ' + args.join(' '));
            origWarn.apply(console, args);
        };
        """
        ucc.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc

        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
        webView.navigationDelegate = self

        let win = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.contentView = webView
        win.setFrameOrigin(NSPoint(x: 100, y: 100))
        win.makeKeyAndOrderFront(nil)

        webView.load(URLRequest(url: URL(string: "offline-md://app/index.html")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            self.testOutlineClick()
        }
    }

    func testOutlineClick() {
        let js = """
        (async function() {
            const wrap = document.getElementById('wysiwyg-wrap');
            const items = Array.from(document.querySelectorAll('#outline-list .ol-item'));
            const results = {};

            // 1. 测试从顶部点击 "列表与任务"
            const itemTask = items.find(it => it.textContent.includes('列表与任务'));
            if (!itemTask) return JSON.stringify({ error: '列表与任务 item not found' });

            const beforeScroll = wrap.scrollTop;
            itemTask.click();
            await new Promise(r => setTimeout(r, 600));
            const afterScroll = wrap.scrollTop;

            const h2s = Array.from(document.querySelectorAll('#wysiwyg h2'));
            const targetTaskH2 = h2s.find(h => h.textContent.includes('列表与任务'));
            const wrapRect1 = wrap.getBoundingClientRect();
            const h2Rect1 = targetTaskH2 ? targetTaskH2.getBoundingClientRect() : null;
            const diff1 = h2Rect1 ? (h2Rect1.top - wrapRect1.top) : -999;
            const activeItem1 = document.querySelector('#outline-list .ol-item.active');

            results.step1 = {
                beforeScroll,
                afterScroll,
                targetFound: !!targetTaskH2,
                diffFromTop: diff1,
                activeText: activeItem1 ? activeItem1.textContent : 'none',
                itemDataset: { ...itemTask.dataset },
                errors: window.__errors,
                passed: Math.abs(diff1 - 18) <= 5 && (activeItem1 && activeItem1.textContent.includes('列表与任务'))
            };

            // 2. 测试滚到底部后，点击 "数学公式"
            wrap.scrollTop = wrap.scrollHeight;
            await new Promise(r => setTimeout(r, 200));

            const itemMath = items.find(it => it.textContent.includes('数学公式'));
            if (!itemMath) return JSON.stringify({ error: '数学公式 item not found', results });

            itemMath.click();
            await new Promise(r => setTimeout(r, 600));

            const targetMathH2 = h2s.find(h => h.textContent.includes('数学公式'));
            const wrapRect2 = wrap.getBoundingClientRect();
            const h2Rect2 = targetMathH2 ? targetMathH2.getBoundingClientRect() : null;
            const diff2 = h2Rect2 ? (h2Rect2.top - wrapRect2.top) : -999;
            const activeItem2 = document.querySelector('#outline-list .ol-item.active');

            results.step2 = {
                targetFound: !!targetMathH2,
                diffFromTop: diff2,
                activeText: activeItem2 ? activeItem2.textContent : 'none',
                passed: Math.abs(diff2 - 18) <= 5 && (activeItem2 && activeItem2.textContent.includes('数学公式'))
            };

            // 3. 测试从顶部点击第一项 "欢迎使用 OfflineMD"
            const itemH1 = items.find(it => it.textContent.includes('欢迎使用 OfflineMD'));
            if (itemH1) {
                itemH1.click();
                await new Promise(r => setTimeout(r, 600));
                results.step3 = {
                    scrollTop: wrap.scrollTop,
                    passed: wrap.scrollTop === 0
                };
            }

            // 4. 测试手动滚动时，左侧大纲高亮联动
            const targetTableH2 = h2s.find(h => h.textContent.includes('表格'));
            if (targetTableH2) {
                const wrapRect = wrap.getBoundingClientRect();
                const elRect = targetTableH2.getBoundingClientRect();
                wrap.scrollTop = wrap.scrollTop + (elRect.top - wrapRect.top) - 18;
                wrap.dispatchEvent(new Event('scroll'));
                await new Promise(r => setTimeout(r, 100));
                const activeItem4 = document.querySelector('#outline-list .ol-item.active');
                results.step4 = {
                    activeText: activeItem4 ? activeItem4.textContent : 'none',
                    passed: !!(activeItem4 && activeItem4.textContent.includes('表格'))
                };
            }

            return JSON.stringify({
                results,
                allPassed: results.step1.passed && results.step2.passed && (results.step3 ? results.step3.passed : true) && (results.step4 ? results.step4.passed : true)
            });
        })().then(res => {
            window.__scroll_res = res;
        }).catch(err => {
            window.__scroll_res = 'ERR: ' + err;
        });
        void 0;
        """
        webView.evaluateJavaScript(js) { _, err in
            if let err = err {
                print("EVAL_ERROR: \(err.localizedDescription)")
                exit(1)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                self.webView.evaluateJavaScript("window.__scroll_res") { res, err in
                    if let err = err {
                        print("FETCH_ERROR: \(err.localizedDescription)")
                    } else {
                        print("SCROLL_RESULT: \(res as? String ?? "nil")")
                    }
                    exit(0)
                }
            }
        }
    }
}

@main
struct ScrollMain {
    static func main() {
        setvbuf(stdout, nil, _IONBF, 0)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let t = ScrollTester()
        t.start()
        app.run()
    }
}
