import Foundation
import Darwin

// A Melo server whose window was killed keeps the home lock and the default
// port. Only that orphan is stopped: the PID comes from the kernel's record of
// who holds the home lock (not a PID file, not a name match), it must be this
// project's own server script, and launchd must have adopted it. A live owner
// such as another window or a terminal server is reported, never signalled.
enum StaleServer {
  enum Outcome: Equatable {
    case clear
    case stopped(pid_t)
    case busy(pid_t)
  }

  static let lockFileName = "melo-desktop-server-lock.sqlite"

  static func reclaim(home: String, serverScript: String, stopTimeout: TimeInterval = 8, ownerGrace: TimeInterval = 7) -> Outcome {
    let lockPath = (home as NSString).appendingPathComponent(lockFileName)
    // A window that is still quitting releases its own server within its
    // shutdown bound; wait that long before calling the home busy.
    let graceDeadline = Date().addingTimeInterval(ownerGrace)
    var stopped: pid_t?
    while let holder = lockHolder(lockPath: lockPath) {
      if holder != stopped, isOrphanedServer(holder, serverScript: serverScript) {
        guard stop(holder, lockPath: lockPath, serverScript: serverScript, timeout: stopTimeout) else { return .busy(holder) }
        stopped = holder
        continue
      }
      if Date() >= graceDeadline { return .busy(holder) }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return stopped.map { .stopped($0) } ?? .clear
  }

  // SQLite's unix VFS holds its lock as POSIX byte locks from PENDING_BYTE
  // (pending, reserved and the 510-byte shared range). F_GETLK reports the
  // owning process without taking a lock; the server's lock dies with it.
  static func lockHolder(lockPath: String) -> pid_t? {
    let fd = open(lockPath, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var probe = flock()
    probe.l_start = 0x4000_0000
    probe.l_len = 512
    probe.l_type = Int16(F_WRLCK)
    probe.l_whence = Int16(SEEK_SET)
    guard fcntl(fd, F_GETLK, &probe) == 0, probe.l_type != Int16(F_UNLCK), probe.l_pid > 0 else { return nil }
    return probe.l_pid
  }

  static func isOrphanedServer(_ pid: pid_t, serverScript: String) -> Bool {
    guard pid > 1, pid != getpid(), let info = kernelInfo(pid), Int32(info.kp_proc.p_stat) != SZOMB,
          info.kp_eproc.e_ppid == 1, info.kp_eproc.e_ucred.cr_uid == getuid(),
          let arguments = arguments(of: pid), arguments.count >= 2 else { return false }
    // The window starts `<node> <project>/src/server.js --host … --port …`.
    return (arguments[0] as NSString).lastPathComponent.hasPrefix("node")
      && canonicalPath(arguments[1]) == canonicalPath(serverScript)
  }

  private static func stop(_ pid: pid_t, lockPath: String, serverScript: String, timeout: TimeInterval) -> Bool {
    kill(pid, SIGTERM)
    if waitForExit(pid, timeout: timeout) { return true }
    // Escalate only while that same orphan still holds this home's lock.
    guard lockHolder(lockPath: lockPath) == pid, isOrphanedServer(pid, serverScript: serverScript) else { return !isRunning(pid) }
    kill(pid, SIGKILL)
    return waitForExit(pid, timeout: 2)
  }

  private static func waitForExit(_ pid: pid_t, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while isRunning(pid) {
      if Date() >= deadline { return false }
      Thread.sleep(forTimeInterval: 0.05)
    }
    return true
  }

  private static func isRunning(_ pid: pid_t) -> Bool {
    guard let info = kernelInfo(pid) else { return false }
    return Int32(info.kp_proc.p_stat) != SZOMB
  }

  private static func kernelInfo(_ pid: pid_t) -> kinfo_proc? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else { return nil }
    return info
  }

  // KERN_PROCARGS2: argc, the exec path, NUL padding, then argv strings.
  private static func arguments(of pid: pid_t) -> [String]? {
    var argumentLimit: Int32 = 0
    var limitSize = MemoryLayout<Int32>.size
    var limitMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    guard sysctl(&limitMib, 2, &argumentLimit, &limitSize, nil, 0) == 0, argumentLimit > 0 else { return nil }
    var buffer = [UInt8](repeating: 0, count: Int(argumentLimit))
    var size = buffer.count
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
    let count = buffer.withUnsafeBytes { Int($0.load(as: Int32.self)) }
    var index = MemoryLayout<Int32>.size
    while index < size && buffer[index] != 0 { index += 1 }
    while index < size && buffer[index] == 0 { index += 1 }
    var arguments: [String] = []
    while arguments.count < count && index < size {
      let start = index
      while index < size && buffer[index] != 0 { index += 1 }
      arguments.append(String(decoding: buffer[start..<index], as: UTF8.self))
      index += 1
    }
    return arguments.count == count ? arguments : nil
  }

  private static func canonicalPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return (path as NSString).standardizingPath }
    defer { free(resolved) }
    return String(cString: resolved)
  }
}
