import Foundation
@main struct SyncContractTests {
    static func expand(_ value: SyncValue) -> SyncValue {
        if case .number(let count) = value["$repeat"]["count"] { return .string(String(repeating: value["$repeat"]["text"].string, count: Int(count))) }
        switch value {
        case .array(let values): return .array(values.map(expand))
        case .object(let values): return .object(values.mapValues(expand))
        default: return value
        }
    }
    static func main() throws {
        let fixtures = try JSONDecoder().decode([SyncValue].self, from: Data(contentsOf: URL(fileURLWithPath:"shared/protocol/fixtures.json")))
        for fixture in fixtures {
            let input = expand(fixture["input"]), definition = fixture["definition"].string
            var accepted = true
            do {
                try SyncWireContract.validate(input, definition: definition)
                switch definition {
                case "workspace": _ = try input.decoded(SyncWorkspace.self).validated()
                case "snapshot": _ = try input.decoded(SyncSnapshot.self).validated()
                case "taskSync":
                    if input["tasks"] != .null { _ = try mergeTaskCheckpoints(input["tasks"].decoded([TaskCheckpoint].self), []) }
                    if input["handoffs"] != .null { _ = try mergeHandoffs(input["handoffs"].decoded([TaskHandoff].self), []) }
                default: break
                }
            } catch { accepted = false }
            precondition(accepted == fixture["valid"].bool, fixture["name"].string)
        }
        print("Shared protocol fixtures: \(fixtures.count) passed in Swift")
    }
}
