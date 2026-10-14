import Foundation

enum DraftMerge {
    static func rebase<Value: Codable>(_ draft: Value, original: Value, current: Value) throws -> Value {
        func json(_ value: Value) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: .fragmentsAllowed) }
        func equal(_ a: Any?, _ b: Any?) -> Bool {
            guard let a, let b else { return a == nil && b == nil }
            return (a as AnyObject).isEqual(b)
        }
        func merge(_ draft: Any?, _ base: Any?, _ current: Any?) -> Any? {
            if equal(draft, base) { return current }
            if let d = draft as? [String: Any], let b = base as? [String: Any], let c = current as? [String: Any] {
                var result: [String: Any] = [:]
                for key in Set(d.keys).union(b.keys).union(c.keys) { result[key] = merge(d[key], b[key], c[key]) }
                return result
            }
            return draft
        }
        let result = merge(try json(draft), try json(original), try json(current)) ?? NSNull()
        return try JSONDecoder().decode(Value.self, from: JSONSerialization.data(withJSONObject: result, options: .fragmentsAllowed))
    }
}
