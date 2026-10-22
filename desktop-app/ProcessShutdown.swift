import Foundation
import Darwin
import CoreFoundation

// Hold the application open until its own child releases the home lock. Never
// signal a PID found by name, or wait indefinitely for a stuck child.
enum ProcessShutdown {
  // AppKit's termination and modal panels run the main loop outside default mode.
  private static let mainLoopModes: [RunLoop.Mode] = [.default, .common, RunLoop.Mode("NSModalPanelRunLoopMode")]

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
      RunLoop.main.perform(inModes: mainLoopModes, block: completion)
      CFRunLoopWakeUp(CFRunLoopGetMain())
    }
  }

  // `kill`/`pkill` bypass AppKit's quit path, so the default action would end
  // this process and orphan its children. Keep the returned sources alive for
  // as long as the handler should stay installed.
  static func onTerminationSignals(_ signals: [Int32] = [SIGTERM, SIGINT, SIGHUP], handler: @escaping (Int32) -> Void) -> [DispatchSourceSignal] {
    signals.map { number in
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
      source.setEventHandler {
        RunLoop.main.perform(inModes: mainLoopModes) { handler(number) }
        CFRunLoopWakeUp(CFRunLoopGetMain())
      }
      source.resume()
      return source
    }
  }

  // Finish with the signal's default action so the sender sees how this ended.
  static func exit(after number: Int32) -> Never {
    signal(number, SIG_DFL)
    raise(number)
    Darwin.exit(128 + number)
  }
}
