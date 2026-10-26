import AppKit
import AVFoundation
import Darwin
import Foundation
import Speech
import WebKit
import ServiceManagement
import UserNotifications
import UniformTypeIdentifiers

final class MeloAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, AVAudioPlayerDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var serverProcess: Process?
  // The bundled desktop pet (DesktopPet.swift): started after the server is
  // ready when the "桌面宠物" preference is on, stopped together with the server.
  private lazy var desktopPet: DesktopPetManager = {
    let manager = DesktopPetManager(projectDir: projectDir)
    manager.onUnexpectedExit = { [weak self] in self?.desktopPetExited() }
    return manager
  }()
  private lazy var projectDir: String = {
    if let envDir = ProcessInfo.processInfo.environment["MELO_PROJECT_DIR"], !envDir.isEmpty {
      return envDir
    }

    // Source-backed installs record their actual project location at build time.
    // Environment overrides still take precedence for isolated verification.
    if let configuredDir = Bundle.main.object(forInfoDictionaryKey: "MeloProjectDirectory") as? String,
       FileManager.default.fileExists(atPath: (configuredDir as NSString).appendingPathComponent("src/server.js")),
       FileManager.default.fileExists(atPath: (configuredDir as NSString).appendingPathComponent("desktop-ui/index.html")) {
      return configuredDir
    }

    let bundleParentDir = Bundle.main.bundleURL.deletingLastPathComponent().path
    let bundleGrandparentDir = (bundleParentDir as NSString).deletingLastPathComponent
    let candidateProjectDirs = [
      bundleParentDir,
      (bundleParentDir as NSString).appendingPathComponent("Melo Desktop Project"),
      (bundleGrandparentDir as NSString).appendingPathComponent("Melo Desktop Project"),
    ]

    for candidate in candidateProjectDirs {
      if FileManager.default.fileExists(atPath: (candidate as NSString).appendingPathComponent("desktop-ui/index.html")) {
        return candidate
      }
    }

    return bundleParentDir
  }()
  private let host = "127.0.0.1"
  private let configuredPort = Int(
    ProcessInfo.processInfo.environment["MELO_DESKTOP_PORT"] ?? ""
  ) ?? 43127
  private lazy var port = configuredPort
  private var hasLoadedServer = false
  private var launchingServer = false
  private var stoppedStaleServerPID: pid_t?
  private var terminationSignalSources: [DispatchSourceSignal] = []
  private var launchAttempt = UUID()
  private var launchRequest: URLSessionDataTask?
  private var resolvedNodePath: String?
  private var serverOutput = ""
  private let debugQueue = DispatchQueue(label: "com.melo.desktop.diagnostics", qos: .utility)
  private lazy var voiceInput: VoiceInput = {
    let input = VoiceInput(engine: SystemSpeechInput())
    input.onUpdate = { [weak self] state in self?.emitVoiceEvent(state) }
    return input
  }()

  // Multilingual recognizer pool for batch file transcription (Telegram voice notes etc.).
  // Tries all available recognizers in parallel and picks the highest-confidence result.
  // Locales: system language + zh-Hans/zh-Hant/en + ko/ja/fr/it/es.
  private lazy var multilingualRecognizers: [SFSpeechRecognizer] = {
    var seen = Set<String>()
    var pool: [SFSpeechRecognizer] = []
    let candidates: [String] = (Locale.preferredLanguages.prefix(2).map { $0 }) + [
      "zh-Hans", "zh-Hant", "en-US",
      "ko-KR", "ja-JP", "fr-FR", "it-IT", "es-ES",
    ]
    for id in candidates {
      // Deduplicate by language subtag (e.g. "zh-Hans-CN" → "zh-Hans")
      let key = id.components(separatedBy: "-").prefix(2).joined(separator: "-")
      guard !seen.contains(key) else { continue }
      if let r = SFSpeechRecognizer(locale: Locale(identifier: id)) {
        seen.insert(key)
        pool.append(r)
      }
    }
    return pool
  }()
  // Native TTS audio player (bypasses WKWebView autoplay restrictions)
  private var ttsAudioPlayer: AVAudioPlayer?
  // Native speech synthesizer for high-quality system TTS
  private let speechSynthesizer = AVSpeechSynthesizer()
  // `say` command process for system TTS (avoids AVAudioEngine session conflicts)
  private var sayProcess: Process?
  // Native transcription server (127.0.0.1:transcriptionPort)
  // Lets the Node.js backend request on-device SFSpeechRecognizer transcription
  // for Telegram voice notes and other remote audio without needing a Whisper API key.
  private var transcriptionServerFd: Int32 = -1
  private var nativeTranscriptionStarted = false
  private var transcriptionPort: Int { port + 1 }

  private var serverURL: URL {
    URL(string: "http://\(host):\(port)")!
  }

  private var bundlePath: String {
    Bundle.main.bundlePath
  }

  private var debugPath: String {
    projectDir + "/.tmp/desktop-app-debug.txt"
  }

  private var autoCloseSentinelPath: String {
    projectDir + "/.tmp/desktop-app-auto-close"
  }

  private var runtimeMeloHomePath: String {
    if let explicitHome = ProcessInfo.processInfo.environment["MELO_HOME"],
       !explicitHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return URL(fileURLWithPath: explicitHome.trimmingCharacters(in: .whitespacesAndNewlines)).standardizedFileURL.path
    }
    return projectDir + "/.tmp/melo-home-user"
  }

  private var legacySharedMeloHomePath: String {
    projectDir + "/.tmp/melo-home"
  }

  private var serverScriptPath: String {
    projectDir + "/src/server.js"
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Installed before the server child exists, so no signal can orphan it.
    terminationSignalSources = ProcessShutdown.onTerminationSignals { [weak self] signal in
      self?.terminateAfterSignal(signal)
    }
    installMainMenu()
    buildWindow()
    window.isReleasedWhenClosed = false
    writeDebug("status=launching")
    loadPlaceholder()
    startServerIfNeeded()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    UserDefaults.standard.string(forKey: "melo.closeBehavior") != "background"
  }

  private var checkingUnsavedSettings = false
  private var terminatingServer = false

  private func finishTermination(_ sender: NSApplication) {
    guard !terminatingServer else { return }
    terminatingServer = true
    launchRequest?.cancel()
    // The pet first (its /quit returns at once), then the server; both completions arrive on the main run loop.
    desktopPet.stop { [self] in
      ProcessShutdown.stop(serverProcess) {
        sender.reply(toApplicationShouldTerminate: true)
      }
    }
  }

  // SIGTERM/SIGINT/SIGHUP skip applicationShouldTerminate, including its
  // unsaved-settings prompt: stop the server child within the same bound as a
  // normal quit, release native children, then end as the signal asked.
  private func terminateAfterSignal(_ signal: Int32) {
    // A quit already in progress owns the child's shutdown and exits after it.
    guard !terminatingServer else { return }
    terminatingServer = true
    launchRequest?.cancel()
    desktopPet.stop { [self] in
      ProcessShutdown.stop(serverProcess) { [weak self] in
        self?.releaseNativeResources()
        ProcessShutdown.exit(after: signal)
      }
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // Background mode keeps this window and its drafts alive.
    if UserDefaults.standard.string(forKey: "melo.closeBehavior") == "background" { return true }
    NSApp.terminate(nil)
    return false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if checkingUnsavedSettings || terminatingServer { return .terminateLater }
    guard let webView = webView else {
      DispatchQueue.main.async { self.finishTermination(sender) }
      return .terminateLater
    }
    checkingUnsavedSettings = true
    webView.evaluateJavaScript("Boolean(window.MeloHasUnsavedSettings?.())") { [weak self] value, _ in
      guard let self = self else { sender.reply(toApplicationShouldTerminate: true); return }
      if value as? Bool == true {
        let alert = NSAlert()
        alert.messageText = "还有未保存的设置"
        alert.informativeText = "退出后，未保存的修改会丢失。如果正在保存，请先等待保存结果。"
        alert.addButton(withTitle: "继续编辑")
        alert.addButton(withTitle: "放弃未保存修改并退出")
        let discard = alert.runModal() == .alertSecondButtonReturn
        self.checkingUnsavedSettings = false
        if discard { self.finishTermination(sender) }
        else { sender.reply(toApplicationShouldTerminate: false) }
      } else {
        self.checkingUnsavedSettings = false
        self.finishTermination(sender)
      }
    }
    return .terminateLater
  }

  func applicationWillTerminate(_ notification: Notification) {
    releaseNativeResources()
  }

  private func releaseNativeResources() {
    voiceInput.cancel()
    launchRequest?.cancel()
    // Without these calls a `say` child or AVAudioPlayer can keep playing for
    // several seconds after the app window has closed, until the OS reaps the
    // detached children.
    ttsAudioPlayer?.stop()
    ttsAudioPlayer = nil
    speechSynthesizer.stopSpeaking(at: .immediate)
    sayProcess?.terminate()
    sayProcess = nil
    if serverProcess?.isRunning == true { serverProcess?.terminate() }
    desktopPet.terminateChildIfRunning()
    if transcriptionServerFd >= 0 {
      close(transcriptionServerFd)
      transcriptionServerFd = -1
    }
  }

  private func installMainMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    appMenuItem.submenu = appMenu
    appMenu.addItem(
      withTitle: "About Melo",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    appMenu.addItem(withTitle: "设置…", action: #selector(openMeloSettings), keyEquivalent: ",")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit Melo",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )

    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "Edit")
    editMenuItem.submenu = editMenu

    editMenu.addItem(
      withTitle: "Undo",
      action: Selector(("undo:")),
      keyEquivalent: "z"
    )
    editMenu.addItem(
      withTitle: "Redo",
      action: Selector(("redo:")),
      keyEquivalent: "Z"
    ).keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(.separator())
    editMenu.addItem(
      withTitle: "Cut",
      action: #selector(NSText.cut(_:)),
      keyEquivalent: "x"
    )
    editMenu.addItem(
      withTitle: "Copy",
      action: #selector(NSText.copy(_:)),
      keyEquivalent: "c"
    )
    editMenu.addItem(
      withTitle: "Paste",
      action: #selector(NSText.paste(_:)),
      keyEquivalent: "v"
    )
    editMenu.addItem(
      withTitle: "Select All",
      action: #selector(NSText.selectAll(_:)),
      keyEquivalent: "a"
    )

    NSApp.mainMenu = mainMenu
  }

  private func buildWindow() {
    let rect = NSRect(x: 0, y: 0, width: 1320, height: 860)
    window = NSWindow(
      contentRect: rect,
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.delegate = self
    window.center()
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = false
    window.isMovableByWindowBackground = false
    window.backgroundColor = NSColor(red: 8/255, green: 9/255, blue: 11/255, alpha: 1.0)
    window.setContentSize(NSSize(width: 1320, height: 860))
    window.minSize = NSSize(width: 1080, height: 720)
    window.title = "Melo"
    window.toolbarStyle = .unifiedCompact

    let userContentController = WKUserContentController()
    userContentController.add(self, name: "meloVoice")
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = userContentController
    // Verification must not share the user's WebKit drafts, cookies or preferences.
    configuration.websiteDataStore = ProcessInfo.processInfo.environment["MELO_TEST_MODE"] == "1"
      ? .nonPersistent() : .default()
    configuration.mediaTypesRequiringUserActionForPlayback = []  // allow TTS autoplay
    webView = WKWebView(frame: rect, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground")

    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
  }

  private func loadPlaceholder() {
    loadLaunchPage(phase: "service")
  }

  private func loadLaunchPage(phase: String, detail: String = "") {
    let payload = ["phase": phase, "detail": detail]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8),
          let resource = Bundle.main.url(forResource: "Launch", withExtension: "html"),
          let template = try? String(contentsOf: resource, encoding: .utf8) else {
      webView.loadHTMLString("<html style='background:#08090b;color:#ede8df'><body><h1>melo</h1><p>启动界面资源缺失，请重新安装 Melo。</p></body></html>", baseURL: nil)
      return
    }
    // JSON is inert data. Escape '<' so diagnostic output cannot close the script tag.
    let safeJSON = json.replacingOccurrences(of: "<", with: "\\u003c")
    webView.loadHTMLString(template.replacingOccurrences(of: "__MELO_LAUNCH_STATE__", with: safeJSON), baseURL: nil)
  }

  private func startServerIfNeeded() {
    guard !launchingServer, !terminatingServer else { return }
    launchingServer = true
    // Capture before leaving the main thread; the wait never blocks the launch page.
    let home = runtimeMeloHomePath
    let serverScript = serverScriptPath
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let outcome = StaleServer.reclaim(home: home, serverScript: serverScript)
      DispatchQueue.main.async { self?.launchServer(after: outcome) }
    }
  }

  private func launchServer(after outcome: StaleServer.Outcome) {
    launchingServer = false
    guard !terminatingServer else { return }
    stoppedStaleServerPID = nil
    switch outcome {
    case .busy(let holderPID):
      // The new server could not take the home lock either; never move it to
      // another port next to a server it would collide with.
      writeDebug("status=server-home-busy\nholderPid=\(holderPID)\nmeloHome=\(runtimeMeloHomePath)")
      loadErrorPage(message: "另一个 Melo 服务（进程 \(holderPID)）正在使用这个工作空间。\n请先退出它，再点击重试。")
      return
    case .stopped(let stalePID):
      stoppedStaleServerPID = stalePID
    case .clear:
      break
    }
    spawnServer()
    if !nativeTranscriptionStarted, serverProcess?.isRunning == true {
      nativeTranscriptionStarted = true
      startNativeTranscriptionServer()
    }
    pollServerAndLoad()
  }

  private func spawnServer() {
    prepareLaunchPort()
    prepareRuntimeMeloHome()

    guard let nodeExecutable = resolveNodeExecutable() else {
      writeDebug(
        """
        status=node-not-found
        bundlePath=\(bundlePath)
        projectDir=\(projectDir)
        """
      )
      loadErrorPage(
        message: """
        Melo Desktop could not find a usable Node.js binary.
        Checked common system and NVM locations.
        """
      )
      return
    }

    resolvedNodePath = nodeExecutable

    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodeExecutable)
    process.arguments = [
      projectDir + "/src/server.js",
      "--host",
      host,
      "--port",
      String(port),
    ]
    process.currentDirectoryURL = URL(fileURLWithPath: projectDir)
    process.environment = ProcessInfo.processInfo.environment.merging([
      "HOME": NSHomeDirectory(),
      "MELO_HOME": runtimeMeloHomePath,
      "MELO_EMBED_MODEL_DIR": Bundle.main.resourceURL!.appendingPathComponent("models/multilingual-e5-small").path,
      // The server may bind a rolled-forward port if the configured 43127 is
      // taken (see prepareLaunchPort). Anything in Node that needs to talk
      // back to native services on port+N (transcription server at port+1,
      // signed-URL minting in src/web/urlSigning.js, etc.) reads this env
      // var. Without it those reads fall back to 43127 and miss the actual
      // listener on 43128/43129/...
      "MELO_DESKTOP_PORT": String(port),
      // See ownerPipe below; src/runtime/desktopOwner.js reads this flag.
      "MELO_DESKTOP_OWNER_PIPE": "1",
      "PATH": [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].joined(separator: ":"),
    ], uniquingKeysWith: { _, launchValue in launchValue })

    // A SIGKILL or crash skips every handler here; the kernel then closes this
    // pipe's write end and the server stops on EOF. Nothing is written to it.
    // Close-on-exec keeps the write end out of the server and every other child.
    let ownerPipe = Pipe()
    _ = fcntl(ownerPipe.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC)
    process.standardInput = ownerPipe
    let outputPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = outputPipe
    bindServerOutput(outputPipe)
    process.terminationHandler = { [weak self] terminated in
      guard let self = self, !self.terminatingServer else { return }
      self.writeDebug(
        """
        status=server-exited
        bundlePath=\(self.bundlePath)
        projectDir=\(self.projectDir)
        nodePath=\(self.resolvedNodePath ?? "(unknown)")
        exitCode=\(terminated.terminationStatus)
        reason=\(terminated.terminationReason.rawValue)
        output=\(self.trimmedServerOutput())
        """
      )
    }

    do {
      try process.run()
      serverProcess = process
      writeDebug(
        """
        status=server-started
        bundlePath=\(bundlePath)
        serverURL=\(serverURL.absoluteString)
        projectDir=\(projectDir)
        nodePath=\(nodeExecutable)
        serverPid=\(process.processIdentifier)
        staleServerStopped=\(stoppedStaleServerPID.map(String.init) ?? "none")
        """
      )
    } catch {
      writeDebug("status=server-launch-failed\nerror=\(error.localizedDescription)")
      loadErrorPage(message: "Unable to launch the local Melo server.\n\(error.localizedDescription)")
    }
  }

  private func prepareRuntimeMeloHome() {
    let fileManager = FileManager.default
    let runtimeURL = URL(fileURLWithPath: runtimeMeloHomePath, isDirectory: true)
    let legacyURL = URL(fileURLWithPath: legacySharedMeloHomePath, isDirectory: true)

    do {
      try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true)
      if let explicitHome = ProcessInfo.processInfo.environment["MELO_HOME"],
         !explicitHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
      let runtimeConfig = runtimeURL.appendingPathComponent("config.json")
      let legacyConfig = legacyURL.appendingPathComponent("config.json")
      if !fileManager.fileExists(atPath: runtimeConfig.path),
         fileManager.fileExists(atPath: legacyConfig.path) {
        try fileManager.copyItem(at: legacyConfig, to: runtimeConfig)
      }
    } catch {
      writeDebug(
        """
        status=runtime-home-prepare-failed
        runtimeMeloHome=\(runtimeMeloHomePath)
        legacyMeloHome=\(legacySharedMeloHomePath)
        error=\(error.localizedDescription)
        """
      )
    }
  }

  private func pollServerAndLoad() {
    guard serverProcess?.isRunning == true else { return }
    launchRequest?.cancel()
    let attempt = UUID()
    launchAttempt = attempt
    let deadline = Date().addingTimeInterval(20)
    // Capture the intended runtime once; another process on this port is not ready.
    let expectedHome = runtimeMeloHomePath
    let expectedPID = Int(serverProcess?.processIdentifier ?? -1)
    let origin = serverURL
    pollLaunchHealth(attempt: attempt, deadline: deadline, origin: origin, expectedHome: expectedHome, expectedPID: expectedPID)
  }

  private func pollLaunchHealth(attempt: UUID, deadline: Date, origin: URL, expectedHome: String, expectedPID: Int) {
    guard launchAttempt == attempt, !hasLoadedServer else { return }
    guard serverProcess?.isRunning == true, Date() < deadline else {
      loadErrorPage(message: "本地工作空间未能启动。\n地址：\(origin.absoluteString)\n\(trimmedServerOutput())")
      return
    }
    var request = URLRequest(url: origin.appendingPathComponent("api/health"))
    request.timeoutInterval = 1
    request.cachePolicy = .reloadIgnoringLocalCacheData
    // Never block the main thread: the loading UI must keep animating and responding.
    launchRequest = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let runtime = payload?["runtime"] as? [String: Any]
      let healthy = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
        && payload?["ok"] as? Bool == true
        && runtime?["home"] as? String == expectedHome
        && runtime?["pid"] as? Int == expectedPID
      DispatchQueue.main.async {
        guard let self, self.launchAttempt == attempt else { return }
        if healthy {
          self.prepareWorkspacePage(attempt: attempt, origin: origin)
        } else {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.pollLaunchHealth(attempt: attempt, deadline: deadline, origin: origin, expectedHome: expectedHome, expectedPID: expectedPID)
          }
        }
      }
    }
    launchRequest?.resume()
  }

  private func prepareWorkspacePage(attempt: UUID, origin: URL) {
    var request = URLRequest(url: origin.appendingPathComponent("api/launch/reset"))
    request.timeoutInterval = 5
    launchRequest = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
      DispatchQueue.main.async {
        guard let self, self.launchAttempt == attempt else { return }
        guard error == nil, let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
          self.loadErrorPage(message: "工作空间已连接，但界面初始化失败。请重试。\n\(error?.localizedDescription ?? "服务未返回成功状态")")
          return
        }
        self.hasLoadedServer = true
        self.writeDebug("status=server-ready\nbundlePath=\(self.bundlePath)\nserverURL=\(origin.absoluteString)\nprojectDir=\(self.projectDir)")
        self.webView.load(URLRequest(url: origin))
        self.startDesktopPetIfEnabled(origin: origin)
      }
    }
    launchRequest?.resume()
  }

  private func prepareLaunchPort() {
    // A retry keeps the port paired with the native service already bound at port + 1.
    if nativeTranscriptionStarted && isPortAvailable(port) { return }
    // Only an unrelated listener moves Melo off its port (a stale Melo server
    // was stopped before this), and the native service needs port + 1 as well.
    let candidatePorts = [configuredPort] + Array((configuredPort + 1)...(configuredPort + 6))
    for candidate in candidatePorts {
      if isPortAvailable(candidate) && isPortAvailable(candidate + 1) {
        port = candidate
        return
      }
    }

    port = configuredPort
  }

  private func isPortAvailable(_ candidate: Int) -> Bool {
    let socketFd = socket(AF_INET, SOCK_STREAM, 0)
    if socketFd == -1 {
      return false
    }
    defer {
      close(socketFd)
    }

    var reuseValue: Int32 = 1
    setsockopt(
      socketFd,
      SOL_SOCKET,
      SO_REUSEADDR,
      &reuseValue,
      socklen_t(MemoryLayout<Int32>.size)
    )

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(candidate).bigEndian)
    address.sin_addr = in_addr(s_addr: inet_addr(host))

    let bindResult = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { reboundPointer in
        Darwin.bind(socketFd, reboundPointer, socklen_t(MemoryLayout<sockaddr_in>.stride))
      }
    }

    return bindResult == 0
  }

  private func loadErrorPage(message: String) {
    launchRequest?.cancel()
    launchAttempt = UUID()
    hasLoadedServer = false
    loadLaunchPage(phase: "error", detail: message)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "meloVoice" else { return }
    guard
      let payload = message.body as? [String: Any],
      let action = payload["action"] as? String
    else {
      return
    }

    let localActions = ["getLocalSettings", "setLocalSettings", "openLoginItems", "openMicrophoneSettings", "savePortableArchive", "saveImage", "notifyReplyComplete"]
    if localActions.contains(action) {
      guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
            url.scheme == "http", url.host == host, url.port == port else { return }
      handleLocalSettings(payload, action: action); return
    }
    switch action {
    case "retryLaunch":
      guard !hasLoadedServer else { return }
      loadPlaceholder()
      // A fresh launch polls once its stale-server check has finished.
      if serverProcess?.isRunning == true { pollServerAndLoad() } else { startServerIfNeeded() }
    case "toggle":
      if voiceInput.state.active { voiceInput.stop() }
      else {
        voiceInput.start(id: payload["sessionID"] as? String ?? UUID().uuidString,
                         locale: payload["language"] as? String ?? Locale.current.identifier)
      }
    case "stop":
      if payload["sessionID"] as? String == voiceInput.state.sessionID { voiceInput.stop() }
    case "cancelVoice":
      if payload["sessionID"] as? String == voiceInput.state.sessionID { voiceInput.cancel() }
    case "playAudio":
      // Cross-engine teardown: stop everything else first so MiniMax / API
      // audio never overlaps a still-running `say` or speechSynthesizer
      // utterance from another message in the chat.
      if let base64 = payload["data"] as? String,
         let audioData = Data(base64Encoded: base64) {
        DispatchQueue.main.async {
          self.ttsAudioPlayer?.stop()
          self.ttsAudioPlayer = nil
          self.speechSynthesizer.stopSpeaking(at: .immediate)
        }
        DispatchQueue.global(qos: .userInitiated).async {
          self.sayProcess?.terminate()
          self.sayProcess = nil
        }
        DispatchQueue.main.async {
          do {
            let player = try AVAudioPlayer(data: audioData)
            player.delegate = self
            self.ttsAudioPlayer = player
            player.play()
          } catch {
            // playback failed — JS will fall back to browser TTS
            self.emitTtsEvent(action: "audioFailed")
          }
        }
      }
    case "stopAudio":
      DispatchQueue.main.async {
        self.ttsAudioPlayer?.stop()
        self.ttsAudioPlayer = nil
        self.speechSynthesizer.stopSpeaking(at: .immediate)
      }
      DispatchQueue.global(qos: .userInitiated).async {
        self.sayProcess?.terminate()
        self.sayProcess = nil
      }
    case "speakText":
      // Use macOS `say` command — avoids AVAudioEngine session conflicts, supports all system voices.
      // Cross-engine teardown: stop AVAudioPlayer / speechSynthesizer first
      // so a queued `say` doesn't overlap an already-playing MiniMax buffer.
      if let text = payload["text"] as? String,
         !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        DispatchQueue.main.async {
          self.ttsAudioPlayer?.stop()
          self.ttsAudioPlayer = nil
          self.speechSynthesizer.stopSpeaking(at: .immediate)
        }
        DispatchQueue.global(qos: .userInitiated).async {
          self.sayProcess?.terminate()
          self.sayProcess = nil
          let task = Process()
          task.executableURL = URL(fileURLWithPath: "/usr/bin/say")
          // Pick voice by system language
          let lang = Locale.preferredLanguages.first?.lowercased() ?? "en"
          // Bug audit U11: `--` ends option parsing, so a reply that starts
          // with `-` is spoken instead of being read as a `say` flag (the
          // Node side already passes `--`).
          if lang.hasPrefix("zh") {
            task.arguments = ["-v", "Tingting", "--", text]
          } else if lang.hasPrefix("ko") {
            task.arguments = ["-v", "Yuna", "--", text]
          } else if lang.hasPrefix("ja") {
            task.arguments = ["-v", "Kyoko", "--", text]
          } else {
            task.arguments = ["--", text]
          }
          self.sayProcess = task
          try? task.run()
          task.waitUntilExit()
          DispatchQueue.main.async {
            self.sayProcess = nil
            self.emitTtsEvent(action: "sayEnded")
          }
        }
      }
    case "openExternalUrl":
      if
        let rawUrl = payload["url"] as? String,
        let url = URL(string: rawUrl),
        isExternalWebUrl(url)
      {
        openExternalLink(url)
      }
    default:
      break
    }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    guard frame.isMainFrame, let url = frame.request.url,
          url.scheme == "http", url.host == host, url.port == port else { completionHandler(nil); return }
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
  }

  @objc private func openMeloSettings() {
    window.makeKeyAndOrderFront(nil)
    webView.evaluateJavaScript("window.dispatchEvent(new Event('melo-open-settings'));")
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  private func localSettingsReply(_ requestID: String, extra: [String: Any] = [:]) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      DispatchQueue.main.async {
        let status = settings.authorizationStatus
        var value: [String: Any] = [
          "requestID": requestID,
          "closeBehavior": UserDefaults.standard.string(forKey: "melo.closeBehavior") ?? "quit",
          "notifications": UserDefaults.standard.bool(forKey: "melo.notifications") && status == .authorized,
          "notificationStatus": status == .authorized ? "系统已允许" : status == .denied ? "系统未允许，可前往 macOS 通知设置更改" : "开启时申请系统授权",
          "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知",
          "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未知",
          "desktopPet": UserDefaults.standard.bool(forKey: DesktopPetManager.preferenceKey),
          "desktopPetAvailable": self.desktopPet.isAvailable,
          "desktopPetRunning": self.desktopPet.isRunning()
        ]
        if #available(macOS 13, *) {
          value["launchAtLogin"] = SMAppService.mainApp.status == .enabled
          value["loginNeedsApproval"] = SMAppService.mainApp.status == .requiresApproval
        }
        value.merge(extra) { _, new in new }
        guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        self.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('melo-local-settings',{detail:\(json)}));")
      }
    }
  }

  private func handleLocalSettings(_ payload: [String: Any], action: String) {
    let requestID = payload["requestID"] as? String ?? ""
    switch action {
    case "getLocalSettings": localSettingsReply(requestID)
    case "setLocalSettings":
      let key = payload["key"] as? String ?? ""
      if key == "closeBehavior", let value = payload["value"] as? String, ["quit", "background"].contains(value) {
        UserDefaults.standard.set(value, forKey: "melo.closeBehavior"); localSettingsReply(requestID)
      } else if key == "launchAtLogin", #available(macOS 13, *) {
        do {
          if payload["value"] as? String == "true" { try SMAppService.mainApp.register() }
          else { try SMAppService.mainApp.unregister() }
          localSettingsReply(requestID)
        } catch { localSettingsReply(requestID, extra: ["error": error.localizedDescription]) }
      } else if key == "notifications", let enabled = payload["value"] as? Bool {
        if !enabled { UserDefaults.standard.set(false, forKey: "melo.notifications"); localSettingsReply(requestID); return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { allowed, error in
          UserDefaults.standard.set(allowed, forKey: "melo.notifications")
          self.localSettingsReply(requestID, extra: allowed ? [:] : ["error": error?.localizedDescription ?? "系统未允许通知，请在 macOS 通知设置中允许 Melo。"])
        }
      } else if key == "desktopPet", let enabled = DesktopPetManager.boolValue(payload["value"]) {
        setDesktopPet(enabled, requestID: requestID)
      } else { localSettingsReply(requestID, extra: ["error": "设备设置无效。"] ) }
    case "openLoginItems":
      if #available(macOS 13, *) { SMAppService.openSystemSettingsLoginItems() }
      localSettingsReply(requestID)
    case "openMicrophoneSettings":
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
      localSettingsReply(requestID)
    case "savePortableArchive":
      guard let text = payload["text"] as? String, text.utf8.count <= 16 * 1024 * 1024 else { localSettingsReply(requestID, extra: ["error": "资料文件超过导出上限。"]); return }
      let panel = NSSavePanel()
      panel.nameFieldStringValue = payload["name"] as? String ?? "Melo-资料.json"
      panel.beginSheetModal(for: window) { response in
        guard response == .OK, let url = panel.url else { self.localSettingsReply(requestID, extra: ["cancelled": true]); return }
        do { try text.write(to: url, atomically: true, encoding: .utf8); self.localSettingsReply(requestID) }
        catch { self.localSettingsReply(requestID, extra: ["error": error.localizedDescription]) }
      }
    case "saveImage":
      let extensions = ["image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/heic": "heic"]
      guard let mimeType = payload["mimeType"] as? String, let ext = extensions[mimeType],
            let encoded = payload["data"] as? String, encoded.utf8.count <= 90 * 1024 * 1024,
            let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 64 * 1024 * 1024,
            NSImage(data: data) != nil else {
        localSettingsReply(requestID, extra: ["error": "图片无法读取或超过 64 MB，请重新打开后重试。"]); return
      }
      let panel = NSSavePanel()
      let suppliedName = (payload["name"] as? String ?? "Melo-image") as NSString
      let stem = (suppliedName.lastPathComponent as NSString).deletingPathExtension
      panel.nameFieldStringValue = (stem.isEmpty ? "Melo-image" : stem) + "." + ext
      if let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type] }
      panel.canCreateDirectories = true
      panel.beginSheetModal(for: window) { response in
        guard response == .OK, let url = panel.url else { self.localSettingsReply(requestID, extra: ["cancelled": true]); return }
        do { try data.write(to: url, options: .atomic); self.localSettingsReply(requestID) }
        catch { self.localSettingsReply(requestID, extra: ["error": "图片保存失败：" + error.localizedDescription]) }
      }
    case "notifyReplyComplete":
      guard UserDefaults.standard.bool(forKey: "melo.notifications"), !NSApp.isActive else { return }
      let content = UNMutableNotificationContent(); content.title = "Melo 回复已完成"; content.body = "打开 Melo 查看结果。"; content.sound = .default
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    default: break
    }
  }

  // MARK: desktop pet

  /// On: start now and on every later launch. Off: ask the pet to quit and stop auto-starting.
  /// The reply carries the real state (desktopPetRunning) once the action has finished.
  private func setDesktopPet(_ enabled: Bool, requestID: String) {
    guard desktopPet.isAvailable else { localSettingsReply(requestID, extra: ["error": "当前安装未包含桌面宠物。"]); return }
    UserDefaults.standard.set(enabled, forKey: DesktopPetManager.preferenceKey)
    if enabled {
      desktopPet.start(baseURL: serverURL) { [weak self] error in
        self?.localSettingsReply(requestID, extra: error.map { ["error": $0] } ?? [:])
      }
    } else {
      desktopPet.stop { [weak self] in self?.localSettingsReply(requestID) }
    }
  }

  private func startDesktopPetIfEnabled(origin: URL) {
    guard desktopPet.isAvailable, UserDefaults.standard.bool(forKey: DesktopPetManager.preferenceKey) else { return }
    desktopPet.start(baseURL: origin) { error in NSLog("Melo desktop pet: %@", error ?? "started") }
  }

  /// The pet quit on its own (its menu, a crash): keep the preference and the settings page truthful.
  private func desktopPetExited() {
    UserDefaults.standard.set(false, forKey: DesktopPetManager.preferenceKey)
    NSLog("Melo desktop pet: exited on its own; auto-start switched off")
    webView?.evaluateJavaScript("window.dispatchEvent(new Event('melo-local-settings-changed'));")
  }

  private func emitVoiceEvent(_ state: VoiceInputSnapshot) {
    let payload: [String: Any] = [
      "supported": true, "sessionID": state.sessionID,
      "recording": state.recording, "status": state.status,
      "partial": state.partial, "finalText": state.finalText,
      "error": state.error, "notice": state.notice,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    webView.evaluateJavaScript(
      "window.dispatchEvent(new CustomEvent('melo-voice', { detail: \(json) }));",
      completionHandler: nil
    )
  }

  // TTS playback events — separate channel from voice-recording events
  // because JS clears different state on each. Mirrors the existing
  // melo-voice CustomEvent pattern.
  private func emitTtsEvent(action: String) {
    let payload: [String: Any] = ["action": action]
    guard
      let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    else {
      return
    }
    DispatchQueue.main.async {
      self.webView.evaluateJavaScript(
        "window.dispatchEvent(new CustomEvent('melo-tts', { detail: \(json) }));",
        completionHandler: nil
      )
    }
  }

  // AVAudioPlayerDelegate: fires when AVAudioPlayer finishes a buffer. JS
  // listens on `melo-tts` for `audioEnded` to clear `_ttsAudio` ref + the
  // speaking indicator. Without this, JS used a duration heuristic
  // (base64.length × 0.75 / 16000 × 1000) that desyncs from real playback
  // for long buffers; clicking a second message during the gap would race
  // a still-playing audio source.
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    DispatchQueue.main.async {
      if self.ttsAudioPlayer === player {
        self.ttsAudioPlayer = nil
      }
      self.emitTtsEvent(action: "audioEnded")
    }
  }

  private func bindServerOutput(_ pipe: Pipe) {
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        return
      }

      guard let self = self, let chunk = String(data: data, encoding: .utf8), !chunk.isEmpty else {
        return
      }

      DispatchQueue.main.async {
        self.serverOutput.append(chunk)
        if self.serverOutput.count > 4000 {
          self.serverOutput = String(self.serverOutput.suffix(4000))
        }
      }
    }
  }

  private func trimmedServerOutput() -> String {
    let normalized = serverOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.isEmpty ? "(no output captured)" : normalized
  }

  private func resolveNodeExecutable() -> String? {
    let fileManager = FileManager.default
    let environment = ProcessInfo.processInfo.environment

    let directCandidates = [
      environment["MELO_NODE_PATH"],
      environment["NODE_BINARY"],
      environment["NODE"],
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/opt/local/bin/node",
      "/usr/bin/node",
      "/bin/node",
    ].compactMap { $0 }

    for candidate in directCandidates where fileManager.isExecutableFile(atPath: candidate) {
      return candidate
    }

    let nvmRoot = (NSHomeDirectory() as NSString).appendingPathComponent(".nvm/versions/node")
    if let entries = try? fileManager.contentsOfDirectory(atPath: nvmRoot) {
      for version in entries.sorted(by: >) {
        let candidate = (nvmRoot as NSString).appendingPathComponent(version + "/bin/node")
        if fileManager.isExecutableFile(atPath: candidate) {
          return candidate
        }
      }
    }

    return nil
  }

  private func writeDebug(_ message: String) {
    // Diagnostic filesystem writes must never prevent the window from launching.
    let dir = URL(fileURLWithPath: projectDir + "/.tmp", isDirectory: true)
    let path = debugPath
    debugQueue.async {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try? message.write(toFile: path, atomically: true, encoding: .utf8)
    }
  }

  private func captureReadyUIAudit(attempt: Int = 0) {
    let maxAttempts = 8
    let delaySeconds = attempt == 0 ? 0.7 : 0.35

    DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds) {
      let auditScript = """
      (() => {
        const pageTitle =
          document.querySelector('.page-title')?.textContent?.trim() ||
          document.body.innerText.slice(0, 120).trim();
        const composer = document.querySelector('#composer');
        const sendButton = document.querySelector('form[data-form="composer"] button[type="submit"]');
        const homeSurface = document.querySelector('.neural-overview, .neural-chat-home');
        const visible = element => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
        };
        const left = document.querySelector('.topbar-left');
        const center = document.querySelector('.topbar-center');
        const right = document.querySelector('.topbar-right');
        const primaryNavItems = Array.from(document.querySelectorAll('.neural-cluster[data-group]'));
        const primaryNavTitle =
          primaryNavItems[0]?.dataset.group || '';
        const primaryNavTitles = primaryNavItems
          .map(item => item.dataset.group || '')
          .join('|');
        const primaryNavVisible = primaryNavItems.every(item => {
          const rect = item.getBoundingClientRect();
          return visible(item) && rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth;
        });
        const contentScrollbar = document.querySelector('.content-scrollbar');
        const contentScrollbarThumb = document.querySelector('.content-scrollbar-thumb');
        let topbarOverlap = false;
        let composerActionVisible = false;
        if (visible(left) && visible(center) && visible(right)) {
          const l = left.getBoundingClientRect();
          const c = center.getBoundingClientRect();
          const r = right.getBoundingClientRect();
          topbarOverlap = l.right > c.left - 4 || c.right > r.left - 4;
        }
        if (sendButton) {
          const rect = sendButton.getBoundingClientRect();
          composerActionVisible = rect.width > 0 && rect.height > 0 && rect.bottom <= window.innerHeight && rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth;
        }
        return JSON.stringify({
          pageTitle,
          hasComposer: Boolean(composer),
          homeSurfaceVisible: visible(homeSurface),
          topbarOverlap,
          composerActionVisible,
          primaryNavCount: primaryNavItems.length,
          primaryNavTitle,
          primaryNavTitles,
          primaryNavVisible,
          contentScrollbarPresent: Boolean(contentScrollbar && contentScrollbarThumb),
        });
      })()
      """

      self.webView.evaluateJavaScript(auditScript) { result, _ in
        let uiAudit = (result as? String)?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? "{\"pageTitle\":\"(empty)\"}"
        var renderedTitle = "(empty)"
        var hasComposer = false
        var homeSurfaceVisible = false
        var primaryNavCount = 0

        if
          let data = uiAudit.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
          if let pageTitle = json["pageTitle"] as? String, !pageTitle.isEmpty {
            renderedTitle = pageTitle
          }
          hasComposer = json["hasComposer"] as? Bool ?? false
          homeSurfaceVisible = json["homeSurfaceVisible"] as? Bool ?? false
          primaryNavCount = json["primaryNavCount"] as? Int ?? 0
        }

        let readyForVerification = hasComposer && homeSurfaceVisible && primaryNavCount == 5
        if !readyForVerification && attempt < maxAttempts {
          self.captureReadyUIAudit(attempt: attempt + 1)
          return
        }

        self.writeDebug(
          """
          status=page-loaded
          bundlePath=\(self.bundlePath)
          serverURL=\(self.serverURL.absoluteString)
          projectDir=\(self.projectDir)
          webDataPersistent=\(self.webView.configuration.websiteDataStore.isPersistent)
          uiAudit=\(uiAudit)
          renderedTitle=\(renderedTitle)
          """
        )

        if FileManager.default.fileExists(atPath: self.autoCloseSentinelPath) {
          try? FileManager.default.removeItem(atPath: self.autoCloseSentinelPath)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            // Verification exits even when the user's normal close-window
            // preference is to keep Melo running in the background.
            NSApp.terminate(nil)
          }
        }
      }
    }
  }

  // MARK: - Native transcription server

  /// Starts a minimal HTTP server on 127.0.0.1:(port+1) so that the Node.js
  /// backend can request on-device SFSpeechRecognizer transcription for remote
  /// audio files (e.g. Telegram voice notes) without a Whisper API key.
  private func startNativeTranscriptionServer() {
    let listenPort = transcriptionPort
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self = self else { return }

      let sockFd = socket(AF_INET, SOCK_STREAM, 0)
      guard sockFd >= 0 else { return }

      var reuseVal: Int32 = 1
      setsockopt(sockFd, SOL_SOCKET, SO_REUSEADDR, &reuseVal, socklen_t(MemoryLayout<Int32>.size))

      var addr = sockaddr_in()
      addr.sin_len    = UInt8(MemoryLayout<sockaddr_in>.stride)
      addr.sin_family = sa_family_t(AF_INET)
      addr.sin_port   = in_port_t(UInt16(listenPort).bigEndian)
      addr.sin_addr   = in_addr(s_addr: inet_addr("127.0.0.1"))

      let bindOk = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(sockFd, $0, socklen_t(MemoryLayout<sockaddr_in>.stride))
        }
      }
      guard bindOk == 0 else { close(sockFd); return }
      guard Darwin.listen(sockFd, 8) == 0 else { close(sockFd); return }

      self.transcriptionServerFd = sockFd

      while true {
        let clientFd = Darwin.accept(sockFd, nil, nil)
        guard clientFd >= 0 else { break }
        DispatchQueue.global(qos: .utility).async {
          self.handleTranscriptionClient(clientFd)
        }
      }
      close(sockFd)
    }
  }

  private func handleTranscriptionClient(_ fd: Int32) {
    defer { close(fd) }

    // Read the entire HTTP request (headers + JSON body).
    var raw = Data()
    let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
    defer { chunk.deallocate() }

    outer: while true {
      let n = read(fd, chunk, 4096)
      if n <= 0 { break }
      raw.append(chunk, count: n)

      // Stop once we have headers and enough body bytes.
      guard let s = String(data: raw, encoding: .utf8),
            let sepRange = s.range(of: "\r\n\r\n") else { continue }
      let headers = String(s[s.startIndex..<sepRange.lowerBound])
      let bodyStart = s.distance(from: s.startIndex, to: sepRange.upperBound)

      // Parse Content-Length so we know when the full body arrived.
      var contentLength = 0
      for line in headers.components(separatedBy: "\r\n") {
        let low = line.lowercased()
        if low.hasPrefix("content-length:") {
          contentLength = Int(low.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) ?? 0
        }
      }
      if raw.count >= bodyStart + contentLength { break outer }
    }

    guard let requestStr = String(data: raw, encoding: .utf8),
          let sepRange = requestStr.range(of: "\r\n\r\n") else {
      sendTranscriptionResponse(fd: fd, status: 400, body: #"{"error":"bad request"}"#)
      return
    }

    // Device location for the device_location tool (NativeLocation.swift).
    if requestStr.hasPrefix("POST /location ") {
      guard NativeLocation.allowed(request: String(requestStr[..<sepRange.lowerBound]), port: transcriptionPort) else {
        sendTranscriptionResponse(fd: fd, status: 403, body: #"{"ok":false,"error":"forbidden"}"#)
        return
      }
      sendTranscriptionResponse(fd: fd, status: 200, body: NativeLocation.shared.currentJSON())
      return
    }

    let bodyStr = String(requestStr[sepRange.upperBound...])
    guard let bodyData = bodyStr.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: bodyData) as? [String: String],
          let filePath = json["path"], !filePath.isEmpty else {
      sendTranscriptionResponse(fd: fd, status: 400, body: #"{"error":"missing path"}"#)
      return
    }

    let fileURL = URL(fileURLWithPath: filePath)
    let sem = DispatchSemaphore(value: 0)
    var result: String? = nil

    transcribeLocalFile(fileURL) { text in
      result = text
      sem.signal()
    }
    sem.wait()

    if let text = result {
      let escaped = text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
      sendTranscriptionResponse(fd: fd, status: 200, body: #"{"text":"\#(escaped)"}"#)
    } else {
      sendTranscriptionResponse(fd: fd, status: 200, body: #"{"error":"transcription failed"}"#)
    }
  }

  private func transcribeLocalFile(_ url: URL, completion: @escaping (String?) -> Void) {
    // Use the multilingual pool so Telegram voices in Korean, Japanese,
    // French, Italian, Spanish etc. are correctly recognised alongside
    // Chinese and English.  Run all available recognizers in parallel and
    // return the result with the highest average segment confidence.
    let available = multilingualRecognizers.filter { $0.isAvailable }
    guard !available.isEmpty else {
      completion(nil)
      return
    }

    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        completion(nil)
        return
      }

      let group   = DispatchGroup()
      let lock    = NSLock()
      var best: (confidence: Double, text: String)? = nil

      for recognizer in available {
        group.enter()
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false

        recognizer.recognitionTask(with: request) { result, error in
          defer { group.leave() }
          guard let result = result, result.isFinal else { return }

          let segs = result.bestTranscription.segments
          let avgConf: Double = segs.isEmpty ? 0.5 :
            segs.map { Double($0.confidence) }.reduce(0, +) / Double(segs.count)
          let text = result.bestTranscription.formattedString
            .trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { return }

          lock.lock()
          if best == nil || avgConf > best!.confidence {
            best = (avgConf, text)
          }
          lock.unlock()
        }
      }

      group.notify(queue: .global(qos: .utility)) {
        completion(best?.text)
      }
    }
  }

  private func sendTranscriptionResponse(fd: Int32, status: Int, body: String) {
    let statusText = status == 200 ? "OK" : status == 403 ? "Forbidden" : "Bad Request"
    let response = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
    if let data = response.data(using: .utf8) {
      _ = data.withUnsafeBytes { ptr in
        Darwin.write(fd, ptr.baseAddress!, data.count)
      }
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { loadErrorPage(message: error.localizedDescription) }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { loadErrorPage(message: error.localizedDescription) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard hasLoadedServer else { return }

    // Also cancels permission requests and invalidates their late callbacks.
    voiceInput.cancel()

    captureReadyUIAudit()
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.allow)
      return
    }

    if isExternalWebUrl(url) {
      openExternalLink(url)
      decisionHandler(.cancel)
      return
    }

    decisionHandler(.allow)
  }

  private func openExternalLink(_ url: URL) {
    guard let browser = NSWorkspace.shared.urlForApplication(toOpen: url) else {
      reportExternalLinkFailure()
      return
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.open([url], withApplicationAt: browser, configuration: configuration) { _, error in
      if error != nil { self.reportExternalLinkFailure() }
    }
  }

  private func reportExternalLinkFailure() {
    DispatchQueue.main.async {
      self.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('melo-external-link', {detail:{ok:false}}));", completionHandler: nil)
    }
  }

  private func isExternalWebUrl(_ url: URL) -> Bool {
    let scheme = url.scheme?.lowercased() ?? ""
    guard scheme == "http" || scheme == "https" else { return false }
    return !isMeloServerUrl(url)
  }

  private func isMeloServerUrl(_ url: URL) -> Bool {
    guard
      let host = url.host,
      let serverHost = serverURL.host
    else {
      return false
    }

    let urlPort = url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
    let serverPort = serverURL.port ?? (serverURL.scheme?.lowercased() == "https" ? 443 : 80)
    return url.scheme?.lowercased() == serverURL.scheme?.lowercased()
      && host == serverHost
      && urlPort == serverPort
  }
}

@main
struct MeloDesktopApp {
  static func main() {
    let app = NSApplication.shared
    let delegate = MeloAppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}
