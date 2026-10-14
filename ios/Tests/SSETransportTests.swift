import Foundation

final class SSEMock: URLProtocol {
    static let payload = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好 🌌\"}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n"
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        // Fragment across UTF-8 codepoints, JSON and CR/LF boundaries.
        for byte in Self.payload.utf8 { client?.urlProtocol(self, didLoad: Data([byte])) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main struct SSETransportTests {
    static func main() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SSEMock.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let url = URL(string: "https://example.invalid/stream")!
        let (oldBytes, _) = try await session.bytes(from: url)
        var oldFrames = [String](), blankLines = 0
        for try await line in oldBytes.lines { if line.isEmpty { blankLines += 1 }; if line.hasPrefix("data:") { oldFrames.append(String(line.dropFirst(5))) } }
        assert(blankLines == 0, "Reproduction assumption changed")
        do { _ = try JSONSerialization.jsonObject(with: Data(oldFrames.joined(separator: "\n").utf8)); fatalError("Old parser unexpectedly accepted concatenated JSON") } catch {}
        let (bytes, _) = try await session.bytes(from: url)
        var parser = ChatGPTSSE()
        for try await byte in bytes { try parser.accept(byte) }
        let reply = try parser.finish(); assert(reply == "你好 🌌")
        print("SSE transport regression passed: original AsyncBytes.lines failure reproduced; fragmented UTF-8 stream decoded to completed reply")
    }
}
