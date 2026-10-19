// 离屏自检：加载 web/ 编辑器，收集渲染结果与错误，导出快照 PNG 与 PDF 测试
import Foundation
import AppKit
import WebKit
import PDFKit

final class Verifier: NSObject, WKNavigationDelegate {
    var webView: WKWebView!
    var outDir: URL!
    var schemeHandler: WebSchemeHandler!
    var pdfExporterRef: PDFExporter?

    func start(outDir: URL) {
        self.outDir = outDir
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

        let config = WKWebViewConfiguration()
        schemeHandler = WebSchemeHandler(webRoot: Paths.webRoot)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: WebSchemeHandler.scheme)
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let ucc = WKUserContentController()
        let hook = """
        window.__errors = [];
        window.addEventListener('error', function (e) {
            window.__errors.push('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e.reason;
            window.__errors.push('rejection: ' + (r && (r.message || r) || 'unknown'));
        });
        (function () {
            var orig = console.error;
            console.error = function () {
                window.__errors.push('console: ' + Array.prototype.slice.call(arguments).map(String).join(' '));
                orig.apply(console, arguments);
            };
        })();
        """
        ucc.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc

        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 820), configuration: config)
        webView.navigationDelegate = self

        // 放进一个不显示的窗口，保证布局与真实运行一致
        let win = NSWindow(contentRect: webView.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = webView
        win.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        win.orderBack(nil)

        webView.load(URLRequest(url: URL(string: "offline-md://app/index.html")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // mermaid 首次加载较慢（3.5 MB），多留时间
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) { self.collect() }
    }

    private func collect() {
        let js = """
        (function () {
          var s = window.__debug ? window.__debug.stats() : {};
          s.errors = window.__errors || [];
          s.ready = !!window.__debug;
          s.theme = document.documentElement.dataset.theme;
          return JSON.stringify(s);
        })()
        """
        webView.evaluateJavaScript(js) { result, error in
            if let error = error {
                print("EVAL_ERROR \(error.localizedDescription)")
                exit(1)
            }
            print("STATS \(result as? String ?? "{}")")
            // 先滚到底取一张全页走查图，再回到任务列表区域取细节图
            self.webView.evaluateJavaScript(
                "(function(){var w=document.getElementById('wysiwyg-wrap'); if(!w) return 'none'; w.scrollTop=w.scrollHeight; return 'scrolled';})()"
            ) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    self.snapshot(name: "light") {
                        self.webView.evaluateJavaScript(
                            "(function(){var w=document.getElementById('wysiwyg-wrap'); var li=document.querySelector('#wysiwyg li.task-item'); if(!w||!li) return 'none'; w.scrollTop=li.offsetTop - w.clientHeight/3; return 'ok';})()"
                        ) { _, _ in
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.snapshot(name: "tasks") {
                                self.webView.evaluateJavaScript("window.__debug.lineCount()") { n, _ in
                                    print("CM_LINES \(n ?? "nil")")
                                    self.testPDF()
                                }
                            }}
                        }
                    }
                }
            }
        }
    }

    private func switchTheme(_ theme: String, done: @escaping () -> Void) {
        webView.evaluateJavaScript("window.__debug.setTheme('\(theme)'); 'ok'") { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { done() }
        }
    }

    private func snapshot(name: String, done: @escaping () -> Void) {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = webView.bounds
        webView.takeSnapshot(with: cfg) { image, error in
            if let image = image, let tiff = image.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                let url = self.outDir.appendingPathComponent("\(name).png")
                try? png.write(to: url)
                print("SNAPSHOT \(url.lastPathComponent) \(png.count) bytes")
            } else {
                print("SNAPSHOT_FAIL \(error?.localizedDescription ?? "nil")")
            }
            done()
        }
    }

    private func testPDF() {
        print("PDF_START")
        let kick = """
        window.__pdfHtml = null; window.__pdfErr = null;
        window.__debug.buildExportHTML(true)
          .then(function (s) { window.__pdfHtml = s; })
          .catch(function (e) { window.__pdfErr = String(e && e.stack || e); });
        'started'
        """
        webView.evaluateJavaScript(kick, completionHandler: nil)

        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            self.webView.evaluateJavaScript("[window.__pdfHtml ? window.__pdfHtml.length : -1, window.__pdfErr || '']") { result, _ in
                let arr = result as? [Any]
                let len = (arr?.first as? Int) ?? -1
                let err = (arr?.last as? String) ?? ""
                if len <= 0 {
                    print("PDF_HTML_FAIL len=\(len) err=\(err.prefix(400))")
                    self.afterPDF()
                    return
                }
                print("PDF_HTML_OK bytes=\(len)")
                self.webView.evaluateJavaScript("window.__pdfHtml") { res, _ in
                    guard let html = res as? String else { print("PDF_HTML_FAIL cast"); self.afterPDF(); return }
                    let dest = self.outDir.appendingPathComponent("sample.pdf")
                    let exporter = PDFExporter()
                    self.pdfExporterRef = exporter
                    exporter.export(html: html, to: dest) { r in
                        self.pdfExporterRef = nil
                        switch r {
                        case .success(let info):
                            let size = ((try? FileManager.default.attributesOfItem(atPath: dest.path))?[.size] as? Int) ?? 0
                            print("PDF_OK pages=\(info.pages) textOK=\(info.textOK) bytes=\(size)")
                            self.reportPDFText(dest)
                        case .failure(let error):
                            print("PDF_FAIL \(error.localizedDescription)")
                        }
                        self.afterPDF()
                    }
                }
            }
        }
    }

    private func afterPDF() {
        snapshot(name: "light") {
            self.switchTheme("graphite") {
                self.snapshot(name: "dark") {
                    print("DONE")
                    exit(0)
                }
            }
        }
    }

    private func reportPDFText(_ url: URL) {
        guard let doc = PDFDocument(url: url), let first = doc.page(at: 0) else { return }
        let text = (doc.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = text.replacingOccurrences(of: "\n", with: " ⏎ ").prefix(120)
        print("PDF_TEXT_LEN \(text.count) SAMPLE \(preview)")
        let box = first.bounds(for: .mediaBox)
        print("PDF_PAGE_SIZE \(Int(box.width))x\(Int(box.height))pt")
    }
}

@main
struct VerifyMain {
    static func main() {
        setvbuf(stdout, nil, _IONBF, 0)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/verify")
        let v = Verifier()
        v.start(outDir: outDir)
        app.run()
    }
}
