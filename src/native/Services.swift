import Foundation
import AppKit
import WebKit
import PDFKit
import CryptoKit

// MARK: - 常量与路径

enum AppInfo {
    static let bundleID = "local.offlinemd.editor"
    static var version: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
    }
    static var build: String {
        (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "1"
    }
}

enum Paths {
    static var support: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("OfflineMD", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var snaps: URL {
        let dir = support.appendingPathComponent("snaps", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var webRoot: URL {
        if let res = Bundle.main.resourceURL {
            let web = res.appendingPathComponent("web", isDirectory: true)
            if FileManager.default.fileExists(atPath: web.path) { return web }
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("web")
    }
}

func sha256Hex(_ input: String) -> String {
    let digest = SHA256.hash(data: Data(input.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

func jsonString(_ object: Any) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: [object], options: []),
       let s = String(data: data, encoding: .utf8) {
        // 去掉最外层数组括号，得到单个 JSON 值
        return String(s.dropFirst().dropLast())
    }
    return "null"
}

func makeError(_ message: String) -> NSError {
    NSError(domain: "OfflineMD", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

// MARK: - MIME

enum Mime {
    static func of(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "bmp": return "image/bmp"
        case "pdf": return "application/pdf"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "map": return "application/json"
        case "txt", "md": return "text/plain"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - 自定义 scheme：offline-md://app/... 与 offline-md://local/<绝对路径>

final class WebSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "offline-md"
    private let webRoot: URL
    private let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "pdf"]

    init(webRoot: URL) {
        self.webRoot = webRoot
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(makeError("bad url"))
            return
        }
        let abs = url.absoluteString

        var fileURL: URL?

        if abs.hasPrefix("\(WebSchemeHandler.scheme)://app") {
            var rest = String(abs.dropFirst("\(WebSchemeHandler.scheme)://app".count))
            if let q = rest.firstIndex(of: "?") { rest = String(rest[..<q]) }
            if let h = rest.firstIndex(of: "#") { rest = String(rest[..<h]) }
            if rest.isEmpty || rest == "/" { rest = "/index.html" }
            let rel = rest.hasPrefix("/") ? String(rest.dropFirst()) : rest
            fileURL = webRoot.appendingPathComponent(rel)
        } else if abs.hasPrefix("\(WebSchemeHandler.scheme)://local") {
            var rest = String(abs.dropFirst("\(WebSchemeHandler.scheme)://local".count))
            if let q = rest.firstIndex(of: "?") { rest = String(rest[..<q]) }
            if let h = rest.firstIndex(of: "#") { rest = String(rest[..<h]) }
            let decoded = rest.removingPercentEncoding ?? rest
            let ext = (decoded as NSString).pathExtension.lowercased()
            if imageExts.contains(ext), FileManager.default.fileExists(atPath: decoded) {
                fileURL = URL(fileURLWithPath: decoded)
            }
        }

        guard let target = fileURL, FileManager.default.fileExists(atPath: target.path) else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(resp)
            task.didReceive(Data("not found".utf8))
            task.didFinish()
            return
        }

        do {
            let data = try Data(contentsOf: target)
            let headers: [String: String] = [
                "Content-Type": Mime.of(target.path),
                "Content-Length": "\(data.count)",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*"
            ]
            let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            task.didReceive(resp)
            task.didReceive(data)
            task.didFinish()
        } catch {
            task.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { }
}

// MARK: - 快照存储（本地崩溃恢复）

final class SnapshotStore {
    static let shared = SnapshotStore()

    private func fileURL(_ key: String) -> URL {
        Paths.snaps.appendingPathComponent(sha256Hex(key).prefix(24) + ".json")
    }

    func save(key: String, path: String, title: String, content: String, cursor: Int, scroll: Int) {
        let payload: [String: Any] = [
            "key": key,
            "path": path,
            "title": title,
            "content": content,
            "cursor": cursor,
            "scroll": scroll,
            "ts": Date().timeIntervalSince1970
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: fileURL(key), options: .atomic)
    }

    func load(key: String) -> [String: Any]? {
        let url = fileURL(key)
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    func clear(key: String) {
        try? FileManager.default.removeItem(at: fileURL(key))
    }

    func list() -> [[String: Any]] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: Paths.snaps,
                                                                      includingPropertiesForKeys: nil) else { return [] }
        var out: [[String: Any]] = []
        for f in files where f.pathExtension == "json" {
            guard let data = try? Data(contentsOf: f),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let content = obj["content"] as? String ?? ""
            let path = obj["path"] as? String ?? ""
            if content.isEmpty && path.isEmpty { continue }
            // 与磁盘内容一致的快照视为已保存，不提示恢复
            if !path.isEmpty, let disk = try? String(contentsOfFile: path, encoding: .utf8), disk == content {
                continue
            }
            out.append([
                "key": obj["key"] as? String ?? "",
                "path": path,
                "title": obj["title"] as? String ?? "",
                "ts": obj["ts"] as? Double ?? 0,
                "size": content.count
            ])
        }
        return out.sorted { ($0["ts"] as? Double ?? 0) > ($1["ts"] as? Double ?? 0) }
    }

    func prune() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: Paths.snaps,
                                                                      includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        for f in files {
            let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
            if m < cutoff { try? FileManager.default.removeItem(at: f) }
        }
    }
}

// MARK: - 最近文件

enum Recents {
    private static let key = "recentFiles"

    static func list() -> [String] {
        let arr = UserDefaults.standard.array(forKey: key) as? [String] ?? []
        return arr.filter { FileManager.default.fileExists(atPath: $0) }
    }

    static func add(_ path: String) {
        var arr = list()
        arr.removeAll { $0 == path }
        arr.insert(path, at: 0)
        if arr.count > 15 { arr = Array(arr.prefix(15)) }
        UserDefaults.standard.set(arr, forKey: key)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

// MARK: - 文件树

enum FileTree {
    static let mdExts: Set<String> = ["md", "markdown", "mdown", "mkd", "txt"]
    private static let skipDirs: Set<String> = [".git", "node_modules", ".build", "DerivedData", ".Trash"]

    static func build(root: URL, maxDepth: Int = 8, maxNodes: Int = 4000) -> [String: Any]? {
        var budget = maxNodes
        return node(url: root, depth: 0, maxDepth: maxDepth, budget: &budget, isRoot: true)
    }

    private static func node(url: URL, depth: Int, maxDepth: Int, budget: inout Int, isRoot: Bool) -> [String: Any]? {
        guard budget > 0 else { return nil }
        let name = url.lastPathComponent
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return nil }

        if !isDir.boolValue {
            let ext = url.pathExtension.lowercased()
            guard mdExts.contains(ext) else { return nil }
            budget -= 1
            return ["name": name, "path": url.path, "isDir": false]
        }

        if !isRoot && (name.hasPrefix(".") || skipDirs.contains(name)) { return nil }
        guard depth < maxDepth else { return nil }

        let contents = (try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles])) ?? []

        var children: [[String: Any]] = []
        for child in contents.sorted(by: { a, b in
            let ad = (try? a.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            let bd = (try? b.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if ad != bd { return ad }
            return a.lastPathComponent.localizedStandardCompare(b.lastPathComponent) == .orderedAscending
        }) {
            if budget <= 0 { break }
            if let n = node(url: child, depth: depth + 1, maxDepth: maxDepth, budget: &budget, isRoot: false) {
                children.append(n)
            }
        }

        // 目录里没有 Markdown 就不显示（根目录始终显示）
        if children.isEmpty && !isRoot { return nil }
        budget -= 1
        return ["name": name, "path": url.path, "isDir": true, "children": children, "expanded": depth < 1]
    }
}

// MARK: - PDF 导出（本地排版 + 按块边界切页）

final class PDFExporter: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var hostWindow: NSWindow?
    private var schemeHandler: WebSchemeHandler?
    private var destination: URL?
    private var completion: ((Result<(pages: Int, textOK: Bool), Error>) -> Void)?
    private var slices: [CGRect] = []
    private var collected: [PDFPage] = []
    private var cursor = 0
    private var finished = false
    private var watchdog: DispatchWorkItem?

    private let pageWidth: CGFloat = 794          // A4 宽 @96dpi
    private let pageHeight: CGFloat = 1123        // A4 高 @96dpi
    private let a4 = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)

    func export(html: String, to url: URL,
                completion: @escaping (Result<(pages: Int, textOK: Bool), Error>) -> Void) {
        self.destination = url
        self.completion = completion

        let config = WKWebViewConfiguration()
        let handler = WebSchemeHandler(webRoot: Paths.webRoot)
        self.schemeHandler = handler
        config.setURLSchemeHandler(handler, forURLScheme: WebSchemeHandler.scheme)
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight), configuration: config)
        wv.navigationDelegate = self
        self.webView = wv

        // 离屏窗口：让 WebKit 正常布局与分页
        let win = NSWindow(contentRect: wv.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = wv
        win.alphaValue = 0
        win.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        win.orderBack(nil)
        self.hostWindow = win

        let wd = DispatchWorkItem { [weak self] in
            self?.finish(.failure(makeError("PDF 渲染超时")))
        }
        watchdog = wd
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: wd)

        wv.loadHTMLString(html, baseURL: Paths.webRoot)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 等一帧，确保字体与布局稳定
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.measure()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    private func measure() {
        guard let wv = webView else { return }
        let js = "window.__pageBreaks ? JSON.stringify(window.__pageBreaks(\(Int(pageHeight)))) : 'null'"
        wv.evaluateJavaScript(js) { [weak self] result, error in
            guard let self = self else { return }
            if let error = error { self.finish(.failure(error)); return }

            var breaks: [CGFloat] = []
            if let s = result as? String, let d = s.data(using: .utf8),
               let arr = try? JSONSerialization.jsonObject(with: d) as? [NSNumber] {
                breaks = arr.map { CGFloat(truncating: $0) }
            }
            if breaks.count < 2 { breaks = [0, self.pageHeight] }

            self.slices = []
            for i in 0..<(breaks.count - 1) {
                let top = breaks[i]
                let bottom = max(breaks[i + 1], top + 1)
                self.slices.append(CGRect(x: 0, y: top, width: self.pageWidth, height: bottom - top))
            }
            self.cursor = 0
            self.collected = []
            self.captureNext()
        }
    }

    private func captureNext() {
        guard let wv = webView else { return }
        if cursor >= slices.count { merge(); return }
        let rect = slices[cursor]
        let cfg = WKPDFConfiguration()
        cfg.rect = rect
        wv.createPDF(configuration: cfg) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let data):
                if let doc = PDFDocument(data: data), let page = doc.page(at: 0) {
                    self.collected.append(page)
                }
            case .failure(let error):
                self.finish(.failure(error))
                return
            }
            self.cursor += 1
            self.captureNext()
        }
    }

