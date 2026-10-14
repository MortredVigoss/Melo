import Foundation
import Network

// Only binds loopback, never the Wi-Fi interface. The browser remains in the app's auth sheet.
@MainActor final class OAuthLoopback {
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var ready: CheckedContinuation<URL, Error>?
    private var receiveCallback: ((URL) -> Void)?
    private var port: UInt16 = 0
    func start(callback: @escaping (URL) -> Void) async throws -> URL {
        receiveCallback = callback
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        return try await withCheckedThrowingContinuation { continuation in
            ready = continuation
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        guard let number = listener.port?.rawValue else { self.stop(); return }
                        self.port = number
                        let waiting = self.ready; self.ready = nil
                        waiting?.resume(returning: URL(string: "http://127.0.0.1:\(number)/auth/callback")!)
                    case .failed:
                        self.stop()
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in
                    guard let self, self.listener != nil, self.connections.count < 8 else { connection.cancel(); return }
                    self.connections[ObjectIdentifier(connection)] = connection
                    connection.start(queue: .main)
                    self.read(connection, accumulated: Data())
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(for: .seconds(10))
                        self?.close(connection)
                    }
                }
            }
            listener.start(queue: .main)
        }
    }
    private func close(_ connection: NWConnection) {
        connection.cancel(); connections.removeValue(forKey: ObjectIdentifier(connection))
    }
    private func read(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] bytes, _, done, failure in
            Task { @MainActor in
                guard let self, self.listener != nil else { connection.cancel(); return }
                let data = accumulated + (bytes ?? Data())
                guard data.count <= 16384, failure == nil else { self.close(connection); return }
                guard let request = String(data: data, encoding: .utf8), request.contains("\r\n\r\n") else {
                    if done { self.close(connection) } else { self.read(connection, accumulated: data) }; return
                }
                let parts = request.components(separatedBy: "\r\n")[0].split(separator: " ")
                let target = parts.count == 3 && parts[0] == "GET" ? String(parts[1]) : ""
                guard target.hasPrefix("/auth/callback?"), let url = URL(string: "http://127.0.0.1:\(self.port)" + target) else { self.close(connection); return }
                let body = "<!doctype html><meta name='referrer' content='no-referrer'><title>Melo</title><p>Return to Melo to finish signing in.</p>"
                let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
                    Task { @MainActor in
                        guard let self else { return }
                        self.close(connection)
                        self.receiveCallback?(url)
                    }
                })
            }
        }
    }
    func stop() {
        listener?.cancel(); listener = nil; receiveCallback = nil
        for connection in connections.values { connection.cancel() }; connections.removeAll()
        let waiting = ready; ready = nil
        waiting?.resume(throwing: MeloError.message("无法启动本机登录回调，请重试。"))
    }
}
