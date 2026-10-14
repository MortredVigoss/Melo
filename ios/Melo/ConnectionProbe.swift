import Foundation
import CryptoKit

// The result only describes the exact endpoint/model/credential tested.
// Persisted next to its connection in Keychain, never in a sync snapshot.
struct ConnectionProbe: Codable, Equatable {
    var signature: String
    var requestedModel: String
    var returnedModel: String?
    var response: String
    var elapsedMS: Int
    var testedAt: String

    static func signature(endpoint: String, model: String, apiProtocol: String, key: String) -> String {
        let data = try! JSONEncoder().encode([endpoint, model, apiProtocol, key])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    func matches(endpoint: String, model: String, apiProtocol: String, key: String) -> Bool {
        signature == Self.signature(endpoint: endpoint, model: model, apiProtocol: apiProtocol, key: key)
    }
}