    private func merge() {
        guard let dest = destination else { return }
        guard !collected.isEmpty else {
            finish(.failure(makeError("PDF 渲染未产生任何页面")))
            return
        }

        let out = NSMutableData()
        guard let consumer = CGDataConsumer(data: out as CFMutableData) else {
            finish(.failure(makeError("无法创建 PDF 上下文")))
            return
        }
        var box = a4
        guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else {
            finish(.failure(makeError("无法创建 PDF 上下文")))
            return
        }

        let scale = a4.width / pageWidth
        for page in collected {
            guard let ref = page.pageRef else { continue }
            let pageBox = page.bounds(for: .mediaBox)
            ctx.beginPDFPage(nil)
            ctx.saveGState()
            ctx.scaleBy(x: scale, y: scale)
            // 让切片顶端对齐 A4 顶端
            ctx.translateBy(x: 0, y: (a4.height / scale) - pageBox.height)
            ctx.drawPDFPage(ref)
            ctx.restoreGState()
            ctx.endPDFPage()
        }
        ctx.closePDF()

        do {
            do {
                try (out as Data).write(to: dest, options: .atomic)
            } catch {
                // 某些受限目录不支持原子替换，退化为直接写入
                try (out as Data).write(to: dest)
            }
        } catch {
            finish(.failure(error))
            return
        }

        // 文本层自检：能提取到文字、且没有把汉字映射成「康熙部首」
        // （WebKit 导出的 PDF 常见问题：⽤/⼀/⽂ 等被映射到 U+2E80–U+2FDF，
        //   导致复制或搜索时拿到错误的码位。这里做检测并向用户提示。）
        var textOK = false
        var pageCount = collected.count
        if let doc = PDFDocument(url: dest) {
            pageCount = doc.pageCount
            let s = doc.string ?? ""
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            let hasRadicalForms = s.unicodeScalars.contains { (0x2E80...0x2FDF).contains($0.value) }
            textOK = trimmed.count > 12 && !hasRadicalForms
        }
        finish(.success((pages: pageCount, textOK: textOK)))
    }

    private func finish(_ result: Result<(pages: Int, textOK: Bool), Error>) {
        guard !finished else { return }
        finished = true
        watchdog?.cancel()
        watchdog = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
        hostWindow?.orderOut(nil)
        hostWindow = nil
        completion?(result)
        completion = nil
    }
}
