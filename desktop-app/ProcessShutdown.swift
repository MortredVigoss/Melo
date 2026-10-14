import Foundation
import Darwin
import CoreFoundation

// Hold the application open until its own child releases the home lock. Never
// signal a PID found by name, or wait indefinitely for a stuck child.
enum ProcessShutdown {
  static func stop(_ process: Process?, timeout: TimeInterval = 6, completion: @escaping () -> Void) {
    guard let process = process, process.isRunning else { completion(); return }
    process.terminate()
    let deadline = Date().addingTimeInterval(timeout)
    // AppKit enters a termination run-loop mode after .terminateLater. A
    // default-mode Timer would never fire there, leaving an empty app alive.
    DispatchQueue.global(qos: .utility).async {
      while process.isRunning {
        if Date() >= deadline {
          // The retained Process still owns this running child; its PID cannot
          // have been recycled while it is waiting to be reaped.
          kill(process.processIdentifier, SIGKILL)
        }
        Thread.sleep(forTimeInterval: 0.05)
      }
      // A quit started in a main-queue block is non-reentrant for GCD too.
      // Schedule directly on the run loop, including AppKit's modal mode.
      RunLoop.main.perform(inModes: [.default, .common, RunLoop.Mode("NSModalPanelRunLoopMode")], block: completion)
      CFRunLoopWakeUp(CFRunLoopGetMain())
    }
  }
}
