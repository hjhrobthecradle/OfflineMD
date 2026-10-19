// 把 PDF 每页渲染成 PNG，便于目视检查排版（单文件，顶层代码）
import Foundation
import AppKit
import PDFKit

setvbuf(stdout, nil, _IONBF, 0)
let args = CommandLine.arguments
guard args.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    print("usage: pdf2png <in.pdf> <outPrefix> [scale]")
    exit(1)
}
let scale = args.count > 3 ? (Double(args[3]) ?? 1.6) : 1.6

for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let box = page.bounds(for: .mediaBox)
    let size = NSSize(width: box.width * scale, height: box.height * scale)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    if let ctx = NSGraphicsContext.current?.cgContext {
        ctx.saveGState()
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        ctx.restoreGState()
    }
    img.unlockFocus()
    if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
        let out = "\(args[2])-p\(i + 1).png"
        try? png.write(to: URL(fileURLWithPath: out))
        print("wrote \(out) \(Int(box.width))x\(Int(box.height))pt")
    }
}
