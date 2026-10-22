import Foundation
import Darwin
import CoreFoundation

// The bundled desktop pet: desktop-pet/main.cjs run by its own Electron
// (runtime/DSHPet.app) from Melo.app/Contents/Resources/desktop-pet. Melo starts
// it after the server is ready when the "桌面宠物" preference is on, stops it
// through the pet's control service, and reports the real state from the pet's
// runtime record (~/Library/Application Support/melo-desktop-pet-dsh/runtime.json,
// written 0600 by runtime-info.cjs once the control server listens and removed
// on shutdown). A pet that quits on its own clears the preference via
// onUnexpectedExit so the settings switch never disagrees with the desktop.
final class DesktopPetManager {
  static let preferenceKey = "melo.desktopPet"

  struct RuntimeInfo {
    let pid: pid_t
    let controlURL: URL
    let token: String
  }

  /// The pet tree, or nil when this build carries none (or MELO_DESKTOP_PET_DISABLED=1).
  let directory: String?
  let profileDirectory: String
  private(set) var process: Process?
  private var stopRequested = false
  private var starting = false
  private var watchdog: DispatchSourceTimer?
  /// Main thread. The pet Melo expected to be running is gone and Melo did not stop it.
  var onUnexpectedExit: (() -> Void)?

  init(projectDir: String, environment: [String: String] = ProcessInfo.processInfo.environment, bundleResources: URL? = Bundle.main.resourceURL) {
    profileDirectory = environment["MELO_PET_PROFILE"].flatMap { $0.isEmpty ? nil : $0 }
      ?? NSHomeDirectory() + "/Library/Application Support/melo-desktop-pet-dsh"
    var candidates: [String] = []
    if let explicit = environment["MELO_DESKTOP_PET_DIR"], !explicit.isEmpty { candidates.append(explicit) }
    if let resources = bundleResources { candidates.append(resources.appendingPathComponent("desktop-pet").path) }
    candidates.append(projectDir + "/desktop-pet")
    directory = environment["MELO_DESKTOP_PET_DISABLED"] == "1" ? nil : candidates.first(where: DesktopPetManager.isComplete)
  }

  static func isComplete(_ dir: String) -> Bool {
    FileManager.default.fileExists(atPath: dir + "/main.cjs")
      && FileManager.default.isExecutableFile(atPath: dir + "/runtime/DSHPet.app/Contents/MacOS/Electron")
  }

  var isAvailable: Bool { directory != nil }
  var runtimeInfoPath: String { profileDirectory + "/runtime.json" }
  var logPath: String { profileDirectory + "/melo-launch.log" }

  /// A JS boolean arrives as NSNumber; a select control sends "true"/"false".
  static func boolValue(_ value: Any?) -> Bool? {
    if let number = value as? NSNumber { return number.boolValue }
    if let text = value as? String { return text == "true" ? true : text == "false" ? false : nil }
    return nil
  }

  func runtimeInfo() -> RuntimeInfo? {
    guard let data = FileManager.default.contents(atPath: runtimeInfoPath),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let pid = json["pid"] as? Int, pid > 1,
          let urlString = json["controlUrl"] as? String, let url = URL(string: urlString),
          url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
          let token = json["token"] as? String, token.count >= 32 else { return nil }
    return RuntimeInfo(pid: pid_t(pid), controlURL: url, token: token)
  }

  /// Signal 0 probes the process; a reaped child or a crashed pet is dead, a zombie too.
  static func isAlive(_ pid: pid_t) -> Bool {
    guard pid > 1 else { return false }
    if kill(pid, 0) != 0 { return errno == EPERM }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else { return false }
    return Int32(info.kp_proc.p_stat) != SZOMB
  }

  /// The child Melo started, or any pet whose record names a live process (one started from another entry point).
  func isRunning() -> Bool {
    if let child = process, child.isRunning { return true }
    guard let info = runtimeInfo() else { return false }
    return DesktopPetManager.isAlive(info.pid)
  }

  // MARK: start

