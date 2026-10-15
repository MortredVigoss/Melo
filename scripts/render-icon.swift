import Foundation

// Retain the original command; both platforms now share the approved master.
let renderer = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("render-app-icons.mjs")
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
process.arguments = ["node", renderer.path, "--target", "macos"]
try process.run()
process.waitUntilExit()
exit(process.terminationStatus)
