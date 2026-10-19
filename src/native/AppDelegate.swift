import Foundation
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {

    var windowController: EditorWindowController!
    private var pendingOpenPath: String?
    private var recentMenuDelegate: RecentMenuDelegate?

    // MARK: - 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        windowController = EditorWindowController()
        windowController.showWindow(nil)
        windowController.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let zoom = UserDefaults.standard.object(forKey: "pref.pageZoom") as? Double, zoom > 0.3 {
            windowController.webView?.pageZoom = CGFloat(zoom)
        }

        SnapshotStore.shared.prune()

        if let path = pendingOpenPath {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.windowController.openFile(at: path)
            }
            pendingOpenPath = nil
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        if windowController == nil {
            pendingOpenPath = url.path
        } else {
            windowController.openFile(at: url.path)
        }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: - 菜单

    private func send(_ action: String, arg: Any? = nil) {
        guard let wc = windowController else { return }
        let js: String
        if let arg = arg {
            js = "window.__nativeMenu && window.__nativeMenu(\(jsonString(action)), \(jsonString(arg)));"
        } else {
            js = "window.__nativeMenu && window.__nativeMenu(\(jsonString(action)));"
        }
        wc.webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc private func menuAction(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        send(action)
    }

    @discardableResult
    private func item(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "",
                      _ mods: NSEvent.ModifierFlags = .command, _ payload: String? = nil,
                      target: AnyObject? = nil) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if !key.isEmpty { mi.keyEquivalentModifierMask = mods }
        if let payload = payload { mi.representedObject = payload }
        if let action = action {
            mi.target = (target as AnyObject?) ?? self
        } else {
            mi.target = nil
        }
        menu.addItem(mi)
        return mi
    }

    private func submenu(_ parent: NSMenu, _ title: String) -> NSMenu {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu(title: title)
        holder.submenu = sub
        parent.addItem(holder)
        return sub
    }

    private func buildMenu() {
        let main = NSMenu()
        NSApp.mainMenu = main

        // ---- 应用菜单 ----
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 OfflineMD",
                        action: #selector(showAbout), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "快捷键与说明", action: #selector(showShortcuts), keyEquivalent: "/")
        settings.keyEquivalentModifierMask = .command
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 OfflineMD", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 OfflineMD", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // ---- 文件 ----
        let file = submenu(main, "文件")
        item(file, "新建", #selector(menuAction), "n", .command, "file.new")
        item(file, "打开…", #selector(menuAction), "o", .command, "file.open")
        item(file, "打开文件夹…", #selector(menuAction), "o", [.command, .shift], "file.openFolder")

        let recentHolder = NSMenuItem(title: "打开最近使用", action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(title: "打开最近使用")
        let rd = RecentMenuDelegate(app: self)
        recentMenuDelegate = rd
        recentMenu.delegate = rd
        recentHolder.submenu = recentMenu
        file.addItem(recentHolder)

        file.addItem(.separator())
        item(file, "保存", #selector(menuAction), "s", .command, "file.save")
        item(file, "另存为…", #selector(menuAction), "s", [.command, .shift], "file.saveAs")
        item(file, "在访达中显示", #selector(menuAction), "", .command, "file.reveal")
        file.addItem(.separator())
        item(file, "导出为 HTML…", #selector(menuAction), "e", .command, "file.exportHTML")
        item(file, "导出为 PDF…", #selector(menuAction), "e", [.command, .shift], "file.exportPDF")
        file.addItem(.separator())
        item(file, "关闭窗口", #selector(NSWindow.performClose(_:)), "w", .command, nil, target: nil)

        // ---- 编辑 ----
        let edit = submenu(main, "编辑")
        item(edit, "撤销", Selector(("undo:")), "z", .command, nil, target: nil)
        item(edit, "重做", Selector(("redo:")), "z", [.command, .shift], nil, target: nil)
        edit.addItem(.separator())
        item(edit, "剪切", #selector(NSText.cut(_:)), "x", .command, nil, target: nil)
        item(edit, "拷贝", #selector(NSText.copy(_:)), "c", .command, nil, target: nil)
        item(edit, "粘贴", #selector(NSText.paste(_:)), "v", .command, nil, target: nil)
        item(edit, "全选", #selector(NSText.selectAll(_:)), "a", .command, nil, target: nil)
        edit.addItem(.separator())
        item(edit, "查找…", #selector(menuAction), "f", .command, "edit.find")
        item(edit, "查找下一个", #selector(menuAction), "g", .command, "edit.findNext")
        item(edit, "查找上一个", #selector(menuAction), "g", [.command, .shift], "edit.findPrev")
        item(edit, "替换…", #selector(menuAction), "f", [.command, .option], "edit.replace")

        // ---- 视图 ----
        let view = submenu(main, "视图")
        item(view, "所见即所得", #selector(menuAction), "1", .command, "view.wysiwyg")
        item(view, "源码模式", #selector(menuAction), "2", .command, "view.source")
        item(view, "分栏模式", #selector(menuAction), "3", .command, "view.split")
        item(view, "预览模式", #selector(menuAction), "4", .command, "view.preview")
        view.addItem(.separator())
        item(view, "显示侧栏", #selector(menuAction), "l", [.command, .shift], "view.sidebar")
        item(view, "专注模式", #selector(menuAction), "f", [.command, .option], "view.focus")
        item(view, "打字机模式", #selector(menuAction), "t", [.command, .option], "view.typewriter")
        view.addItem(.separator())

        let themeMenu = submenu(view, "主题")
        item(themeMenu, "纸白", #selector(menuAction), "", .command, "view.theme:paper")
        item(themeMenu, "石墨", #selector(menuAction), "", .command, "view.theme:graphite")
        item(themeMenu, "夜阑", #selector(menuAction), "", .command, "view.theme:night")
        item(themeMenu, "松墨", #selector(menuAction), "", .command, "view.theme:moss")
        themeMenu.addItem(.separator())
        item(themeMenu, "下一个主题", #selector(menuAction), "t", [.command, .control], "view.themeNext")

        view.addItem(.separator())
        let zoomIn = NSMenuItem(title: "放大", action: #selector(zoomIn), keyEquivalent: "+")
        zoomIn.target = self
        view.addItem(zoomIn)
        let zoomOut = NSMenuItem(title: "缩小", action: #selector(zoomOut), keyEquivalent: "-")
        zoomOut.target = self
        view.addItem(zoomOut)
        let zoomReset = NSMenuItem(title: "实际大小", action: #selector(zoomReset), keyEquivalent: "0")
        zoomReset.target = self
        view.addItem(zoomReset)

        // ---- 格式 ----
        let format = submenu(main, "格式")
        item(format, "粗体", #selector(menuAction), "b", .command, "format.bold")
        item(format, "斜体", #selector(menuAction), "i", .command, "format.italic")
        item(format, "下划线", #selector(menuAction), "u", .command, "format.underline")
        item(format, "删除线", #selector(menuAction), "s", [.command, .option], "format.strike")
        item(format, "行内代码", #selector(menuAction), "`", .command, "format.code")
        format.addItem(.separator())
        item(format, "标题 1", #selector(menuAction), "1", [.command, .control], "format.h1")
        item(format, "标题 2", #selector(menuAction), "2", [.command, .control], "format.h2")
        item(format, "标题 3", #selector(menuAction), "3", [.command, .control], "format.h3")
        item(format, "标题 4", #selector(menuAction), "4", [.command, .control], "format.h4")
        format.addItem(.separator())
        item(format, "引用", #selector(menuAction), "q", [.command, .control], "format.quote")
        item(format, "无序列表", #selector(menuAction), "u", [.command, .control], "format.ul")
        item(format, "有序列表", #selector(menuAction), "l", [.command, .control], "format.ol")
        item(format, "任务列表", #selector(menuAction), "t", [.command, .control], "format.task")
        item(format, "表格", #selector(menuAction), "k", [.command, .control], "format.table")
        item(format, "分隔线", #selector(menuAction), "h", [.command, .control], "format.hr")
        format.addItem(.separator())
        item(format, "代码块", #selector(menuAction), "k", [.command, .shift], "format.codeblock")
        item(format, "公式块", #selector(menuAction), "m", [.command, .control], "format.math")
        item(format, "Mermaid 图表", #selector(menuAction), "d", [.command, .control], "format.mermaid")
        format.addItem(.separator())
        item(format, "链接", #selector(menuAction), "k", .command, "format.link")
        item(format, "图片", #selector(menuAction), "i", [.command, .control], "format.image")

        // ---- 窗口 ----
        let windowMenu = submenu(main, "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        // ---- 帮助 ----
        let help = submenu(main, "帮助")
        item(help, "快捷键与说明", #selector(showShortcuts), "/", .command, nil)
        item(help, "关于离线实现", #selector(showAbout), "", .command, nil)
    }

    // MARK: - 动作

    @objc private func showAbout() {
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let credits = NSMutableAttributedString(string:
            "完全离线的 Markdown 编辑器\n\n" +
            "不含授权校验、自动更新与遥测上报。\n" +
            "公式、图表、代码高亮均在本地渲染。",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: para
            ])
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "OfflineMD",
            .applicationVersion: AppInfo.version,
            .version: AppInfo.build,
            .credits: credits
        ])
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showShortcuts() { send("help.shortcuts") }

    @objc private func zoomIn() { windowController?.zoom(0.1) }
    @objc private func zoomOut() { windowController?.zoom(-0.1) }
    @objc private func zoomReset() { windowController?.resetZoom() }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        windowController?.openFile(at: path)
    }

    @objc func clearRecents() {
        Recents.clear()
    }
}

// MARK: - 最近打开菜单

final class RecentMenuDelegate: NSObject, NSMenuDelegate {
    weak var app: AppDelegate?
    init(app: AppDelegate) { self.app = app; super.init() }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let list = Recents.list()
        if list.isEmpty {
            let empty = NSMenuItem(title: "（无）", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        for path in list {
            let mi = NSMenuItem(title: (path as NSString).lastPathComponent,
                                action: #selector(AppDelegate.openRecent(_:)),
                                keyEquivalent: "")
            mi.target = app
            mi.representedObject = path
            mi.toolTip = path
            menu.addItem(mi)
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "清除最近打开", action: #selector(AppDelegate.clearRecents), keyEquivalent: "")
        clear.target = app
        menu.addItem(clear)
    }
}
