import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('native exit waits for its child and bounds an unresponsive shutdown', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'melo-native-shutdown-'));
  try {
    const entry = join(directory, 'main.swift');
    await writeFile(entry, `
import Foundation
import Darwin
let node = CommandLine.arguments[1]
func check(_ source: String, timeout: Double, expected: Int32, minimum: Double) {
  let child = Process()
  child.executableURL = URL(fileURLWithPath: node)
  child.arguments = ["-e", source]
  let output = Pipe()
  child.standardOutput = output
  try! child.run()
  _ = output.fileHandleForReading.availableData
  var finished = false
  let start = Date()
  ProcessShutdown.stop(child, timeout: timeout) { finished = true }
  precondition(!finished, "returned before child exit")
  while !finished && Date().timeIntervalSince(start) < 5 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
  }
  precondition(finished && !child.isRunning, "child remains alive")
  precondition(Date().timeIntervalSince(start) >= minimum, "did not wait for graceful exit")
  precondition(child.terminationStatus == expected, "wrong termination result")
}
check("process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150)); console.log('ready'); setInterval(()=>{},1000)", timeout: 2, expected: 0, minimum: 0.15)
check("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)", timeout: 0.2, expected: SIGKILL, minimum: 0.2)
var noChildFinished = false
ProcessShutdown.stop(nil) { noChildFinished = true }
precondition(noChildFinished)
print("native shutdown passed")
`);
    const binary = join(directory, 'shutdown-test');
    execFileSync('xcrun', ['swiftc', 'desktop-app/ProcessShutdown.swift', entry, '-o', binary], { timeout: 20000 });
    assert.match(execFileSync(binary, [process.execPath], { encoding: 'utf8', timeout: 8000 }), /native shutdown passed/);
    // Unlike a normal RunLoop, AppKit's .terminateLater suspends default-mode
    // timers. Exercise the actual termination mode so a Timer-based waiter
    // cannot pass the fixture while hanging the installed application.
    await writeFile(entry, `
import AppKit
final class ShutdownDelegate: NSObject, NSApplicationDelegate {
  let child = Process()
  func applicationDidFinishLaunching(_ notification: Notification) {
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
    child.arguments = ["-e", "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150)); console.log('ready'); setInterval(()=>{},1000)"]
    let output = Pipe()
    child.standardOutput = output
    try! child.run()
    _ = output.fileHandleForReading.availableData
    DispatchQueue.main.async { NSApp.terminate(nil) }
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    ProcessShutdown.stop(child) { sender.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }
  func applicationWillTerminate(_ notification: Notification) {
    precondition(!child.isRunning)
    print("AppKit termination passed")
  }
}
let app = NSApplication.shared
let delegate = ShutdownDelegate()
app.setActivationPolicy(.prohibited)
app.delegate = delegate
app.run()
`);
    execFileSync('xcrun', ['swiftc', '-framework', 'AppKit', 'desktop-app/ProcessShutdown.swift', entry, '-o', binary], { timeout: 20000 });
    assert.match(execFileSync(binary, [process.execPath], { encoding: 'utf8', timeout: 8000 }), /AppKit termination passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
