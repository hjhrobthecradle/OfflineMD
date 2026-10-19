import Foundation
import AppKit
import WebKit

final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

final class EditorWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {

    private(set) var webView: WKWebView!
    private var bridge: Bridge!
    private var schemeHandler: WebSchemeHandler!

    init() {
        let rect = NSRect(x: 0, y: 0, width: 1200, height: 820)
        let window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OfflineMD"
        window.minSize = NSSize(width: 760, height: 480)
        window.tabbingMode = .disallowed
        window.titlebarAppearsTransparent = false

        super.init(window: window)

        window.delegate = self
        window.setFrameAutosaveName("OfflineMD.MainWindow")
        if !window.setFrameUsingName("OfflineMD.MainWindow") {
            window.center()
        }

        buildWebView()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        schemeHandler = WebSchemeHandler(webRoot: Paths.webRoot)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: WebSchemeHandler.scheme)
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.suppressesIncrementalRendering = false

        let ucc = WKUserContentController()
        bridge = Bridge()
        ucc.add(WeakScriptHandler(bridge), name: "native")
        config.userContentController = ucc

        let wv = WKWebView(frame: window?.contentLayoutRect ?? .zero, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsMagnification = false
        if #available(macOS 12.0, *) {
            wv.underPageBackgroundColor = NSColor.textBackgroundColor
        }

        bridge.webView = wv
        bridge.windowController = self
        webView = wv

        window?.contentView = wv
        wv.load(URLRequest(url: URL(string: "\(WebSchemeHandler.scheme)://app/index.html")!))
    }

    // MARK: - 打开外部文件

    func openFile(at path: String) {
        let js = "window.__nativeMenu && window.__nativeMenu(\"file.openPath\", \(jsonString(path)));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    func focusEditor() {
        window?.makeKeyAndOrderFront(nil)
        webView?.evaluateJavaScript("window.__editor && window.__editor.focus();", completionHandler: nil)
    }

    // MARK: - 缩放

    func zoom(_ delta: CGFloat) {
        guard let wv = webView else { return }
        let next = min(2.4, max(0.6, wv.pageZoom + delta))
        wv.pageZoom = next
        UserDefaults.standard.set(Double(next), forKey: "pref.pageZoom")
    }

    func resetZoom() {
        webView?.pageZoom = 1.0
        UserDefaults.standard.set(1.0, forKey: "pref.pageZoom")
    }

    // MARK: - 导航策略：硬阻断一切网络访问

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        switch url.scheme?.lowercased() {
        case WebSchemeHandler.scheme, "about", "blob", "data":
            decisionHandler(.allow)
        default:
            // 应用内不允许任何 http(s) 导航；用户点击的外链交给系统浏览器
            if navigationAction.navigationType == .linkActivated,
               let s = url.scheme?.lowercased(), s == "http" || s == "https" {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           let s = url.scheme?.lowercased(), s == "http" || s == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // 渲染进程崩溃：重新载入本地页面，内容仍在本地快照里
        webView.reload()
    }
}
