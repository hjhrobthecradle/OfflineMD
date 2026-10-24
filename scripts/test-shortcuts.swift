import Foundation

let fileManager = FileManager.default
let currentDir = fileManager.currentDirectoryPath
let buildDir = "\(currentDir)/build"
let binPath = "\(buildDir)/test-shortcuts"

try? fileManager.createDirectory(atPath: buildDir, withIntermediateDirectories: true)

// 检查是否需要重新编译
let runnerSwift = "\(currentDir)/scripts/test-shortcuts-runner.swift"
let appDelegateSwift = "\(currentDir)/src/native/AppDelegate.swift"
var needsCompile = !fileManager.fileExists(atPath: binPath)

if !needsCompile,
   let binAttr = try? fileManager.attributesOfItem(atPath: binPath),
   let binDate = binAttr[.modificationDate] as? Date,
   let runnerAttr = try? fileManager.attributesOfItem(atPath: runnerSwift),
   let runnerDate = runnerAttr[.modificationDate] as? Date,
   let appAttr = try? fileManager.attributesOfItem(atPath: appDelegateSwift),
   let appDate = appAttr[.modificationDate] as? Date {
    if runnerDate > binDate || appDate > binDate {
        needsCompile = true
    }
}

if needsCompile {
    let compileProcess = Process()
    compileProcess.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    compileProcess.arguments = [
        "swiftc", "-parse-as-library", "-O",
        "-framework", "AppKit", "-framework", "WebKit", "-framework", "PDFKit",
        runnerSwift,
        "\(currentDir)/src/native/AppDelegate.swift",
        "\(currentDir)/src/native/EditorWindow.swift",
        "\(currentDir)/src/native/Bridge.swift",
        "\(currentDir)/src/native/Services.swift",
        "-o", binPath
    ]
    try compileProcess.run()
    compileProcess.waitUntilExit()
    if compileProcess.terminationStatus != 0 {
        exit(compileProcess.terminationStatus)
    }
}

// 转发命令行参数并执行二进制
let proc = Process()
proc.executableURL = URL(fileURLWithPath: binPath)
proc.arguments = Array(CommandLine.arguments.dropFirst())
try proc.run()
proc.waitUntilExit()
exit(proc.terminationStatus)
