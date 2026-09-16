import AppKit
import WebKit
import Darwin

final class PlannerApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate, NSWindowDelegate {
    private var item: NSStatusItem!
    private var window: NSPanel!
    private var web: WKWebView!
    private var service: Process?
    private var timer: Timer?
    private var busy = false
    private var ready = false
    private var closing = false
    private var pinned = false
    private var lockFD: Int32 = -1
    private let demo = CommandLine.arguments.contains("--demo")
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private let port = Int.random(in: 44000...55000)
    private var base: URL { URL(string: "http://127.0.0.1:\(port)")! }
    private var dataURL: URL!
    private var lastState: UsageState?
    private var smokeFinished = false
    private func trace(_ message: String) {
        guard CommandLine.arguments.contains("--smoke"), let directory = ProcessInfo.processInfo.environment["PLANNER_SMOKE_DIR"] else { return }
        let url = URL(fileURLWithPath: directory + "/macos-smoke-stage.txt")
        try? message.write(to: url, atomically: true, encoding: .utf8)
    }
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 4
        return URLSession(configuration: config)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        trace("launch")
        do {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            dataURL = support.appendingPathComponent("Codex Usage Planner/\(demo ? "demo" : "live")")
            try FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            lockFD = open(dataURL.appendingPathComponent("app.lock").path, O_CREAT | O_RDWR, 0o600)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { NSApp.terminate(nil); return }
            trace("locked")
            item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.target = self
            item.button?.action = #selector(clicked)
            item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
            showFailure("正在启动本机服务…")
            buildPanel()
            trace("panel built")
            try startService()
            trace("service started")
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke), name: NSWorkspace.didWakeNotification, object: nil)
            poll()
        } catch { fatalStartup(error.localizedDescription) }
    }

    private func executable(_ candidates: [String]) -> String? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    private func startService() throws {
        let resources = Bundle.main.resourceURL!
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var env = ProcessInfo.processInfo.environment
        let node = executable([env["PLANNER_NODE"] ?? "", resources.appendingPathComponent("node").path, "/opt/homebrew/bin/node", "/usr/local/bin/node"])
        guard let node else { throw NSError(domain: "Planner", code: 1, userInfo: [NSLocalizedDescriptionKey: "未找到 Node.js 20+，请重新运行 Build-macOS.command。"] ) }
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        env["PORT"] = String(port)
        env["PLANNER_SESSION_TOKEN"] = token
        env["PLANNER_DATA_DIR"] = dataURL.path
        env["PLANNER_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        if env["CODEX_COMMAND"] == nil, let codex = executable(["\(home)/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/Applications/Codex.app/Contents/Resources/codex"]) {
            env["CODEX_COMMAND"] = String(data: try JSONEncoder().encode([codex]), encoding: .utf8)
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [resources.appendingPathComponent("server/server.mjs").path] + (demo ? ["--demo"] : [])
        p.currentDirectoryURL = resources.appendingPathComponent("server")
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self, !self.closing else { return }
            self.showFailure("本机服务已退出，请从右键菜单退出后重新打开。")
        } }
        service = p
        try p.run()
    }
    private func buildPanel() {
        window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 800, height: 760), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
        window.title = demo ? "Codex 用量节奏 · 演示" : "Codex 用量节奏"
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.level = .floating
        window.delegate = self
        window.minSize = NSSize(width: 520, height: 420)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.contentView?.addSubview(web)
    }
    @objc private func clicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            for (title, action) in [("打开用量面板", #selector(showPanel)), (pinned ? "取消固定面板" : "固定面板", #selector(togglePin)), ("立即刷新", #selector(refresh)), ("打开数据目录", #selector(openData)), ("退出", #selector(quit))] {
                let entry = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
                entry.target = self
            }
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else if window.isVisible { window.orderOut(nil) } else { showPanel() }
    }
    @objc private func showPanel() {
        let screen = item.button?.window?.screen ?? NSScreen.main!
        let area = screen.visibleFrame
        let size = NSSize(width: min(800, area.width - 24), height: min(760, area.height - 24))
        let anchor = item.button?.window?.frame.maxX ?? area.maxX
        window.setFrame(NSRect(x: max(area.minX + 12, min(anchor - size.width, area.maxX - size.width - 12)), y: area.maxY - size.height - 8, width: size.width, height: size.height), display: true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
    @objc private func togglePin() { pinned.toggle(); showPanel() }
    @objc private func openData() { NSWorkspace.shared.open(dataURL) }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func woke() { showFailure("刚从睡眠恢复，正在更新…"); poll() }
    @objc private func refresh() { poll(refresh: true) }
    func windowDidResignKey(_ notification: Notification) { if !pinned, window.attachedSheet == nil { window.orderOut(nil) } }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }

    private func poll(refresh: Bool = false) {
        guard !busy, service?.isRunning == true else { return }
        busy = true
        var request = URLRequest(url: base.appendingPathComponent(refresh ? "api/refresh" : "api/summary"))
        request.setValue(token, forHTTPHeaderField: "X-Planner-Token")
        if refresh { request.httpMethod = "POST"; request.timeoutInterval = 60 }
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, !self.closing else { return }
                self.busy = false
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data, let state = try? JSONDecoder().decode(UsageState.self, from: data) else {
                    self.showFailure("本机状态服务不可达，正在重试…")
                    self.trace("local request: \(error?.localizedDescription ?? "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"); decode: \(data.flatMap { try? JSONDecoder().decode(UsageState.self, from: $0) } == nil ? "failed" : "ok")")
                    return
                }
                if !self.ready {
                    self.ready = true
                    self.web.load(URLRequest(url: self.base.appendingPathComponent("/").appending(queryItems: [URLQueryItem(name: "embedded", value: "1")])))
                    self.showPanel()
                }
                self.lastState = state
                self.item.button?.title = state.title
                self.item.button?.toolTip = state.tooltip
                self.item.button?.image = self.rings(state)
            }
        }.resume()
    }
    private func showFailure(_ message: String) {
        trace(message)
        item?.button?.title = "Codex !"
        item?.button?.toolTip = message
        item?.button?.image = rings(nil)
    }
    private func rings(_ state: UsageState?) -> NSImage {
        let stale = state?.invalid ?? true
        let image = NSImage(size: NSSize(width: 24, height: 24), flipped: false) { rect in
            let center = NSPoint(x: 12, y: 12)
            for (index, radius) in [9.5, 5.5].enumerated() {
                let track = NSBezierPath(ovalIn: NSRect(x: 12 - radius, y: 12 - radius, width: radius * 2, height: radius * 2))
                track.lineWidth = 2.3
                NSColor.secondaryLabelColor.withAlphaComponent(0.35).setStroke(); track.stroke()
                let value = index == 0 ? state?.weekly?.remaining : state?.weekly?.pace
                if !stale, let value, value > 0 {
                    let arc = NSBezierPath()
                    arc.appendArc(withCenter: center, radius: radius, startAngle: 90, endAngle: 90 - 3.6 * min(100, max(0, value)), clockwise: true)
                    arc.lineWidth = 2.3; arc.lineCapStyle = .round
                    let color: NSColor = index == 0 ? .systemGreen : ((state?.weekly?.gap ?? 0) < 0 ? .systemPink : .systemCyan)
                    color.setStroke(); arc.stroke()
                }
            }
            if stale { ("!" as NSString).draw(at: NSPoint(x: 10, y: 5), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: NSColor.labelColor]) }
            return true
        }
        image.isTemplate = false
        return image
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let local = url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
        let export = url.scheme == "blob" && url.absoluteString.hasPrefix("blob:\(base.absoluteString)/")
        decisionHandler(local || export ? (action.shouldPerformDownload ? .download : .allow) : .cancel)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel(); return true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard demo, CommandLine.arguments.contains("--smoke"), !smokeFinished else { return }
        smokeFinished = true
        // Exercise the actual bundled WKWebView, including module JS and local API access.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            webView.evaluateJavaScript("JSON.stringify({status:document.getElementById('status').textContent,actual:document.getElementById('actual').textContent,tabs:document.querySelectorAll('[data-tab]').length})") { value, error in
                guard error == nil, let result = value as? String, result.contains("80.00%") else {
                    fputs("WKWebView smoke failed\n", stderr); NSApp.terminate(nil); return
                }
                let output = ProcessInfo.processInfo.environment["PLANNER_SMOKE_DIR"] ?? NSTemporaryDirectory()
                try? result.write(toFile: output + "/macos-smoke.json", atomically: true, encoding: .utf8)
                webView.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: output + "/macos-smoke.png"))
                    }
                    NSApp.terminate(nil)
                }
            }
        }
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "codex-usage-history.json"
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    private func fatalStartup(_ message: String) {
        let alert = NSAlert(); alert.messageText = "Codex 用量节奏启动失败"; alert.informativeText = message; alert.runModal(); NSApp.terminate(nil)
    }
    func applicationWillTerminate(_ notification: Notification) {
        closing = true
        timer?.invalidate()
        session.invalidateAndCancel()
        if let service, service.isRunning {
            service.terminate()
            let deadline = Date().addingTimeInterval(2)
            while service.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
            if service.isRunning { kill(service.processIdentifier, SIGKILL) }
        }
        if lockFD >= 0 { close(lockFD) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = PlannerApp()
app.delegate = delegate
app.run()
