import AppKit
import AVFoundation
import Darwin
import Foundation
import Speech
import WebKit

final class MeloAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, AVAudioPlayerDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var serverProcess: Process?
  private lazy var projectDir: String = {
    if let envDir = ProcessInfo.processInfo.environment["MELO_PROJECT_DIR"], !envDir.isEmpty {
      return envDir
    }

    let homeDir = NSHomeDirectory()
    let bundleParentDir = Bundle.main.bundleURL.deletingLastPathComponent().path
    let bundleGrandparentDir = (bundleParentDir as NSString).deletingLastPathComponent
    let candidateProjectDirs = [
      bundleParentDir,
      (bundleParentDir as NSString).appendingPathComponent("Melo Desktop Project"),
      (bundleGrandparentDir as NSString).appendingPathComponent("Melo Desktop Project"),
      (homeDir as NSString).appendingPathComponent("Desktop/melo/Melo Desktop Project"),
      (homeDir as NSString).appendingPathComponent("Documents/New project"),
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
    ProcessInfo.processInfo.environment["MELO_DESKTOP_PORT"] ?? "43127"
  ) ?? 43127
  private var port = 43127
  private var hasLoadedServer = false
  private var resolvedNodePath: String?
  private var serverOutput = ""
  private let audioEngine = AVAudioEngine()
  // Primary recognizer (follows system language) — used for live microphone input.
  private static func makeSpeechRecognizer() -> SFSpeechRecognizer? {
    if let lang = Locale.preferredLanguages.first {
      if let r = SFSpeechRecognizer(locale: Locale(identifier: lang)) { return r }
    }
    if let r = SFSpeechRecognizer(locale: Locale.autoupdatingCurrent) { return r }
    return SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  }
  private var speechRecognizer: SFSpeechRecognizer? = MeloAppDelegate.makeSpeechRecognizer()

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
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var latestTranscript = ""
  private var isVoiceRecording = false
  // Native TTS audio player (bypasses WKWebView autoplay restrictions)
  private var ttsAudioPlayer: AVAudioPlayer?
  // Native speech synthesizer for high-quality system TTS
  private let speechSynthesizer = AVSpeechSynthesizer()
  // `say` command process for system TTS (avoids AVAudioEngine session conflicts)
  private var sayProcess: Process?
  // Raw audio capture for voice-message attachments
  private var capturedAudioBuffers: [AVAudioPCMBuffer] = []
  private let capturedAudioLock = NSLock()
  private var capturedAudioFormat: AVAudioFormat?
  // Native transcription server (127.0.0.1:transcriptionPort)
  // Lets the Node.js backend request on-device SFSpeechRecognizer transcription
  // for Telegram voice notes and other remote audio without needing a Whisper API key.
  private var transcriptionServerFd: Int32 = -1
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
    projectDir + "/.tmp/melo-home-user"
  }

  private var legacySharedMeloHomePath: String {
    projectDir + "/.tmp/melo-home"
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    installMainMenu()
    buildWindow()
    writeDebug("status=launching")
    loadPlaceholder()
    startServerIfNeeded()
    startNativeTranscriptionServer()
    pollServerAndLoad()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationWillTerminate(_ notification: Notification) {
    stopVoiceRecognition(manual: false)
    // Without these calls a `say` child or AVAudioPlayer can keep playing for
    // several seconds after the app window has closed, until the OS reaps the
    // detached children.
    ttsAudioPlayer?.stop()
    ttsAudioPlayer = nil
    speechSynthesizer.stopSpeaking(at: .immediate)
    sayProcess?.terminate()
    sayProcess = nil
    serverProcess?.terminate()
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
    window.center()
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = false
    window.isMovableByWindowBackground = false
    window.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 1.0)
    window.setContentSize(NSSize(width: 1320, height: 860))
    window.minSize = NSSize(width: 1080, height: 720)
    window.title = "Melo"
    window.toolbarStyle = .unifiedCompact

    let userContentController = WKUserContentController()
    userContentController.add(self, name: "meloVoice")
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = userContentController
    configuration.websiteDataStore = .default()
    configuration.mediaTypesRequiringUserActionForPlayback = []  // allow TTS autoplay
    webView = WKWebView(frame: rect, configuration: configuration)
    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")

    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
  }

  private func loadPlaceholder() {
    let html = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          :root {
            color-scheme: dark;
          }
          html, body {
            margin: 0;
            height: 100%;
            background:
              radial-gradient(circle at top right, rgba(24,183,177,0.12), transparent 22%),
              linear-gradient(180deg, #181916 0%, #151613 100%);
            color: rgba(255,247,232,0.92);
            font-family: "Avenir Next", "Helvetica Neue", sans-serif;
          }
          body {
            display: grid;
            place-items: center;
          }
          .card {
            width: 420px;
            border-radius: 30px;
            border: 1px solid rgba(255,255,255,0.08);
            background: rgba(255,255,255,0.03);
            box-shadow: 0 28px 60px rgba(0,0,0,0.28);
            padding: 28px 30px;
          }
          h1 {
            margin: 0 0 12px;
            font: 500 38px/1.08 "Iowan Old Style", Georgia, serif;
            letter-spacing: -0.04em;
          }
          p {
            margin: 0;
            color: rgba(255,255,255,0.66);
            line-height: 1.7;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Launching Melo Desktop</h1>
          <p>Starting the local UI server and loading your workspace...</p>
        </div>
      </body>
    </html>
    """

    webView.loadHTMLString(html, baseURL: nil)
  }

  private func startServerIfNeeded() {
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
    process.environment = [
      "HOME": NSHomeDirectory(),
      "MELO_HOME": runtimeMeloHomePath,
      // The server may bind a rolled-forward port if the configured 43127 is
      // taken (see prepareLaunchPort). Anything in Node that needs to talk
      // back to native services on port+N (transcription server at port+1,
      // signed-URL minting in src/web/urlSigning.js, etc.) reads this env
      // var. Without it those reads fall back to 43127 and miss the actual
      // listener on 43128/43129/...
      "MELO_DESKTOP_PORT": String(port),
      "PATH": [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].joined(separator: ":"),
    ]

    let outputPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = outputPipe
    bindServerOutput(outputPipe)
    process.terminationHandler = { [weak self] terminated in
      guard let self = self else { return }
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
    var attempts = 0
    let timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] timer in
      guard let self = self else {
        timer.invalidate()
        return
      }

      attempts += 1
      if self.serverIsHealthy() {
        timer.invalidate()
        self.resetServerLaunchState()
        self.hasLoadedServer = true
        self.writeDebug(
          """
          status=server-ready
          bundlePath=\(self.bundlePath)
          serverURL=\(self.serverURL.absoluteString)
          projectDir=\(self.projectDir)
          """
        )
        self.webView.load(URLRequest(url: self.serverURL))
        return
      }

      if attempts >= 45 {
        timer.invalidate()
        self.writeDebug(
          """
          status=server-timeout
          serverURL=\(self.serverURL.absoluteString)
          nodePath=\(self.resolvedNodePath ?? "(unknown)")
          output=\(self.trimmedServerOutput())
          """
        )
        self.loadErrorPage(
          message: """
          Melo Desktop could not reach the local UI server.
          Expected \(self.serverURL.absoluteString)

          Node: \(self.resolvedNodePath ?? "(not found)")
          Last output:
          \(self.trimmedServerOutput())
          """
        )
      }
    }

    RunLoop.main.add(timer, forMode: .common)
  }

  private func serverIsHealthy() -> Bool {
    guard let url = URL(string: serverURL.absoluteString + "/api/health") else {
      return false
    }

    guard
      let data = try? Data(contentsOf: url),
      let text = String(data: data, encoding: .utf8)
    else {
      return false
    }

    return text.contains("\"ok\":true")
  }

  private func resetServerLaunchState() {
    guard let url = URL(string: serverURL.absoluteString + "/api/launch/reset") else {
      return
    }

    _ = try? Data(contentsOf: url)
  }

  private func prepareLaunchPort() {
    let candidatePorts = [configuredPort] + Array((configuredPort + 1)...(configuredPort + 6))
    for candidate in candidatePorts {
      if isPortAvailable(candidate) {
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
    let escaped = message
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\n", with: "<br />")

    let html = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          html, body {
            margin: 0;
            height: 100%;
            background: #151613;
            color: rgba(255,221,214,0.96);
            font-family: "Avenir Next", "Helvetica Neue", sans-serif;
          }
          body {
            display: grid;
            place-items: center;
          }
          .error {
            width: 560px;
            border-radius: 30px;
            border: 1px solid rgba(255,144,127,0.28);
            background: rgba(255,144,127,0.12);
            padding: 24px 26px;
            line-height: 1.75;
          }
          button {
            margin-top: 18px;
            border: 0;
            border-radius: 999px;
            padding: 10px 16px;
            background: rgba(255,255,255,0.12);
            color: white;
            font: inherit;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <div class="error">
          \(escaped)
          <br />
          <button onclick="window.location.reload()">Retry launch</button>
        </div>
      </body>
    </html>
    """

    webView.loadHTMLString(html, baseURL: nil)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "meloVoice" else { return }
    guard
      let payload = message.body as? [String: Any],
      let action = payload["action"] as? String
    else {
      return
    }

    switch action {
    case "toggle":
      toggleVoiceRecognition()
    case "stop":
      stopVoiceRecognition(manual: true)
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
          if lang.hasPrefix("zh") {
            task.arguments = ["-v", "Tingting", text]
          } else if lang.hasPrefix("ko") {
            task.arguments = ["-v", "Yuna", text]
          } else if lang.hasPrefix("ja") {
            task.arguments = ["-v", "Kyoko", text]
          } else {
            task.arguments = [text]
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
        NSWorkspace.shared.open(url)
      }
    default:
      break
    }
  }

  private func toggleVoiceRecognition() {
    if isVoiceRecording {
      stopVoiceRecognition(manual: true)
      return
    }

    requestVoicePermissions { granted, errorMessage in
      guard granted else {
        self.emitVoiceEvent(
          supported: true,
          recording: false,
          status: "error",
          partial: nil,
          finalText: nil,
          error: errorMessage ?? "Voice input permission was denied."
        )
        return
      }

      self.startVoiceRecognition()
    }
  }

  private func requestVoicePermissions(completion: @escaping (Bool, String?) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async {
          let message: String
          switch status {
          case .authorized:
            message = ""
          case .denied:
            message = "Speech recognition access is denied. Enable it in System Settings."
          case .restricted:
            message = "Speech recognition is restricted on this Mac."
          case .notDetermined:
            message = "Speech recognition permission has not been granted yet."
          @unknown default:
            message = "Speech recognition is unavailable."
          }
          completion(false, message)
        }
        return
      }

      AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
          completion(
            granted,
            granted ? nil : "Microphone access is denied. Enable it in System Settings."
          )
        }
      }
    }
  }

  private func startVoiceRecognition() {
    DispatchQueue.main.async {
      self.resetVoiceRecognitionState()

      guard let recognizer = self.speechRecognizer ?? SFSpeechRecognizer(locale: Locale(identifier: "en_US")) else {
        self.emitVoiceEvent(
          supported: false,
          recording: false,
          status: "error",
          partial: nil,
          finalText: nil,
          error: "Speech recognition is unavailable on this device."
        )
        return
      }

      guard recognizer.isAvailable else {
        self.emitVoiceEvent(
          supported: true,
          recording: false,
          status: "error",
          partial: nil,
          finalText: nil,
          error: "Speech recognition is temporarily unavailable."
        )
        return
      }

      self.speechRecognizer = recognizer
      self.latestTranscript = ""
      // Clear any previously captured audio
      self.capturedAudioLock.lock()
      self.capturedAudioBuffers = []
      self.capturedAudioLock.unlock()
      self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
      self.recognitionRequest?.shouldReportPartialResults = true
      self.recognitionRequest?.taskHint = .dictation

      guard let recognitionRequest = self.recognitionRequest else {
        self.emitVoiceEvent(
          supported: true,
          recording: false,
          status: "error",
          partial: nil,
          finalText: nil,
          error: "Unable to prepare voice input."
        )
        return
      }

      let inputNode = self.audioEngine.inputNode
      let recordingFormat = inputNode.outputFormat(forBus: 0)
      self.capturedAudioFormat = recordingFormat
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
        guard let self = self else { return }
        self.recognitionRequest?.append(buffer)
        // Capture raw PCM for voice-message attachment (cap at ~700 buffers ≈ 16 s)
        if let copy = buffer.copy() as? AVAudioPCMBuffer {
          self.capturedAudioLock.lock()
          if self.capturedAudioBuffers.count < 700 {
            self.capturedAudioBuffers.append(copy)
          }
          self.capturedAudioLock.unlock()
        }
      }

      self.audioEngine.prepare()

      do {
        try self.audioEngine.start()
      } catch {
        self.resetVoiceRecognitionState()
        self.emitVoiceEvent(
          supported: true,
          recording: false,
          status: "error",
          partial: nil,
          finalText: nil,
          error: "Melo could not start the microphone. \(error.localizedDescription)"
        )
        return
      }

      self.isVoiceRecording = true
      self.emitVoiceEvent(
        supported: true,
        recording: true,
        status: "listening",
        partial: nil,
        finalText: nil,
        error: nil
      )

      self.recognitionTask = recognizer.recognitionTask(with: recognitionRequest) { result, error in
        if let result = result {
          let transcript = result.bestTranscription.formattedString.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
          self.latestTranscript = transcript

          if result.isFinal {
            // Build WAV data URL BEFORE stopVoiceRecognition clears the captured buffers.
            let audioDataURL = self.buildWavDataURL()
            self.emitVoiceEvent(
              supported: true,
              recording: false,
              status: "ready",
              partial: nil,
              finalText: transcript,
              audioData: audioDataURL,
              error: nil
            )
            self.stopVoiceRecognition(manual: false, emitEvent: false)
          } else {
            self.emitVoiceEvent(
              supported: true,
              recording: true,
              status: "listening",
              partial: transcript,
              finalText: nil,
              error: nil
            )
          }
          return
        }

        if let error = error {
          // recognitionRequest is set to nil inside resetVoiceRecognitionState().
          // If it is already nil here, the error is a side-effect of an intentional
          // cancel (e.g. after isFinal, or after manual stop) — not a real failure.
          // Emitting an event in that case causes duplicate text insertion and a
          // spurious error notification, so we bail out early.
          guard self.recognitionRequest != nil else { return }

          self.stopVoiceRecognition(manual: false, emitEvent: false)
          self.emitVoiceEvent(
            supported: true,
            recording: false,
            status: "error",
            partial: nil,
            finalText: self.latestTranscript.isEmpty ? nil : self.latestTranscript,
            error: error.localizedDescription
          )
        }
      }
    }
  }

  private func resetVoiceRecognitionState() {
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    // Clear audio capture buffers (tap is removed above so no new writes will arrive)
    capturedAudioLock.lock()
    capturedAudioBuffers = []
    capturedAudioLock.unlock()
    capturedAudioFormat = nil
    // Nil recognitionRequest BEFORE cancelling the task. recognitionTask?.cancel() can
    // synchronously invoke the recognition callback with error 216 (cancelled). That
    // callback guards on `recognitionRequest != nil`; setting it to nil first ensures
    // the guard fires and we return early, preventing a duplicate finalText event.
    let req = recognitionRequest
    recognitionRequest = nil
    req?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    isVoiceRecording = false
  }

  private func stopVoiceRecognition(manual: Bool, emitEvent: Bool = true) {
    DispatchQueue.main.async {
      let capturedTranscript = self.latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
      // Build the WAV data URL before resetVoiceRecognitionState clears the buffers.
      let audioDataURL = (manual && !capturedTranscript.isEmpty) ? self.buildWavDataURL() : nil
      self.resetVoiceRecognitionState()

      if emitEvent {
        self.emitVoiceEvent(
          supported: true,
          recording: false,
          status: manual ? "stopped" : "idle",
          partial: nil,
          finalText: manual && !capturedTranscript.isEmpty ? capturedTranscript : nil,
          audioData: audioDataURL,
          error: nil
        )
      }
    }
  }

  // Builds a WAV data URL from the captured PCM buffers, downmixed to mono 16-bit.
  // Returns nil if no audio was captured or the buffers are empty.
  private func buildWavDataURL() -> String? {
    capturedAudioLock.lock()
    let buffers = capturedAudioBuffers
    let format = capturedAudioFormat
    capturedAudioLock.unlock()

    guard !buffers.isEmpty, let fmt = format, fmt.channelCount > 0 else { return nil }

    let sampleRate = UInt32(fmt.sampleRate)
    let inputChannels = Int(fmt.channelCount)
    let outputChannels: UInt16 = 1 // always mono output
    let bitsPerSample: UInt16 = 16

    var pcmData = Data()
    for buffer in buffers {
      guard let floatData = buffer.floatChannelData else { continue }
      let frameCount = Int(buffer.frameLength)
      for frame in 0..<frameCount {
        var sample: Float = 0
        for ch in 0..<inputChannels {
          sample += floatData[ch][frame]
        }
        sample /= Float(inputChannels)
        let clamped = max(-1.0, min(1.0, sample))
        var s16 = Int16(clamped < 0 ? clamped * 32768.0 : clamped * 32767.0).littleEndian
        withUnsafeBytes(of: &s16) { pcmData.append(contentsOf: $0) }
      }
    }

    guard !pcmData.isEmpty else { return nil }

    let dataSize = UInt32(pcmData.count)
    let byteRate = sampleRate * UInt32(outputChannels) * UInt32(bitsPerSample / 8)
    let blockAlign = outputChannels * (bitsPerSample / 8)

    func le32(_ v: UInt32) -> Data {
      var x = v.littleEndian
      return Data(bytes: &x, count: 4)
    }
    func le16(_ v: UInt16) -> Data {
      var x = v.littleEndian
      return Data(bytes: &x, count: 2)
    }

    var wavData = Data()
    wavData.append("RIFF".data(using: .ascii)!)
    wavData.append(le32(36 + dataSize))
    wavData.append("WAVE".data(using: .ascii)!)
    wavData.append("fmt ".data(using: .ascii)!)
    wavData.append(le32(16))
    wavData.append(le16(1))             // PCM format
    wavData.append(le16(outputChannels))
    wavData.append(le32(sampleRate))
    wavData.append(le32(byteRate))
    wavData.append(le16(blockAlign))
    wavData.append(le16(bitsPerSample))
    wavData.append("data".data(using: .ascii)!)
    wavData.append(le32(dataSize))
    wavData.append(pcmData)

    return "data:audio/wav;base64,\(wavData.base64EncodedString())"
  }

  private func emitVoiceEvent(
    supported: Bool,
    recording: Bool,
    status: String,
    partial: String?,
    finalText: String?,
    audioData: String? = nil,
    error: String?
  ) {
    var payload: [String: Any] = [
      "supported": supported,
      "recording": recording,
      "status": status,
    ]

    if let partial = partial, !partial.isEmpty {
      payload["partial"] = partial
    }

    if let finalText = finalText, !finalText.isEmpty {
      payload["finalText"] = finalText
    }

    if let audioData = audioData, !audioData.isEmpty {
      payload["audioData"] = audioData
    }

    if let error = error, !error.isEmpty {
      payload["error"] = error
    }

    guard
      let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    else {
      return
    }

    DispatchQueue.main.async {
      self.webView.evaluateJavaScript(
        "window.dispatchEvent(new CustomEvent('melo-voice', { detail: \(json) }));",
        completionHandler: nil
      )
    }
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
    let dir = URL(fileURLWithPath: projectDir + "/.tmp", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? message.write(toFile: debugPath, atomically: true, encoding: .utf8)
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
        const sendButton = document.querySelector('.composer-icon-button.is-primary');
        const homeSurface = document.querySelector('.chat-home');
        const left = document.querySelector('.topbar-left');
        const center = document.querySelector('.topbar-center');
        const right = document.querySelector('.topbar-right');
        const primaryNavItems = Array.from(document.querySelectorAll('.nav-group .nav-item'));
        const primaryNavTitle =
          primaryNavItems[0]?.querySelector('.nav-title')?.textContent?.trim() || '';
        const primaryNavTitles = primaryNavItems
          .map(item => item.querySelector('.nav-title')?.textContent?.trim() || '')
          .join('|');
        const primaryNavVisible = primaryNavItems.every(item => {
          const rect = item.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight;
        });
        const contentScrollbar = document.querySelector('.content-scrollbar');
        const contentScrollbarThumb = document.querySelector('.content-scrollbar-thumb');
        let topbarOverlap = false;
        let composerActionVisible = false;
        if (left && center && right) {
          const l = left.getBoundingClientRect();
          const c = center.getBoundingClientRect();
          const r = right.getBoundingClientRect();
          topbarOverlap = l.right > c.left - 4 || c.right > r.left - 4;
        }
        if (sendButton) {
          const rect = sendButton.getBoundingClientRect();
          composerActionVisible = rect.bottom <= window.innerHeight - 12 && rect.top >= 0;
        }
        return JSON.stringify({
          pageTitle,
          hasComposer: Boolean(composer),
          homeSurfaceVisible: Boolean(homeSurface),
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

        let readyForVerification = hasComposer && homeSurfaceVisible && primaryNavCount >= 8
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
          uiAudit=\(uiAudit)
          renderedTitle=\(renderedTitle)
          """
        )

        if FileManager.default.fileExists(atPath: self.autoCloseSentinelPath) {
          try? FileManager.default.removeItem(atPath: self.autoCloseSentinelPath)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            self.window.close()
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
    let statusText = status == 200 ? "OK" : "Bad Request"
    let response = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
    if let data = response.data(using: .utf8) {
      _ = data.withUnsafeBytes { ptr in
        Darwin.write(fd, ptr.baseAddress!, data.count)
      }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard hasLoadedServer else { return }

    // If a reload landed while the mic was hot, JS has lost its in-flight
    // recording state (uiState.voice resets to recording:false at module
    // load). Tearing down the recognition session here keeps the two sides
    // in sync — otherwise the icons read "idle" while Swift is still
    // capturing audio, and a mid-window mic click would tell Swift to stop
    // and discard the recording.
    if isVoiceRecording {
      stopVoiceRecognition(manual: false, emitEvent: false)
    }

    emitVoiceEvent(
      supported: speechRecognizer != nil,
      recording: isVoiceRecording,
      status: isVoiceRecording ? "listening" : "idle",
      partial: nil,
      finalText: nil,
      error: nil
    )

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
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }

    decisionHandler(.allow)
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
