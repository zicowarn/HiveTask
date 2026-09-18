// 离屏 WKWebView 探针（轮询取结果版）：加载页面 → 注入异步 JS → 轮询 window.__out → 打印 + 快照
//
// 用途：在**真引擎**里跑一次我们当前的代码（jsdom 没有 WebGL/没有真布局，验不了的东西）。
// 不激活、窗口在屏幕外，不干扰正在用的应用。
//
//   swift scripts/wk-probe.swift "http://localhost:1420/" "$(cat /tmp/your-injected.js)" /tmp/out.png
//
// 注入的 JS 只需把结果写进 `window.__out`（字符串）；异步请在 IIFE 里做。
//
// ⚠️ 按 scripts/smoke.md 的收录纪律：本脚本目前**只成功用过 1 次**（2026-09-18 3D 全格式
//    解析 + WebGL2 创建 + 渲染读回），**未达"连续成功 3 次"的收录门槛**，故不写进手册的
//    可靠配方表；用的时候留个心眼，失败先怀疑探针本身而不是被测代码。
import AppKit
import WebKit

let url = CommandLine.arguments[1]
let js = CommandLine.arguments[2]
let shot = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let cfg = WKWebViewConfiguration()
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: cfg)
let win = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 900, height: 700),
                   styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = view
win.orderBack(nil)

final class Nav: NSObject, WKNavigationDelegate {
    var done = false
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done = true }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("NAV FAIL \(e)"); exit(2) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { print("NAV PROV FAIL \(e)"); exit(2) }
}
let nav = Nav()
view.navigationDelegate = nav
view.load(URLRequest(url: URL(string: url)!))
let deadline = Date().addingTimeInterval(30)
while !nav.done && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
if !nav.done { print("TIMEOUT load"); exit(3) }
RunLoop.current.run(until: Date().addingTimeInterval(2.0))

view.evaluateJavaScript(js) { _, e in if let e { print("INJECT ERROR \(e)") } }

var result: Any?
let d2 = Date().addingTimeInterval(40)
while Date() < d2 {
    var got = false
    view.evaluateJavaScript("window.__out === undefined ? null : window.__out") { r, _ in
        if let r, !(r is NSNull) { result = r; got = true }
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    if got { break }
}
print(result as? String ?? "nil")

if !shot.isEmpty {
    var snapDone = false
    let c = WKSnapshotConfiguration(); c.rect = view.bounds
    view.takeSnapshot(with: c) { img, _ in
        if let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: shot)); print("snapshot -> \(shot)")
        }
        snapDone = true
    }
    let d3 = Date().addingTimeInterval(15)
    while !snapDone && Date() < d3 { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
}
exit(0)