  func start(baseURL: URL, completion: @escaping (String?) -> Void) {
    guard let directory else { completion("当前安装未包含桌面宠物。"); return }
    stopRequested = false
    if isRunning() { startWatching(); completion(nil); return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: directory + "/runtime/DSHPet.app/Contents/MacOS/Electron")
    process.arguments = [directory + "/main.cjs"]
    process.currentDirectoryURL = URL(fileURLWithPath: directory)
    var environment = ProcessInfo.processInfo.environment
    environment["HOME"] = NSHomeDirectory()
    // The pet connects to this Melo, whatever port it bound (see prepareLaunchPort in main.swift).
    environment["MELO_BASE_URL"] = baseURL.absoluteString
    environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    try? FileManager.default.createDirectory(atPath: profileDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logPath, contents: nil, attributes: [.posixPermissions: 0o600])
    if let log = FileHandle(forWritingAtPath: logPath) {
      log.truncateFile(atOffset: 0)
      process.standardOutput = log
      process.standardError = log
    }
    starting = true
    process.terminationHandler = { [weak self] ended in
      DesktopPetManager.onMain {
        guard let self, self.process === ended else { return }
        self.process = nil
        if self.starting || self.stopRequested { return }
        self.stopWatching()
        self.onUnexpectedExit?()
      }
    }
    do { try process.run() } catch {
      starting = false
      completion("桌宠启动失败：\(error.localizedDescription)")
      return
    }
    self.process = process
    let pid = process.processIdentifier
    let logPath = self.logPath
    DesktopPetManager.waitUntil({ [weak self] in
      guard let self else { return true }
      if let info = self.runtimeInfo(), info.pid == pid { return true }
      return !process.isRunning
    }, timeout: 12) { [weak self] _ in
      guard let self else { completion(nil); return }
      self.starting = false
      if let info = self.runtimeInfo(), info.pid == pid { self.startWatching(); completion(nil); return }
      if process.isRunning { self.startWatching(); completion("桌宠已启动，但 12 秒内未写入运行记录；请查看 \(logPath)。"); return }
      self.process = nil
      // Another instance may own the single-instance lock, e.g. the old desktop entry.
      if let info = self.runtimeInfo(), DesktopPetManager.isAlive(info.pid) { self.startWatching(); completion(nil); return }
      completion(process.terminationStatus == 0
        ? "桌宠立即退出了。若桌面旧入口的桌宠仍在运行，请先退出它再开启。"
        : "桌宠未能启动（退出码 \(process.terminationStatus)），详见 \(logPath)。")
    }
  }

  // MARK: stop

  /// Asks the pet to quit through its control service, then waits for the process to end.
  /// A pet that does not answer is signalled like the server (SIGTERM, then SIGKILL for Melo's own child).
  func stop(completion: @escaping () -> Void) {
    stopRequested = true
    stopWatching()
    let child = process
    let childRunning = child?.isRunning ?? false
    let info = runtimeInfo()
    let recordedAlive = info.map { DesktopPetManager.isAlive($0.pid) } ?? false
    guard childRunning || recordedAlive else { process = nil; completion(); return }
    let pid = childRunning ? child!.processIdentifier : info!.pid
    let finish: () -> Void = { [weak self] in self?.process = nil; completion() }
    let escalate: () -> Void = {
      if let child, child.isRunning { ProcessShutdown.stop(child, timeout: 6) { finish() }; return }
      kill(pid, SIGTERM)
      DesktopPetManager.waitUntil({ !DesktopPetManager.isAlive(pid) }, timeout: 6) { _ in finish() }
    }
    let awaitExit: () -> Void = {
      DesktopPetManager.waitUntil({ !DesktopPetManager.isAlive(pid) }, timeout: 6) { exited in exited ? finish() : escalate() }
    }
    if let info { requestQuit(info, then: awaitExit) } else { escalate() }
  }

  /// Last resort on applicationWillTerminate: a child that is somehow still running must not outlive Melo.
  func terminateChildIfRunning() {
    stopRequested = true
    stopWatching()
    if let child = process, child.isRunning { child.terminate() }
  }

  private func requestQuit(_ info: RuntimeInfo, then: @escaping () -> Void) {
    var request = URLRequest(url: info.controlURL.appendingPathComponent("quit"))
    request.httpMethod = "POST"
    request.timeoutInterval = 3
    request.setValue("Bearer " + info.token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)
    URLSession.shared.dataTask(with: request) { _, _, _ in DesktopPetManager.onMain(then) }.resume()
  }

  // MARK: watching

  /// A pet started from the desktop entry is not Melo's child: poll its record so the switch follows it too.
  private func startWatching() {
    guard watchdog == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler { [weak self] in
      guard let self, !self.stopRequested, !self.starting else { return }
      if !self.isRunning() { self.stopWatching(); self.onUnexpectedExit?() }
    }
    timer.resume()
    watchdog = timer
  }

  private func stopWatching() {
    watchdog?.cancel()
    watchdog = nil
  }

  // MARK: run-loop plumbing (same modes as ProcessShutdown: termination runs the main loop in modal mode)

  private static let mainLoopModes: [RunLoop.Mode] = [.default, .common, RunLoop.Mode("NSModalPanelRunLoopMode")]

  private static func onMain(_ block: @escaping () -> Void) {
    RunLoop.main.perform(inModes: mainLoopModes, block: block)
    CFRunLoopWakeUp(CFRunLoopGetMain())
  }

  private static func waitUntil(_ condition: @escaping () -> Bool, timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
    DispatchQueue.global(qos: .utility).async {
      let deadline = Date().addingTimeInterval(timeout)
      var satisfied = condition()
      while !satisfied && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.1)
        satisfied = condition()
      }
      let result = satisfied
      onMain { completion(result) }
    }
  }
}
