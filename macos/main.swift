// HarFiddle.app — a tiny native shell around the HarFiddle engine.
//
// It starts `node server.js` from the app bundle (bundled Node first, then a system install),
// waits for the UI port to answer, and shows the UI in a WKWebView. Quitting the app stops the
// engine, which restores the system proxy if capture was on.
//
// The proxy port is normally set in Tools › Options › Connections. To force ports instead:
//   defaults write io.github.harfiddle ProxyPort 9000
//   defaults write io.github.harfiddle UIPort 9001
import Cocoa
import WebKit
import UniformTypeIdentifiers

/// The web view also tells the page where dropped files live on disk, so Save can write back to an opened HAR.
final class HarFiddleWebView: WKWebView {
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty, let json = try? JSONSerialization.data(withJSONObject: urls.map { $0.path }),
           let list = String(data: json, encoding: .utf8) {
            // sent before WebKit delivers the drop, so the page has the paths when its drop handler runs
            evaluateJavaScript("window.__dropPaths = \(list); window.__dropPathsAt = Date.now();", completionHandler: nil)
        }
        return super.performDragOperation(sender)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var serverLog = ""
    var quitting = false

    lazy var proxyPort: Int = port("ProxyPort", 8888)
    lazy var uiPort: Int = port("UIPort", 8899)
    var uiURL: URL { URL(string: "http://127.0.0.1:\(uiPort)/")! }

