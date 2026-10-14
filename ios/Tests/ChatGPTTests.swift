import Foundation
import Security
import CryptoKit

@main struct ChatGPTTests {
    static func rejects(_ name: String, _ action: () throws -> Void) {
        do { try action(); fatalError("Accepted invalid \(name)") } catch {}
    }
    static func main() throws {
        let redirect = URL(string: "http://127.0.0.1:2345/auth/callback")!
        let callback = URL(string: redirect.absoluteString + "?state=correct&code=one-use&client_id=oaiapp_example")!
        let valid = try ChatGPTProtocol.callback(callback, redirect: redirect, state: "correct", clientID: nil)
        assert(valid.clientID == "oaiapp_example")
        rejects("state") { _ = try ChatGPTProtocol.callback(callback, redirect: redirect, state: "wrong", clientID: nil) }
        rejects("client mismatch") { _ = try ChatGPTProtocol.callback(callback, redirect: redirect, state: "correct", clientID: "oaiapp_other") }
        rejects("duplicate params") { _ = try ChatGPTProtocol.callback(URL(string: callback.absoluteString + "&state=correct")!, redirect: redirect, state: "correct", clientID: nil) }
        rejects("callback host") { _ = try ChatGPTProtocol.callback(URL(string: callback.absoluteString.replacingOccurrences(of: "127.0.0.1", with: "localhost"))!, redirect: redirect, state: "correct", clientID: nil) }
        rejects("denied consent") { _ = try ChatGPTProtocol.callback(URL(string: redirect.absoluteString + "?state=correct&error=access_denied")!, redirect: redirect, state: "correct", clientID: nil) }
        assert(String(decoding: ChatGPTProtocol.form(["value": "a+b &?=汉字"]), as: UTF8.self) == "value=a%2Bb%20%26%3F%3D%E6%B1%89%E5%AD%97")
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        assert(ChatGPTProtocol.base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let privateKey = SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048] as CFDictionary, nil)!
        let publicKey = SecKeyCopyPublicKey(privateKey)!
        let der = SecKeyCopyExternalRepresentation(publicKey, nil)! as Data
        var pos = 0
        func read() -> Data {
            pos += 1
            var count = Int(der[pos]); pos += 1
            if count & 128 != 0 { let bytes = count & 127; count = 0; for _ in 0..<bytes { count = count * 256 + Int(der[pos]); pos += 1 } }
            let result = der.subdata(in: pos..<pos+count); pos += count; return result
        }
        let sequence = read()
        var at = 0
        func integer() -> Data {
            at += 1; var size = Int(sequence[at]); at += 1
            if size & 128 != 0 { let n = size & 127; size = 0; for _ in 0..<n { size = size * 256 + Int(sequence[at]); at += 1 } }
            var result = sequence.subdata(in: at..<at+size); at += size
            while result.first == 0 { result.removeFirst() }; return result
        }
        let n = integer(), e = integer()
        let jwks = try JSONSerialization.data(withJSONObject: ["keys": [["kid": "test", "kty": "RSA", "alg": "RS256", "n": ChatGPTProtocol.base64URL(n), "e": ChatGPTProtocol.base64URL(e)]]])
        let now = Date()
        let claims: [String: Any] = ["iss": ChatGPTProtocol.issuer, "aud": "client", "sub": "subject", "email": "test@example.invalid", "exp": now.timeIntervalSince1970 + 120, "nonce": "nonce"]
        func jwt(_ payload: [String: Any]) throws -> String {
            let header = ChatGPTProtocol.base64URL(try JSONSerialization.data(withJSONObject: ["kid": "test", "alg": "RS256"]))
            let body = ChatGPTProtocol.base64URL(try JSONSerialization.data(withJSONObject: payload))
            let input = header + "." + body
            let signature = SecKeyCreateSignature(privateKey, .rsaSignatureMessagePKCS1v15SHA256, Data(input.utf8) as CFData, nil)! as Data
            return input + "." + ChatGPTProtocol.base64URL(signature)
        }
        let token = try jwt(claims)
        let identity = try ChatGPTProtocol.validateIDToken(token, jwks: jwks, clientID: "client", nonce: "nonce", now: now)
        assert(identity.subject == "subject")
        rejects("nonce") { _ = try ChatGPTProtocol.validateIDToken(token, jwks: jwks, clientID: "client", nonce: "wrong") }
        rejects("audience") { _ = try ChatGPTProtocol.validateIDToken(token, jwks: jwks, clientID: "wrong", nonce: "nonce") }
        rejects("expiry") { _ = try ChatGPTProtocol.validateIDToken(token, jwks: jwks, clientID: "client", nonce: "nonce", now: now.addingTimeInterval(1000)) }
        var wrong = claims; wrong["iss"] = "https://example.invalid"
        rejects("issuer") { _ = try ChatGPTProtocol.validateIDToken(jwt(wrong), jwks: jwks, clientID: "client", nonce: "nonce") }
        let pieces = token.split(separator: ".").map(String.init)
        let altered = pieces[0] + "." + ChatGPTProtocol.base64URL(try JSONSerialization.data(withJSONObject: wrong)) + "." + pieces[2]
        rejects("tampered JWT") { _ = try ChatGPTProtocol.validateIDToken(altered, jwks: jwks, clientID: "client", nonce: "nonce") }
        var stream = ChatGPTStream()
        try stream.accept("{\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}")
        rejects("truncated stream") { _ = try stream.result() }
        try stream.accept("{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}")
        let answer = try stream.result(); assert(answer == "你好")
        rejects("late failure") { try stream.accept("{\"type\":\"response.failed\"}") }
        var incomplete = ChatGPTStream()
        rejects("incomplete") { try incomplete.accept("{\"type\":\"response.incomplete\"}") }
        for ending in ["\n", "\r\n", "\r"] {
            let fixture = [": keepalive", "", "event: response.output_text.delta", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好 🌌\"}", "", "data: {\"type\":\"response.completed\",", "data: \"response\":{\"status\":\"completed\"}}", "", ""].joined(separator: ending)
            var parser = ChatGPTSSE()
            for byte in fixture.utf8 { try parser.accept(byte) }
            let decoded = try parser.finish(); assert(decoded == "你好 🌌")
        }
        var truncated = ChatGPTSSE()
        for byte in "data: {\"type\":\"response.completed\"}".utf8 { try truncated.accept(byte) }
        rejects("missing SSE delimiter") { _ = try truncated.finish() }
        print("ChatGPT protocol tests passed: PKCE, callback/state/client validation, signed JWT verification, stream completion and failures")
    }
}
