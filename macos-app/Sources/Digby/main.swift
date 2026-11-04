import Cocoa
import WebKit

// The app opens here. Hosts in `keepInApp` load INSIDE the window; anything else
// the user clicks opens in their default browser.
private let homeURL = URL(string: "https://digby.example.com/")!  // the chat lives at the root (2026-10-14; /crossmodel 308s here)
private let updateFeedURL = URL(string: "https://digby.example.com/desktop-latest.json")!
private let downloadExtensions: Set<String> = ["pkg", "dmg", "zip", "exe", "msi"]

private func keepInApp(_ host: String) -> Bool {
    return host == "digby.example.com"
        || host.hasSuffix(".digby.example.com")
        || host.contains("google.com")            // sign-in / Workspace OAuth
        || host.contains("github.com")             // sign-in OAuth
        || host.contains("githubusercontent.com")
        || host.contains("apple.com")
}

private func appVersion() -> String {
    return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    // Destination we picked for the in-flight download (one .pkg/.dmg at a time).
    private var pendingDownloadDest: URL?
    // Voice conversation mode (push-to-talk STT → web chat → spoken reply).
    private var voice: VoiceController!
    // Disabled menu item at the bottom of the Voice menu showing live status.
    private let voiceStatusItem = NSMenuItem()
    // ⌃⇧Space alias monitor (ticket 8b13ec2b) — see applicationDidFinishLaunching.
    private var ctrlShiftSpaceMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // If we're running from the DMG or ~/Downloads, offer to move into /Applications
        // first (and relaunch from there). Stops the classic "ran it from the disk image,
        // never installed it, then it broke" trap. Returns true if it's relocating+quitting.
        if relocateToApplicationsIfNeeded() { return }

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // persistent cookies/localStorage → stays logged in
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Voice mode (Q3 slice): the reply watcher clicks the web transcript's
        // own "Read aloud" button — that programmatic click must be allowed to
        // start TTS AUDIO without a fresh user gesture. Scoped to .video (only
        // video still requires a gesture) rather than [] (review L4).
        config.mediaTypesRequiringUserActionForPlayback = .video

        // Let the web app know it's running inside the desktop shell — so it can hide
        // the "Download for Mac" button and offer one-click in-app iMessage setup
        // (canSetupIMessage) instead of the separate .pkg download.
        let flag = WKUserScript(
            source: "window.__digbyDesktop = { version: \"\(appVersion())\", platform: \"mac\", canSetupIMessage: true, canDictate: true };",
            injectionTime: .atDocumentStart, forMainFrameOnly: false)
        config.userContentController.addUserScript(flag)
        // JS → native bridge: window.webkit.messageHandlers.digby.postMessage({...})
        config.userContentController.add(self, name: "digby")

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 860), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // Safari-like UA — improves compatibility with sites that sniff embedded web views.
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

        window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Digby"
        window.setFrameAutosaveName("DigbyMainWindow")   // remembers size/position
        window.contentView = webView
        window.minSize = NSSize(width: 720, height: 560)
        window.delegate = self            // so the red ✕ hides instead of quitting
        window.center()
        window.makeKeyAndOrderFront(nil)

        voice = VoiceController(webView: webView)
        voice.onStatusChange = { [weak self] s in
            self?.voiceStatusItem.title = "Status: \(s)"
            // Surface active voice states in the window title; idle returns to plain "Digby".
            let busy = s.hasPrefix("●") || s.hasPrefix("Waiting") || s.hasPrefix("Sending")
                || s.hasPrefix("Speaking") || s.hasPrefix("Transcribing")
            self?.window.title = busy ? "Digby — \(s)" : "Digby"
        }

        buildMenu()
        installCtrlShiftSpaceAlias()
        webView.load(URLRequest(url: homeURL))
        NSApp.activate(ignoringOtherApps: true)
        checkForUpdate()
    }

    // Keep running when the window is closed (like Mail/Messages) — the iMessage
    // agent is a separate LaunchAgent and is unaffected either way, but users expect
    // the red ✕ to hide the app, not quit it. Quit via ⌘Q / the menu.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // Red ✕ → hide the window (keep it + the web session alive), don't destroy it.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // Clicking the Dock icon (or reopening) with no visible window → bring it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        return true
    }

    // ── First-launch: move into /Applications ──────────────────────────────────
    // Copies Digby.app to /Applications, relaunches from there, ejects the DMG if we
    // came from one, and quits this copy. Returns true when it's taking over launch.
    private func relocateToApplicationsIfNeeded() -> Bool {
        let fm = FileManager.default
        let bundlePath = Bundle.main.bundlePath
        if bundlePath.hasPrefix("/Applications/") { return false }          // already installed
        let fromDMG = bundlePath.hasPrefix("/Volumes/")
        let fromDownloads = bundlePath.contains("/Downloads/")
        guard fromDMG || fromDownloads else { return false }                // dev build / elsewhere — leave it

        let alert = NSAlert()
        alert.messageText = "Move Digby to Applications?"
        alert.informativeText = "Digby works best from your Applications folder. Move it there now and launch it from there? (Recommended)"
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Not Now")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }

        let dest = "/Applications/Digby.app"
        do {
            if fm.fileExists(atPath: dest) { try fm.removeItem(atPath: dest) } // replace older copy
            try fm.copyItem(atPath: bundlePath, toPath: dest)
        } catch {
            let e = NSAlert()
            e.messageText = "Couldn't move Digby automatically"
            e.informativeText = "Please drag Digby into your Applications folder manually.\n\n(\(error.localizedDescription))"
            e.runModal()
            return false   // keep running from here so the user isn't left with nothing
        }

        // Relaunch the installed copy once this process exits; eject the DMG too.
        var sh = "sleep 1; open \"\(dest)\""
        if fromDMG {
            let comps = bundlePath.split(separator: "/")            // ["Volumes","<vol>","Digby.app",…]
            if comps.count >= 2 { sh += "; hdiutil detach \"/Volumes/\(comps[1])\" -force" }
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", sh]
        try? task.run()

        NSApp.terminate(nil)
        return true
    }

    @objc private func reloadPage() { webView.reload() }
    @objc private func pushToTalkToggled() { voice.togglePushToTalk() }
    @objc private func speakRepliesToggled(_ sender: NSMenuItem) {
        voice.speakReplies = !voice.speakReplies
        sender.state = voice.speakReplies ? .on : .off
    }
    @objc private func goBack() { if webView.canGoBack { webView.goBack() } }
    @objc private func goForward() { if webView.canGoForward { webView.goForward() } }
    @objc private func goHome() { webView.load(URLRequest(url: homeURL)) }

    // Ticket ce014662: when the web view is showing an OFF-Digby host (an
    // allowlisted OAuth host the user navigated into — github.com above all,
    // ubiquitous in coding sessions), the plain "Digby" title lied about where
    // the user was and gave no hint a way back existed. Reflect the real host
    // in the window title and flip the standard "View → Home ⇧⌘H" item's
    // key-equivalent-modifier optics by titling it explicitly. Voice status
    // keeps its suffix on the Digby host only — off-host the host wins.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let host = webView.url?.host, !host.isEmpty else { window.title = "Digby"; return }
        let isDigby = host == "digby.example.com" || host.hasSuffix(".digby.example.com")
        window.title = isDigby ? "Digby" : "Digby — \(host)"
    }

    // Downloads (.pkg/.dmg/the iMessage helper) are handled by WKWebView's OWN native
    // downloader — NOT by handing the URL to the system browser. Handing an https
    // download URL to NSWorkspace routes it to whatever app claims digby.example.com (e.g. a
    // leftover Chrome PWA), which renders the raw binary as garbled text. Downloading
    // in-app writes the real bytes to ~/Downloads and opens the installer directly,
    // bypassing the browser and its service worker entirely.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url

        // 1. `download` attribute / server-flagged download → native in-app download
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download); return
        }
        // 2. Known downloadable file extensions (e.g. /DigbyAgent.pkg, /Digby.dmg)
        if let url = url, downloadExtensions.contains(url.pathExtension.lowercased()) {
            decisionHandler(.download); return
        }
        // 3. External links the user clicked → default browser
        if let url = url, let host = url.host,
           navigationAction.navigationType == .linkActivated, !keepInApp(host) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    // Catch downloads detected by content type (attachments without a clear extension).
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download); return
        }
        decisionHandler(.allow)
    }

    // ── Native download handling (WKDownloadDelegate) ──────────────────────────
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let fm = FileManager.default
        let downloads = (try? fm.url(for: .downloadsDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true))
            ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        let name = suggestedFilename.isEmpty ? (download.originalRequest?.url?.lastPathComponent ?? "DigbyDownload")
                                             : suggestedFilename
        var dest = downloads.appendingPathComponent(name)
        // Don't clobber an existing file — append " (1)", " (2)"…
        let ext = dest.pathExtension
        let base = dest.deletingPathExtension().lastPathComponent
        var i = 1
        while fm.fileExists(atPath: dest.path) {
            let candidate = ext.isEmpty ? "\(base) (\(i))" : "\(base) (\(i)).\(ext)"
            dest = downloads.appendingPathComponent(candidate); i += 1
        }
        pendingDownloadDest = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = pendingDownloadDest else { return }
        pendingDownloadDest = nil
        // Reveal it in Finder and open it (a .pkg launches Installer; a .dmg mounts).
        NSWorkspace.shared.activateFileViewerSelecting([url])
        NSWorkspace.shared.open(url)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloadDest = nil
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText = "Download failed"
            a.informativeText = error.localizedDescription
            a.runModal()
        }
    }

    // ── iMessage helper: in-app setup of the bundled agent (JS → native) ───────
    // IMessageCard.tsx posts here when running inside the desktop app. We write the
    // LaunchAgent for the Node agent bundled in Contents/Resources and start it —
    // no separate .pkg download, no Installer. The pairing code rides in the env so
    // the agent pairs silently; it then prompts for Full Disk Access itself.
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "digby",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "setupIMessage":
            let code = (body["pairingCode"] as? String) ?? ""
            let apiBase = (body["apiBase"] as? String) ?? "https://digby.example.com/api"
            setupIMessageAgent(pairingCode: code, apiBase: apiBase)
        case "disconnectIMessage":
            disconnectIMessageAgent()
        case "voice":   // VoiceMode.swift: reply-watcher events (replyStarted/Timeout/Failed)
                        // + the composer mic's `dictate` toggle (2026-10-20 —
                        // the web mic button hands its gesture to the native
                        // recorder; `canDictate` in the injected flag above
                        // advertises it).
            voice.handleBridgeEvent(body)
        default:
            break
        }
    }

    private func setupIMessageAgent(pairingCode: String, apiBase: String) {
        let fm = FileManager.default
        // 405927c9: never clobber a self-managed agent (label com.digby.agent,
        // installed by the one-line installer). It self-updates and outranks
        // this bundled helper — the old unconditional overwrite installed a
        // helper frozen at the app's build (0.6.3 in the served 0.1.10 DMG)
        // over a NEWER agent, and the two then polled with the same token,
        // flapping the Mac's reported version ("still says I have old 0.63").
        let home = fm.homeDirectoryForCurrentUser.path
        let selfManagedPlist = home + "/Library/LaunchAgents/com.digby.agent.plist"
        if fm.fileExists(atPath: selfManagedPlist) {
            let pairedConfig = home + "/.config/digby-agent/config.json"
            if fm.fileExists(atPath: pairedConfig) {
                showAlert(
                    "Digby's background agent is already installed",
                    "This Mac already runs the self-updating Digby agent, so there's nothing to set up — it connects on its own. If the Integrations page still shows this Mac offline, the agent may be paired to a different Digby account; run its update command from the iMessage card, or remove ~/Library/LaunchAgents/com.digby.agent.plist and try again."
                )
            } else {
                showAlert(
                    "A self-managed Digby agent is installed but not paired",
                    "This Mac already has the self-updating Digby agent, but it hasn't been paired. Use the one-line command shown on the iMessage card in your browser (it pairs the existing agent) instead of the bundled setup."
                )
            }
            return
        }
        let dir = Bundle.main.bundlePath + "/Contents/Resources/imessage-agent"
        let nodeBin = dir + "/DigbyHelper"   // the bundled Node runtime (recognizable in Full Disk Access)
        let indexJs = dir + "/dist/index.js"
        guard fm.fileExists(atPath: nodeBin), fm.fileExists(atPath: indexJs) else {
            showAlert("Couldn't find the bundled iMessage helper",
                      "Please update Digby to the latest version, then try again.")
            return
        }
        let laDir = home + "/Library/LaunchAgents"
        let logDir = home + "/Library/Logs/digby-agent"
        let label = "ai.digby.imessage-agent"
        let plistPath = "\(laDir)/\(label).plist"
        try? fm.createDirectory(atPath: laDir, withIntermediateDirectories: true)
        try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)

        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;")
             .replacingOccurrences(of: "<", with: "&lt;")
             .replacingOccurrences(of: ">", with: "&gt;")
        }
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>\(label)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(esc(nodeBin))</string>
            <string>\(esc(indexJs))</string>
            <string>run</string>
          </array>
          <key>EnvironmentVariables</key>
          <dict>
            <key>DIGBY_PAIR_CODE</key><string>\(esc(pairingCode))</string>
            <key>DIGBY_API_URL</key><string>\(esc(apiBase))</string>
          </dict>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
          <key>ThrottleInterval</key><integer>10</integer>
          <key>ProcessType</key><string>Background</string>
          <key>StandardOutPath</key><string>\(esc(logDir))/digby-agent.log</string>
          <key>StandardErrorPath</key><string>\(esc(logDir))/digby-agent.err.log</string>
        </dict>
        </plist>
        """
        do {
            try plist.write(toFile: plistPath, atomically: true, encoding: .utf8)
        } catch {
            showAlert("Couldn't write the helper configuration", error.localizedDescription)
            return
        }
        // (Re)load into the logged-in user's GUI launchd domain.
        let uid = getuid()
        _ = runLaunchctl(["bootout", "gui/\(uid)", plistPath])        // ignore: not loaded yet
        if !runLaunchctl(["bootstrap", "gui/\(uid)", plistPath]) {
            _ = runLaunchctl(["load", plistPath])                      // legacy fallback
        }
        // The agent now pairs (via DIGBY_PAIR_CODE) and, on first run, prompts for
        // Full Disk Access itself. The web UI's status poll flips to "connected".
    }

    private func disconnectIMessageAgent() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let plistPath = "\(home)/Library/LaunchAgents/ai.digby.imessage-agent.plist"
        _ = runLaunchctl(["bootout", "gui/\(getuid())", plistPath])
        try? FileManager.default.removeItem(atPath: plistPath)
    }

    @discardableResult
    private func runLaunchctl(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 }
        catch { return false }
    }

    private func showAlert(_ title: String, _ info: String) {
        DispatchQueue.main.async {
            let a = NSAlert(); a.messageText = title; a.informativeText = info; a.runModal()
        }
    }

    // window.open / target=_blank → load in the same web view (keeps OAuth popups working).
    // Ticket ce014662 (2026-09-28): this funnel used to force-load EVERY _blank
    // request in-place — including links to hosts outside `keepInApp` — and a
    // programmatic webView.load() reaches decidePolicyFor with navigationType
    // .other, which BYPASSES the external→NSWorkspace branch (it only fires on
    // .linkActivated). Chat markdown renders every link as target="_blank", so
    // clicking any external link replaced the whole app with the external page
    // and no visible way back (only hidden ⌘[ / swipe). Route non-allowlisted
    // hosts to the default browser here; allowlisted hosts keep the in-place
    // funnel so OAuth popups (google/github sign-in) still complete.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            if let url = navigationAction.request.url, let host = url.host, !keepInApp(host) {
                NSWorkspace.shared.open(url)
                return nil
            }
            webView.load(navigationAction.request)
        }
        return nil
    }

    // ── File-picker support (ticket 8a25754c) ─────────────────────────────────
    // macOS WKWebView has NO default file picker: without this WKUIDelegate
    // method, JS `.click()` on <input type="file"> is SILENTLY DROPPED — no
    // panel, no error. That was the dead paperclip in BOTH composers (normal
    // chat + coding sessions share this shell), while drag-and-drop kept
    // working (native WebKit drag machinery never asks the UI delegate).
    // Present a real NSOpenPanel honoring the input's accept list, and hand
    // the picked file URLs back to the page.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        // NOTE: the DOM `accept` filter is not exposed through WKOpenPanelParameters,
        // so the panel stays permissive (all files). The web app still gates per-file
        // after selection — a too-narrow native filter would silently hide files.
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // ── Lightweight self-update check ──────────────────────────────────────────
    // Fetches digby.example.com/desktop-latest.json; if it advertises a newer version than
    // this build, offers to download the new .dmg. (Web-app content always updates
    // live — this only covers the native shell, which changes rarely.)
    private func checkForUpdate() {
        let current = appVersion()
        URLSession.shared.dataTask(with: updateFeedURL) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let latest = json["version"] as? String,
                  let dmg = json["url"] as? String,
                  self.isNewer(latest, than: current) else { return }
            DispatchQueue.main.async { self.promptUpdate(latest: latest, url: dmg) }
        }.resume()
    }

    private func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0 ..< max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    private func promptUpdate(latest: String, url: String) {
        let alert = NSAlert()
        alert.messageText = "Update Available"
        alert.informativeText = "Digby \(latest) is available (you have \(appVersion())). Download the new version?"
        alert.addButton(withTitle: "Download")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn, let u = URL(string: url) {
            // Download the .dmg through the in-app native downloader (WKDownloadDelegate):
            // loading it triggers decidePolicyFor → .download (the .dmg extension / octet
            // MIME), so it saves to ~/Downloads and opens — the page does NOT navigate.
            // We must NOT use NSWorkspace.open here: that hands the URL to whatever app
            // claims digby.example.com (e.g. a Chrome PWA), which renders the raw bytes as garbled text.
            webView.load(URLRequest(url: u))
        }
    }

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem(); mainMenu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Digby", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let checkUpdates = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdateManual), keyEquivalent: ""); checkUpdates.target = self
        appMenu.addItem(checkUpdates)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Digby", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Digby", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem(); mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit"); editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let voiceItem = NSMenuItem(); mainMenu.addItem(voiceItem)
        let voiceMenu = NSMenu(title: "Voice"); voiceItem.submenu = voiceMenu
        let ptt = NSMenuItem(title: "Push to Talk", action: #selector(pushToTalkToggled), keyEquivalent: " ")
        ptt.keyEquivalentModifierMask = [.shift, .command]   // ⇧⌘Space — free of Spotlight (⌘Space)
        ptt.target = self
        voiceMenu.addItem(ptt)
        let speakToggle = NSMenuItem(title: "Speak Replies Automatically", action: #selector(speakRepliesToggled(_:)), keyEquivalent: "")
        speakToggle.target = self
        speakToggle.state = voice.speakReplies ? .on : .off
        voiceMenu.addItem(speakToggle)
        voiceMenu.addItem(.separator())
        voiceStatusItem.isEnabled = false
        voiceStatusItem.title = "Status: \(voice.status)"
        voiceMenu.addItem(voiceStatusItem)

        let viewItem = NSMenuItem(); mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View"); viewItem.submenu = viewMenu
        let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r"); reload.target = self
        viewMenu.addItem(reload)
        let home = NSMenuItem(title: "Home", action: #selector(goHome), keyEquivalent: "H"); home.target = self
        viewMenu.addItem(home)
        viewMenu.addItem(.separator())
        let back = NSMenuItem(title: "Back", action: #selector(goBack), keyEquivalent: "["); back.target = self
        viewMenu.addItem(back)
        let fwd = NSMenuItem(title: "Forward", action: #selector(goForward), keyEquivalent: "]"); fwd.target = self
        viewMenu.addItem(fwd)

        let winItem = NSMenuItem(); mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "Window"); winItem.submenu = winMenu
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        NSApp.mainMenu = mainMenu
    }

    /// ⌃⇧Space ALIAS for Push to Talk (ticket 8b13ec2b). A menu item carries
    /// exactly one keyEquivalent, and the PTT item is ⇧⌘Space — the owner
    /// reached for ⌃⇧Space ("control shift space") and got a no-op. A LOCAL
    /// event monitor (fires only while Digby is frontmost — never a global
    /// tap, no Accessibility permission) binds the alias to the same
    /// voice.togglePushToTalk() entry point, which is what triggers the
    /// microphone TCC request. Returned events pass through untouched.
    private func installCtrlShiftSpaceAlias() {
        ctrlShiftSpaceMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self,
                  event.window === self.window,
                  event.modifierFlags.contains(.control),
                  event.modifierFlags.contains(.shift),
                  !event.modifierFlags.contains(.command),
                  !event.modifierFlags.contains(.option),
                  event.keyCode == 49 else { return event }
            self.voice.togglePushToTalk()
            return nil  // consumed
        }
    }

    @objc private func checkForUpdateManual() {
        let current = appVersion()
        URLSession.shared.dataTask(with: updateFeedURL) { [weak self] data, _, _ in
            guard let self = self else { return }
            let json = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any]
            DispatchQueue.main.async {
                if let json = json, let latest = json["version"] as? String, let dmg = json["url"] as? String,
                   self.isNewer(latest, than: current) {
                    self.promptUpdate(latest: latest, url: dmg)
                } else {
                    let a = NSAlert(); a.messageText = "You're up to date"
                    a.informativeText = "Digby \(current) is the latest version."
                    a.runModal()
                }
            }
        }.resume()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
