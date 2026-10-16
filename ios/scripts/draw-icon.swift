import Foundation

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: swift ios/scripts/draw-icon.swift <icon-output-directory>\n", stderr)
  exit(1)
}
// Resolve the shared exporter independently of the caller's working directory.
let projectRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent()
let renderer = projectRoot.appendingPathComponent("scripts/render-app-icons.mjs")
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
process.arguments = ["node", renderer.path, "--target", "ios", "--ios-output", CommandLine.arguments[1]]
try process.run()
process.waitUntilExit()
exit(process.terminationStatus)
