import Foundation
import AppKit
import WebKit
import UniformTypeIdentifiers

/// JS ↔ 原生 的指令分发
final class Bridge: NSObject, WKScriptMessageHandler {

    weak var webView: WKWebView?
    weak var windowController: EditorWindowController?

    private var currentPath: String?
    private var pdfExporter: PDFExporter?     // 强引用，直到导出结束

    private var window: NSWindow? { windowController?.window }

    // MARK: - 消息入口

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard message.name == "native",
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let cmd = body["cmd"] as? String else { return }
        let args = body["args"] as? [String: Any] ?? [:]
        DispatchQueue.main.async { self.handle(id: id, cmd: cmd, args: args) }
    }

    private func reply(_ id: String, _ result: Result<Any?, Error>) {
        var payload: [String: Any] = [:]
        switch result {
        case .success(let value):
            payload["ok"] = true
            payload["data"] = value ?? NSNull()
        case .failure(let error):
            payload["ok"] = false
            payload["error"] = error.localizedDescription
        }
        let js = "window.__nativeResolve(\(jsonString(id)), \(jsonString(payload)));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func ok(_ id: String, _ data: Any? = nil) { reply(id, .success(data)) }
    private func fail(_ id: String, _ message: String) { reply(id, .failure(makeError(message))) }

    // MARK: - 分发

    private func handle(id: String, cmd: String, args: [String: Any]) {
        switch cmd {
        case "prefs.get":      ok(id, readPrefs())
        case "prefs.set":      writePrefs(args); ok(id)
        case "win.title":      applyTitle(args); ok(id)

        case "doc.open":       presentOpenPanel(id)
        case "doc.readPath":   readDocument(id, args)
        case "doc.save":       saveDocument(id, args)
        case "doc.exportHTML": exportHTML(id, args)
        case "doc.exportPDF":  exportPDF(id, args)
        case "doc.reveal":     reveal(id, args)

        case "folder.open":    presentFolderPanel(id)

        case "image.save":     saveImage(id, args)

        case "snap.save":      saveSnap(id, args)
        case "snap.load":      loadSnap(id, args)
        case "snap.clear":     clearSnap(id, args)
        case "snap.list":      ok(id, SnapshotStore.shared.list())

        case "recent.list":    ok(id, Recents.list())
        case "recent.add":     if let p = args["path"] as? String { Recents.add(p) }; ok(id)
        case "recent.clear":   Recents.clear(); ok(id)

        case "asset.base64":   assetBase64(id, args)
        case "shell.openExternal": openExternal(id, args)

        default:               fail(id, "未知指令：\(cmd)")
        }
    }

    // MARK: - 偏好

    private func readPrefs() -> [String: Any] {
        var out: [String: Any] = [:]
        for key in ["theme", "view", "sidebar", "tab", "focus", "typewriter"] {
            if let v = UserDefaults.standard.object(forKey: "pref." + key) { out[key] = v }
        }
        let ratio = UserDefaults.standard.double(forKey: "pref.splitRatio")
        if ratio > 0 { out["splitRatio"] = ratio }
        return out
    }

    private func writePrefs(_ args: [String: Any]) {
        guard let value = args["value"] as? [String: Any] else { return }
        for (k, v) in value {
            if v is NSNull { continue }
            UserDefaults.standard.set(v, forKey: "pref." + k)
        }
    }

    private func applyTitle(_ args: [String: Any]) {
        let title = (args["title"] as? String) ?? "未命名"
        let dirty = (args["dirty"] as? Bool) ?? false
        window?.title = title
        window?.isDocumentEdited = dirty
        if let path = currentPath {
            window?.subtitle = (path as NSString).deletingLastPathComponent
        } else {
            window?.subtitle = "未保存"
        }
    }

    // MARK: - 打开 / 读取

    private func presentOpenPanel(_ id: String) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedFileTypes = ["md", "markdown", "mdown", "mkd", "txt", "text"]
        panel.message = "选择要打开的 Markdown 文件"
        panel.prompt = "打开"

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self = self, resp == .OK, let url = panel.url else { self?.ok(id, nil); return }
            do {
                let content = try Self.readText(url)
                self.currentPath = url.path
                self.ok(id, ["path": url.path, "content": content, "mtime": Self.mtime(url)])
            } catch {
                self.fail(id, "读取失败：\(error.localizedDescription)")
            }
        }

        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) }
        else { panel.begin(completionHandler: handler) }
    }

    private func presentFolderPanel(_ id: String) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "选择一个文件夹作为工作区"
        panel.prompt = "打开"

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self = self, resp == .OK, let url = panel.url else { self?.ok(id, nil); return }
            if let tree = FileTree.build(root: url) {
                self.ok(id, ["path": url.path, "tree": tree])
            } else {
                self.fail(id, "无法读取该文件夹")
            }
        }

        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) }
        else { panel.begin(completionHandler: handler) }
    }

    private func readDocument(_ id: String, _ args: [String: Any]) {
        guard let path = args["path"] as? String else { fail(id, "缺少路径"); return }
        do {
            let content = try Self.readText(URL(fileURLWithPath: path))
            currentPath = path
            ok(id, ["path": path, "content": content, "mtime": Self.mtime(URL(fileURLWithPath: path))])
        } catch {
            fail(id, "读取失败：\(error.localizedDescription)")
        }
    }

    // MARK: - 保存

    private func saveDocument(_ id: String, _ args: [String: Any]) {
        let content = (args["content"] as? String) ?? ""
        let suggested = (args["suggestedName"] as? String) ?? "未命名.md"

        if let path = args["path"] as? String, !path.isEmpty {
            writeText(content, to: URL(fileURLWithPath: path), id: id)
            return
        }

        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggested
        panel.allowedFileTypes = ["md", "markdown", "txt"]
        panel.message = "保存 Markdown 文件"
        panel.canCreateDirectories = true

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self = self, resp == .OK, let url = panel.url else { self?.ok(id, nil); return }
            self.writeText(content, to: url, id: id)
        }

        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) }
        else { panel.begin(completionHandler: handler) }
    }

    private func writeText(_ text: String, to url: URL, id: String) {
        do {
            try text.data(using: .utf8)?.write(to: url, options: .atomic)
            currentPath = url.path
            Recents.add(url.path)
            ok(id, ["path": url.path])
        } catch {
            fail(id, "写入失败：\(error.localizedDescription)")
        }
    }

    // MARK: - 导出

    private func exportHTML(_ id: String, _ args: [String: Any]) {
        guard let html = args["html"] as? String else { fail(id, "缺少内容"); return }
        let suggested = (args["suggestedName"] as? String) ?? "导出.html"

        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggested
        panel.allowedFileTypes = ["html", "htm"]
        panel.message = "导出为单文件 HTML（样式与字体内联）"

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self = self, resp == .OK, let url = panel.url else { self?.ok(id, nil); return }
            do {
                try html.data(using: .utf8)?.write(to: url, options: .atomic)
                self.ok(id, ["path": url.path])
            } catch {
                self.fail(id, "写入失败：\(error.localizedDescription)")
            }
        }

        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) }
        else { panel.begin(completionHandler: handler) }
    }

    private func exportPDF(_ id: String, _ args: [String: Any]) {
        guard let html = args["html"] as? String else { fail(id, "缺少内容"); return }
        let suggested = (args["suggestedName"] as? String) ?? "导出.pdf"

        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggested
        panel.allowedFileTypes = ["pdf"]
        panel.message = "导出为 PDF（A4 分页）"

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self = self, resp == .OK, let url = panel.url else { self?.ok(id, nil); return }

            let exporter = PDFExporter()
            self.pdfExporter = exporter
            exporter.export(html: html, to: url) { result in
                self.pdfExporter = nil
                switch result {
                case .success(let info):
                    self.ok(id, ["path": url.path, "pages": info.pages, "textOK": info.textOK])
                case .failure(let error):
                    self.fail(id, "PDF 导出失败：\(error.localizedDescription)")
                }
            }
        }

        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) }
        else { panel.begin(completionHandler: handler) }
    }

    private func reveal(_ id: String, _ args: [String: Any]) {
        guard let path = args["path"] as? String else { fail(id, "缺少路径"); return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        ok(id)
    }

    // MARK: - 图片（本地化替代图床）

    private func saveImage(_ id: String, _ args: [String: Any]) {
        guard let dataUrl = args["dataUrl"] as? String,
              let docPath = args["docPath"] as? String, !docPath.isEmpty else {
            fail(id, "需要先保存文档")
            return
        }
        guard let comma = dataUrl.firstIndex(of: ",") else { fail(id, "图片数据无效"); return }

        let header = String(dataUrl[dataUrl.startIndex..<comma])
        let b64 = String(dataUrl[dataUrl.index(after: comma)...])
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
            fail(id, "图片解码失败")
            return
        }

        var ext = "png"
        if let range = header.range(of: "data:image/") {
            let rest = header[range.upperBound...]
            ext = String(rest.split(separator: ";").first ?? "png")
        }
        if ext == "jpeg" { ext = "jpg" }
        if ext.isEmpty || ext.count > 5 { ext = "png" }

        let docDir = (docPath as NSString).deletingLastPathComponent
        let assetsDir = URL(fileURLWithPath: docDir).appendingPathComponent("assets", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)
        } catch {
            fail(id, "无法创建 assets 目录：\(error.localizedDescription)")
            return
        }

        let rawName = ((args["name"] as? String) ?? "image")
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        let stem = ((rawName as NSString).deletingPathExtension.isEmpty
                    ? "image" : (rawName as NSString).deletingPathExtension)
            .replacingOccurrences(of: " ", with: "-")

        var fileName = "\(stem).\(ext)"
        var counter = 1
        while FileManager.default.fileExists(atPath: assetsDir.appendingPathComponent(fileName).path) {
            fileName = "\(stem)-\(counter).\(ext)"
            counter += 1
        }

        let target = assetsDir.appendingPathComponent(fileName)
        do {
            try data.write(to: target, options: .atomic)
            ok(id, ["rel": "assets/" + fileName, "abs": target.path])
        } catch {
            fail(id, "图片写入失败：\(error.localizedDescription)")
        }
    }

    // MARK: - 快照

    private func saveSnap(_ id: String, _ args: [String: Any]) {
        guard let key = args["key"] as? String, !key.isEmpty,
              let content = args["content"] as? String else { ok(id); return }
        SnapshotStore.shared.save(
            key: key,
            path: (args["path"] as? String) ?? "",
            title: (args["title"] as? String) ?? "",
            content: content,
            cursor: (args["cursor"] as? Int) ?? 0,
            scroll: (args["scroll"] as? Int) ?? 0
        )
        ok(id)
    }

    private func loadSnap(_ id: String, _ args: [String: Any]) {
        guard let key = args["key"] as? String else { fail(id, "缺少 key"); return }
        ok(id, SnapshotStore.shared.load(key: key))
    }

    private func clearSnap(_ id: String, _ args: [String: Any]) {
        if let key = args["key"] as? String, !key.isEmpty {
            SnapshotStore.shared.clear(key: key)
        }
        ok(id)
    }

    // MARK: - 资源

    private func assetBase64(_ id: String, _ args: [String: Any]) {
        guard let path = args["path"] as? String, !path.isEmpty else { fail(id, "缺少路径"); return }

        let url: URL
        if path.hasPrefix("/") {
            url = URL(fileURLWithPath: path)
        } else {
            url = Paths.webRoot.appendingPathComponent(path)
        }

        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else {
            fail(id, "资源不存在：\(path)")
            return
        }
        ok(id, ["mime": Mime.of(url.path), "data": data.base64EncodedString()])
    }

    private func openExternal(_ id: String, _ args: [String: Any]) {
        guard let s = args["url"] as? String, let url = URL(string: s),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            fail(id, "只允许打开 http/https 链接")
            return
        }
        NSWorkspace.shared.open(url)
        ok(id)
    }

    // MARK: - 工具

    static func readText(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url)
        if let s = String(data: data, encoding: .utf8) {
            return s.hasPrefix("\u{FEFF}") ? String(s.dropFirst()) : s
        }
        // 兼容 GB18030（中文用户常见的非 UTF-8 文本）
        let gb = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
        if let s = String(data: data, encoding: String.Encoding(rawValue: gb)) { return s }
        if let s = String(data: data, encoding: .utf16) { return s }
        throw makeError("无法识别文本编码")
    }

    static func mtime(_ url: URL) -> Double {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    }
}
