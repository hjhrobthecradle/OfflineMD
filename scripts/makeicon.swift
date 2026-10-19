// 生成应用图标（纯本地绘制，无外部素材）
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count > 1 else { exit(1) }
let outDir = URL(fileURLWithPath: args[1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func drawIcon(_ size: Int) -> Data? {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    let s = CGFloat(size)
    let inset = s * 0.055
    let rect = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = s * 0.222
    let squircle = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    // 底色渐变（墨色 → 暖棕）
    if let grad = NSGradient(colors: [
        NSColor(srgbRed: 0.145, green: 0.152, blue: 0.165, alpha: 1),
        NSColor(srgbRed: 0.275, green: 0.239, blue: 0.196, alpha: 1)
    ]) {
        grad.draw(in: squircle, angle: -90)
    }

    // 顶部高光
    NSGraphicsContext.saveGraphicsState()
    squircle.addClip()
    if let hl = NSGradient(colors: [
        NSColor(white: 1, alpha: 0.10),
        NSColor(white: 1, alpha: 0.0)
    ]) {
        hl.draw(in: NSRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2), angle: -90)
    }
    NSGraphicsContext.restoreGraphicsState()

    // 内描边
    NSColor(white: 1, alpha: 0.08).setStroke()
    squircle.lineWidth = max(1, s * 0.008)
    squircle.stroke()

    // 主字形 M
    let font = NSFont.systemFont(ofSize: s * 0.44, weight: .semibold)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(srgbRed: 0.949, green: 0.914, blue: 0.847, alpha: 1),
        .kern: -s * 0.006
    ]
    let str = NSAttributedString(string: "M", attributes: attrs)
    let sz = str.size()
    str.draw(at: NSPoint(x: (s - sz.width) / 2, y: s * 0.395))

    // 下方插入符（代表 Markdown 的下行书写）
    let caret = NSBezierPath()
    caret.move(to: NSPoint(x: s * 0.355, y: s * 0.335))
    caret.line(to: NSPoint(x: s * 0.5, y: s * 0.215))
    caret.line(to: NSPoint(x: s * 0.645, y: s * 0.335))
    caret.lineWidth = s * 0.052
    caret.lineCapStyle = .round
    caret.lineJoinStyle = .round
    NSColor(srgbRed: 0.847, green: 0.541, blue: 0.353, alpha: 1).setStroke()
    caret.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

let wanted = [16, 32, 64, 128, 256, 512, 1024]
var rendered: [Int: Data] = [:]
for size in wanted {
    guard let data = drawIcon(size) else { continue }
    rendered[size] = data
    try? data.write(to: outDir.appendingPathComponent("icon_\(size).png"))
}

// 直接写 ICNS 容器（避免依赖 iconutil）
func be32(_ v: UInt32) -> Data {
    var x = v.bigEndian
    return Data(bytes: &x, count: 4)
}

let icnsTypes: [(String, Int)] = [
    ("icp4", 16), ("icp5", 32), ("icp6", 64),
    ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024)
]
var body = Data()
for (tag, size) in icnsTypes {
    guard let png = rendered[size] else { continue }
    body.append(tag.data(using: .ascii)!)
    body.append(be32(UInt32(png.count + 8)))
    body.append(png)
}
var icns = Data("icns".utf8)
icns.append(be32(UInt32(body.count + 8)))
icns.append(body)

let icnsURL = outDir.deletingLastPathComponent().appendingPathComponent("AppIcon.icns")
try? icns.write(to: icnsURL)
print("icons written to \(outDir.path), icns \(icns.count) bytes")