    func port(_ key: String, _ fallback: Int) -> Int {
        let v = UserDefaults.standard.integer(forKey: key)
        return (1...65535).contains(v) ? v : fallback
    }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "harfiddle")
        webView = HarFiddleWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "HarFiddle"
        window.minSize = NSSize(width: 900, height: 520)
        window.contentView = webView
        window.setFrameAutosaveName("HarFiddleMainWindow")
        if !window.setFrameUsingName("HarFiddleMainWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showMessage("Starting HarFiddle…")
        startEngine()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let p = server, p.isRunning else { return .terminateNow }
        quitting = true
        p.terminate() // SIGTERM: the engine saves state and restores the system proxy
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(5)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    // MARK: engine

    func startEngine() {
        ping { alive in
            if alive { self.loadUI(); return } // already running (e.g. started from Terminal): just attach
            self.spawnEngine()
        }
    }

    func spawnEngine() {
        // never start a second engine while ours is still starting up (Retry, failed page loads)
        if let p = server, p.isRunning { waitForEngine(attempt: 0); return }
        guard let resources = Bundle.main.resourceURL else { return }
        let appDir = resources.appendingPathComponent("app")
        guard let node = findNode() else {
            fail("Node.js was not found.",
                 "HarFiddle needs Node.js 18 or newer. Install it from https://nodejs.org, or use a release build that bundles Node.")
            return
        }
        let p = Process()
        p.executableURL = node
        var args = [appDir.appendingPathComponent("server.js").path,
                    "--no-open", "--exit-with-parent", "--ui-port", String(uiPort)]
        // Only force the proxy port when set with `defaults write`; otherwise the engine uses the port
        // chosen in Tools › Options › Connections (default 8888).
        if UserDefaults.standard.object(forKey: "ProxyPort") != nil { args += ["--port", String(proxyPort)] }
        p.arguments = args
        p.currentDirectoryURL = appDir
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return } // end of output: stop polling
            let s = String(decoding: data, as: UTF8.self) // lossy: a character split across reads isn't dropped
            DispatchQueue.main.async {
                self.serverLog += s
                if self.serverLog.count > 20_000 { self.serverLog = String(self.serverLog.suffix(10_000)) }
            }
        }
        p.terminationHandler = { proc in
            DispatchQueue.main.async { self.engineExited(proc.terminationStatus) }
        }
        do {
            try p.run()
            server = p
            waitForEngine(attempt: 0)
        } catch {
            fail("Could not start the HarFiddle engine.", error.localizedDescription)
        }
    }

    func waitForEngine(attempt: Int) {
        ping { alive in
            if alive { self.loadUI(); return }
            guard let p = self.server, p.isRunning else { return } // engineExited reports the error
            if attempt > 150 { self.fail("The HarFiddle engine did not start.", self.serverLog); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForEngine(attempt: attempt + 1) }
        }
    }

    func engineExited(_ status: Int32) {
        server = nil
        if quitting { return }
        let log = serverLog.trimmingCharacters(in: .whitespacesAndNewlines)
        var hint = ""
        if log.contains("UI port") {
            hint = "Another program is using the UI port \(uiPort). Quit it, or pick another port:\ndefaults write io.github.harfiddle UIPort 9001"
        } else if log.contains("Proxy port") {
            hint = "Another program (or another HarFiddle) is using the proxy port shown above. Quit it, or start on another port:\ndefaults write io.github.harfiddle ProxyPort 9000\n(then pick a permanent port in Tools › Options › Connections and run: defaults delete io.github.harfiddle ProxyPort)"
        }
        fail("The HarFiddle engine stopped (exit code \(status)).",
             (log.isEmpty ? "" : String(log.suffix(1500)) + "\n\n") + hint)
    }

    func ping(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: uiURL.appendingPathComponent("api/info"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 &&
                (data.map { String(decoding: $0, as: UTF8.self).contains("proxyPort") } ?? false)
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func findNode() -> URL? {
        let fm = FileManager.default
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("node/node"), fm.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        let nvm = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) {
                candidates.append("\(nvm)/\(v)/bin/node")
            }
        }
        if let found = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) { return URL(fileURLWithPath: found) }
        // last resort: ask a login shell (GUI apps don't inherit the shell PATH)
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        sh.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        sh.standardOutput = out
        sh.standardError = FileHandle.nullDevice
        guard (try? sh.run()) != nil else { return nil }
        sh.waitUntilExit()
        let path = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return fm.isExecutableFile(atPath: path) ? URL(fileURLWithPath: path) : nil
    }

    // MARK: UI

    func loadUI() { webView.load(URLRequest(url: uiURL)) }

    func showMessage(_ text: String) {
        let html = """
        <!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;
        background:#f0f0f0;font:13px -apple-system,'Segoe UI',sans-serif;color:#555">\(text)</body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func fail(_ title: String, _ detail: String) {
        showMessage(title)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            serverLog = ""
            showMessage("Starting HarFiddle…")
            startEngine()
        } else {
            NSApp.terminate(nil)
        }
    }

    @objc func reloadUI(_ sender: Any?) { loadUI() }
    @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(uiURL) }
    @objc func openDataFolder(_ sender: Any?) {
        NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.harfiddle"))
    }

    // MARK: WKNavigationDelegate

    /// Only web and mail links are ever handed to other apps. A captured or imported page shown in WebView must
    /// not be able to launch apps or custom URL schemes (file:, x-app:, …).
    func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let local = ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == uiPort
        if local || url.scheme == "about" || url.scheme == "data" { return decisionHandler(.allow) }
        // links in HarFiddle's own page open in the default browser; anything a sub-frame (a previewed
        // response) tries to load or navigate to is simply blocked
        if action.targetFrame?.isMainFrame ?? true, action.navigationType == .linkActivated || action.targetFrame == nil {
            openExternally(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = response.response as? HTTPURLResponse
        let attachment = http?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") ?? false
        if attachment || !response.canShowMIMEType, let url = response.response.url {
            // Files (Save HAR, Export Root Certificate) are saved by the app itself, not by WebKit's download
            // machinery: WebKit aborts the whole app if a download's destination question goes unanswered.
            decisionHandler(.cancel)
            saveFile(from: url, suggestedName: response.response.suggestedFilename ?? url.lastPathComponent)
            return
        }
        decisionHandler(.allow)
    }

    /// Asks where to save, then fetches the file from the engine straight to that location.
    func saveFile(from url: URL, suggestedName: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        let finish: (NSApplication.ModalResponse) -> Void = { result in
            guard result == .OK, let dest = panel.url else { return }
            URLSession.shared.downloadTask(with: url) { tmp, response, error in
                // the temporary file is deleted when this handler returns, so move it here, not later
                var failure: String?
                if let error = error {
                    failure = error.localizedDescription
                } else if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 {
                    failure = "HarFiddle answered with HTTP \(status)."
                } else if let tmp = tmp {
                    do {
                        try? FileManager.default.removeItem(at: dest)
                        try FileManager.default.moveItem(at: tmp, to: dest)
                        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dest.path)
                    } catch {
                        failure = error.localizedDescription
                    }
                }
                DispatchQueue.main.async {
                    if let failure = failure {
                        let alert = NSAlert()
                        alert.alertStyle = .warning
                        alert.messageText = "Could not save \(dest.lastPathComponent)"
                        alert.informativeText = failure
                        alert.beginSheetModal(for: self.window, completionHandler: nil)
                    }
                }
            }.resume()
        }
        // a sheet is already open (e.g. two quick clicks on Save): use a separate dialog instead
        if window.attachedSheet != nil { finish(panel.runModal()) } else { panel.beginSheetModal(for: window, completionHandler: finish) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled || (error as NSError).code == 102 { return } // 102: turned into a download
        // the page failed to load (engine restarting?): retry the load; spawnEngine won't duplicate a running engine
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.startEngine() }
    }

    // MARK: messages from the page (native Open/Save dialogs, the open file shown in the title bar)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // only HarFiddle's own page may ask (never a previewed response inside a frame)
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, ["127.0.0.1", "localhost"].contains(origin.host), origin.port == uiPort,
              let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return replyHandler(nil, "not allowed")
        }
        let harTypes = [UTType(filenameExtension: "har"), UTType.json].compactMap { $0 }
        switch cmd {
        case "pickOpen":
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = true
            panel.canChooseDirectories = false
            panel.allowedContentTypes = harTypes
            panel.message = "Open HAR files"
            panel.beginSheetModal(for: window) { result in
                replyHandler(result == .OK ? panel.urls.map { $0.path } : [], nil)
            }
        case "pickSave":
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (body["name"] as? String) ?? "sessions.har"
            panel.allowedContentTypes = harTypes
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { result in
                replyHandler(result == .OK ? panel.url?.path : nil, nil)
            }
        case "doc":
            // the macOS document look: file name and icon in the title bar, a dot in the close button when edited
            let name = body["name"] as? String
            let path = body["path"] as? String
            let dirty = (body["dirty"] as? Bool) ?? false
            window.title = name.map { dirty ? "\($0) *" : $0 } ?? "HarFiddle"
            window.subtitle = name == nil ? "" : "HarFiddle"
            window.representedURL = path.map { URL(fileURLWithPath: $0) }
            window.isDocumentEdited = dirty
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown command")
        }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open() from HarFiddle's page (e.g. Header Definitions); previews can't run scripts
        if let url = action.request.url, action.sourceFrame.isMainFrame { openExternally(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About HarFiddle", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Show Data Folder", action: #selector(openDataFolder(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide HarFiddle", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit HarFiddle", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(withTitle: "HarFiddle", action: nil, keyEquivalent: "").submenu = appMenu

        // Standard Edit menu: needed for copy/paste/select-all inside the web view's text fields.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadUI(_:)), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]
        main.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
