import Foundation
import CryptoKit

indirect enum SyncValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), array([SyncValue]), object([String: SyncValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([SyncValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: SyncValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    static func from(_ value: Any) throws -> SyncValue { try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])) }
    var canonical: String { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return (try? String(decoding: e.encode(self), as: UTF8.self)) ?? "" }
    var string: String { if case .string(let v) = self { return v }; return "" }
    var bool: Bool { if case .bool(let v) = self { return v }; return false }
    var array: [SyncValue] { if case .array(let v) = self { return v }; return [] }
    var object: [String: SyncValue] { if case .object(let v) = self { return v }; return [:] }
    subscript(_ key: String) -> SyncValue { object[key] ?? .null }
    var preview: String {
        let fields = [("text","记忆"),("scope","范围"),("status","状态"),("name","名称"),("title","标题"),("subtitle","一句话描述"),("content","内容"),("instructions","回复要求 / 项目指引"),("goal","目标"),("identity","身份"),("soul","回复风格"),("systemPrompt","补充要求"),("model","模型"),("agentId","Agent"),("projectId","项目")]
        var lines = fields.compactMap { key, label in self[key].string.isEmpty ? nil : label + "：" + self[key].string }
        if object["deleted"] != nil { lines.append("资料状态：" + (self["deleted"].bool ? "已删除" : "可选用")) }
        if object["archived"] != nil { lines.append("项目状态：" + (self["archived"].bool ? "已归档" : "进行中")) }
        if !self["knowledgeIds"].array.isEmpty { lines.append("选用资料：" + self["knowledgeIds"].array.map(\.string).joined(separator: "、")) }
        if !self["model"].object.isEmpty { lines.append("连接：" + self["model"]["name"].string + "\n模型：" + self["model"]["model"].string) }
        if !self["symbol"].string.isEmpty { lines.append("图标：" + self["symbol"].string) }
        for (id, agent) in self["agentOverrides"].object.sorted(by: { $0.key < $1.key }) { lines.append("项目Agent · " + id + "\n" + agent.preview) }
        for model in self["models"].array { lines.append("请求模型：" + model["requestedModel"].string + "\n服务返回：" + model["reportedModel"].string) }
        for source in self["scene"]["sources"].array { lines.append(source["title"].string + " · " + source["url"].string) }
        for stage in self["scene"]["operations"].array + self["scene"]["pipeline"].array { lines.append(stage["name"].string + " · " + stage["status"].string + "\n" + stage["input"].string + "\n" + stage["output"].string) }
        return lines.isEmpty ? "没有附加内容" : lines.joined(separator: "\n\n")
    }
    func decoded<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
}
struct SyncVersion: Codable, Equatable { var clock: [String: Int]; var value: SyncValue }
struct SyncRegister: Codable, Equatable, Identifiable {
    var kind: String
    var id: String
    var versions: [SyncVersion]
    var key: String { kind + ":" + id }
    var label: String { let value = versions.first?.value ?? .null; return value["name"].string.isEmpty ? value["title"].string.isEmpty ? id : value["title"].string : value["name"].string }
}
struct SyncWorkspace: Codable, Equatable {
    var version = 1
    var records: [SyncRegister] = []
    var conflicts: [SyncRegister] { records.filter { $0.versions.count > 1 } }
    static func validID(_ value: String) -> Bool { (try? SyncWireContract.validate(.string(value), definition: "id")) != nil }
    func excluding(_ deletions: [DeletedChat]) -> SyncWorkspace {
        let deleted = Set(deletions.map(\.id))
        return .init(records: records.filter { row in
            !(row.kind == "conversation" && deleted.contains(row.id)) &&
            !(["message", "memory"].contains(row.kind) && row.versions.contains { deleted.contains($0.value["chatId"].string) })
        })
    }
    func validated() throws -> SyncWorkspace {
        try SyncWireContract.validate(JSONDecoder().decode(SyncValue.self, from: JSONEncoder().encode(self)))
        guard version == 1 else { throw MeloError.message("上下文同步版本不兼容，原数据已保留。") }
        var keys = Set<String>()
        for row in records {
            guard ["agent", "project", "knowledge", "conversation", "message", "memory"].contains(row.kind), (Self.validID(row.id) || (row.kind == "message" && row.id.range(of: "^reminder:[A-Za-z0-9_-]{1,171}$", options: .regularExpression) != nil)), keys.insert(row.key).inserted,
                  (1...20).contains(row.versions.count) else { throw MeloError.message("上下文同步记录格式无效。") }
            for value in row.versions {
                guard !value.clock.isEmpty, value.clock.count <= 100, value.clock.allSatisfy({ Self.validID($0.key) && $0.value > 0 && $0.value <= 9_007_199_254_740_991 }), !value.value.object.isEmpty else { throw MeloError.message("上下文同步修订格式无效。") }
                if row.kind == "memory" {
                    let fact = try value.value.decoded(MobileMemoryFact.self).validated()
                    guard fact.id == row.id else { throw MeloError.message("记忆标识不匹配。") }
                }
                try Self.validateLinks(value.value, kind: row.kind)
            }
        }
        return try ProjectDeletion.project(self)
    }
    private static func validateLinks(_ value: SyncValue, kind: String) throws {
        func url(_ text: String, endpoint: Bool = false) throws {
            guard text.isEmpty || (text.utf16.count <= 4000 && URLComponents(string: text).map { c in
                ["http", "https"].contains(c.scheme?.lowercased() ?? "") && c.host?.isEmpty == false && c.user == nil && c.password == nil && (!endpoint || (c.query == nil && c.fragment == nil))
            } == true) else { throw MeloError.message("同步数据包含无效网页或模型地址，原数据已保留。") }
        }
        if kind == "conversation", value["model"] != .null { try url(value["model"]["baseURL"].string, endpoint: true) }
        if kind == "message", value["scene"] != .null {
            let scene = value["scene"]
            guard validID(scene["runId"].string), ["completed", "failed", "cancelled", "interrupted"].contains(scene["status"].string), scene["sources"].array.count <= 2000, scene["operations"].array.count <= 500, scene["pipeline"].array.count <= 500 else { throw MeloError.message("同步执行记录格式无效。") }
            for source in scene["sources"].array { try url(source["url"].string) }
        }
    }
    static func joined(_ versions: [SyncVersion]) -> [String: Int] {
        var result: [String: Int] = [:]
        for v in versions { for (device, n) in v.clock { result[device] = max(result[device, default: 0], n) } }
        return result
    }
    static func dominates(_ a: [String: Int], _ b: [String: Int]) -> Bool { b.allSatisfy { a[$0.key, default: 0] >= $0.value } }
    static func coalesced(_ versions: [SyncVersion]) -> [SyncVersion] {
        var equal: [String: SyncVersion] = [:]
        for v in versions {
            if let old = equal[v.value.canonical] { equal[v.value.canonical] = .init(clock: joined([old, v]), value: v.value) }
            else { equal[v.value.canonical] = v }
        }
        let rows = Array(equal.values)
        return rows.filter { v in !rows.contains { other in other.value != v.value && dominates(other.clock, v.clock) && !dominates(v.clock, other.clock) } }.sorted { $0.value.canonical < $1.value.canonical }
    }
    func merging(_ remote: SyncWorkspace) throws -> SyncWorkspace {
        let local = try validated(), remote = try remote.validated()
        var rows: [String: SyncRegister] = [:]
        for row in local.records + remote.records {
            var merged = row
            merged.versions = Self.coalesced((rows[row.key]?.versions ?? []) + row.versions)
            rows[row.key] = merged
        }
        return try SyncWorkspace(records: rows.values.sorted { $0.key < $1.key }).validated()
    }
    mutating func put(kind: String, id: String, value: SyncValue, device: String) {
        if let index = records.firstIndex(where: { $0.kind == kind && $0.id == id }) {
            guard records[index].versions.count == 1, records[index].versions[0].value != value else { return }
            var clock = records[index].versions[0].clock; clock[device, default: 0] += 1
            records[index].versions = [.init(clock: clock, value: value)]
        } else { records.append(.init(kind: kind, id: id, versions: [.init(clock: [device: 1], value: value)])) }
    }
    mutating func resolve(key: String, choice: Int, device: String) throws {
        guard let index = records.firstIndex(where: { $0.key == key }), records[index].versions.indices.contains(choice) else { throw MeloError.message("冲突已变化，请重新打开。") }
        let value = records[index].versions[choice].value
        var clock = Self.joined(records[index].versions); clock[device, default: 0] += 1
        records[index].versions = [.init(clock: clock, value: value)]
    }
}

// An immutable v1 knowledge envelope carries remove-wins project tombstones.
// Paths, permissions, images and executable content never enter this envelope.
enum ProjectDeletion {
    private static func validDate(_ at: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: at) != nil { return true }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: at) != nil
    }
    static func id(_ project: String) -> String {
        "pld_" + SHA256.hash(data: Data(project.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func value(project: String, operation: String, at: String) throws -> SyncValue {
        guard SyncWorkspace.validID(project), SyncWorkspace.validID(operation), validDate(at) else { throw MeloError.message("项目删除记录无效。") }
        let content = try SyncValue.from(["version":1,"projectId":project,"operationId":operation,"deletedAt":at]).canonical
        return try .from(["title":"Deleted project","kind":"project-lifecycle-v1","language":"json","projectId":NSNull(),"deleted":true,"content":content])
    }
    static func markers(_ workspace: SyncWorkspace) throws -> [String: SyncValue] {
        var result: [String: SyncValue] = [:]
        for row in workspace.records where row.kind == "knowledge" && row.id.hasPrefix("pld_") {
            for version in row.versions {
                let v = version.value
                guard v["kind"].string == "project-lifecycle-v1", v["deleted"].bool, v["projectId"] == .null, v["content"].string.utf16.count <= 2000 else { throw MeloError.message("项目删除记录不可修改。") }
                let marker = try JSONDecoder().decode(SyncValue.self, from: Data(v["content"].string.utf8))
                guard marker["version"] == .number(1), Set(marker.object.keys) == Set(["version","projectId","operationId","deletedAt"]), row.id == id(marker["projectId"].string) else { throw MeloError.message("项目删除记录身份不匹配。") }
                _ = try value(project:marker["projectId"].string,operation:marker["operationId"].string,at:marker["deletedAt"].string)
                let project = marker["projectId"].string
                if result[project] == nil || marker["deletedAt"].string < result[project]!["deletedAt"].string { result[project] = marker }
            }
        }
        return result
    }
    static func project(_ workspace: SyncWorkspace) throws -> SyncWorkspace {
        let removed = try markers(workspace)
        guard !removed.isEmpty else { return workspace }
        return SyncWorkspace(records: workspace.records.filter { $0.kind != "project" || removed[$0.id] == nil }.map { row in
            var row = row
            if ["conversation","knowledge","memory"].contains(row.kind) {
                row.versions = SyncWorkspace.coalesced(row.versions.map { version in
                    guard removed[version.value["projectId"].string] != nil else { return version }
                    var version = version, fields = version.value.object
                    if row.kind == "memory" {
                        if version.value["scope"].string == "project" && version.value["status"].string == "active" { fields["status"] = .string("historical") }
                    } else { fields["projectId"] = .null }
                    version.value = .object(fields); return version
                })
            }
            return row
        })
    }
}

// BEGIN GENERATED SYNC CONTRACT
// Source: shared/protocol/sync.schema.json
enum SyncWireContract {
    static let schema: SyncValue = try! JSONDecoder().decode(SyncValue.self, from: Data(##"{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://melo.local/sync/workspace-v1.schema.json","title":"Melo portable workspace v1","description":"Shared wire shape and UTF-16 field budgets. Causal merge, dates, URL security and memory policy remain semantic checks in both runtimes.","$ref":"#/$defs/workspace","$defs":{"id":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,180}$(?![\\s\\S])","not":{"enum":["__proto__","prototype","constructor"]}},"messageId":{"anyOf":[{"$ref":"#/$defs/id"},{"type":"string","pattern":"^reminder:[A-Za-z0-9_-]{1,171}$(?![\\s\\S])"}]},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"clock":{"type":"object","minProperties":1,"maxProperties":100,"propertyNames":{"$ref":"#/$defs/id"},"additionalProperties":{"$ref":"#/$defs/revision"}},"ids":{"type":["array","null"],"items":{"$ref":"#/$defs/id"},"maxItems":1000},"agent":{"type":"object","properties":{"name":{"type":["string","null"],"x-maxUtf16Length":200},"subtitle":{"type":["string","null"],"x-maxUtf16Length":12000},"instructions":{"type":["string","null"],"x-maxUtf16Length":50000},"symbol":{"type":["string","null"],"x-maxUtf16Length":100},"identity":{"type":["string","null"],"x-maxUtf16Length":50000},"soul":{"type":["string","null"],"x-maxUtf16Length":50000},"systemPrompt":{"type":["string","null"],"x-maxUtf16Length":50000},"mood":{"type":["string","null"],"x-maxUtf16Length":100},"model":{"type":["string","null"],"x-maxUtf16Length":180},"avatarData":{"type":["string","null"],"pattern":"^(?:[A-Za-z0-9+/]+={0,2})?$","x-maxUtf16Length":500000}}},"model":{"type":["object","null"],"properties":{"connectionID":{"type":["string","null"],"x-maxUtf16Length":180},"name":{"type":["string","null"],"x-maxUtf16Length":200},"model":{"type":["string","null"],"x-maxUtf16Length":180},"baseURL":{"type":["string","null"],"x-maxUtf16Length":4000},"authMode":{"type":["string","null"],"x-maxUtf16Length":100},"apiProtocol":{"type":["string","null"],"x-maxUtf16Length":100},"mode":{"type":["string","null"],"enum":["fixed","smart",null]}}},"conversation":{"type":"object","properties":{"agentId":{"type":["string","null"],"x-maxUtf16Length":180},"projectId":{"type":["string","null"],"x-maxUtf16Length":180},"knowledgeIds":{"$ref":"#/$defs/ids"},"model":{"$ref":"#/$defs/model"},"compact":{"$ref":"#/$defs/compact"}}},"compactCard":{"type":"object","properties":{"id":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":200},"title":{"type":"string","x-maxUtf16Length":200},"summary":{"type":"string","x-maxUtf16Length":2048},"fromMessageId":{"type":"string","x-maxUtf16Length":180},"toMessageId":{"type":"string","x-maxUtf16Length":180},"messageCount":{"type":"integer","minimum":0,"maximum":9007199254740991},"at":{"$ref":"#/$defs/date"},"source":{"enum":["cloud","local","rule"]}},"required":["id","summary","source"]},"compact":{"type":["object","null"],"properties":{"boundaryMessageId":{"$ref":"#/$defs/messageId"},"compactedCount":{"type":"integer","minimum":1,"maximum":9007199254740991},"source":{"enum":["cloud","local","rule"]},"at":{"$ref":"#/$defs/date"},"summary":{"type":"string","x-maxUtf16Length":8192},"cards":{"type":"array","maxItems":200,"items":{"$ref":"#/$defs/compactCard"}}},"required":["boundaryMessageId","compactedCount","source","at","summary"]},"project":{"type":"object","properties":{"name":{"type":["string","null"],"x-maxUtf16Length":200},"goal":{"type":["string","null"],"x-maxUtf16Length":12000},"instructions":{"type":["string","null"],"x-maxUtf16Length":12000},"archived":{"type":"boolean"},"knowledgeIds":{"$ref":"#/$defs/ids"},"agentOverrides":{"type":"object","propertyNames":{"$ref":"#/$defs/id"},"additionalProperties":{"$ref":"#/$defs/agent"}}}},"knowledge":{"type":"object","properties":{"title":{"type":["string","null"],"x-maxUtf16Length":500},"content":{"type":["string","null"],"x-maxUtf16Length":200000},"kind":{"type":["string","null"],"x-maxUtf16Length":100},"language":{"type":["string","null"],"x-maxUtf16Length":100},"projectId":{"type":["string","null"],"x-maxUtf16Length":180},"deleted":{"type":"boolean"}}},"stage":{"type":"object","properties":{"id":{"type":["string","null"],"x-maxUtf16Length":200},"module":{"type":["string","null"],"x-maxUtf16Length":100},"name":{"type":["string","null"],"x-maxUtf16Length":200},"status":{"type":["string","null"],"x-maxUtf16Length":100},"provider":{"type":["string","null"],"x-maxUtf16Length":200},"input":{"type":["string","null"],"x-maxUtf16Length":2200},"output":{"type":["string","null"],"x-maxUtf16Length":12000},"query":{"type":["string","null"],"x-maxUtf16Length":2200},"resultSummary":{"type":["string","null"],"x-maxUtf16Length":2200},"model":{"type":["string","null"],"x-maxUtf16Length":180},"returnedModel":{"type":["string","null"],"x-maxUtf16Length":180},"channel":{"type":["string","null"],"x-maxUtf16Length":100},"startedAt":{"type":["string","null"],"x-maxUtf16Length":50},"finishedAt":{"type":["string","null"],"x-maxUtf16Length":50}}},"source":{"type":"object","properties":{"id":{"type":["string","null"],"x-maxUtf16Length":200},"url":{"type":["string","null"],"x-maxUtf16Length":4000},"title":{"type":["string","null"],"x-maxUtf16Length":1000},"providers":{"type":"array","items":{"type":["string","null"],"x-maxUtf16Length":200},"maxItems":30},"queries":{"type":"array","items":{"type":["string","null"],"x-maxUtf16Length":2200},"maxItems":100}}},"scene":{"type":["object","null"],"properties":{"runId":{"$ref":"#/$defs/id"},"status":{"enum":["completed","failed","cancelled","interrupted"]},"operations":{"type":"array","items":{"$ref":"#/$defs/stage"},"maxItems":500},"pipeline":{"type":"array","items":{"$ref":"#/$defs/stage"},"maxItems":500},"sources":{"type":"array","items":{"$ref":"#/$defs/source"},"maxItems":2000}},"required":["runId","status"]},"message":{"type":"object","properties":{"chatId":{"$ref":"#/$defs/id"},"agent":{"type":["object","null"]},"models":{"type":"array","items":{"type":"object","properties":{"requestedModel":{"type":["string","null"],"x-maxUtf16Length":180},"reportedModel":{"type":["string","null"],"x-maxUtf16Length":180},"simulated":{"type":"boolean"},"purpose":{"type":"string","x-maxUtf16Length":100}}},"maxItems":200},"scene":{"$ref":"#/$defs/scene"}},"required":["chatId"]},"memory":{"type":"object","properties":{"id":{"$ref":"#/$defs/id"},"chatId":{"$ref":"#/$defs/id"},"agentId":{"$ref":"#/$defs/id"},"scope":{"enum":["chat","project","agent","personal"]},"status":{"enum":["active","forgotten","historical","unconfirmed"]},"text":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":2000},"memoryID":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":180},"originalFact":{"type":["string","null"],"x-maxUtf16Length":2000},"sourceText":{"type":["string","null"],"x-maxUtf16Length":1600},"category":{"type":["string","null"],"x-maxUtf16Length":100},"messageId":{"type":["string","null"],"x-maxUtf16Length":180},"projectId":{"type":["string","null"],"x-maxUtf16Length":180},"validTo":{"type":["string","null"],"x-maxUtf16Length":100},"updatedAt":{"type":"string"},"userEdited":{"type":"boolean"},"mergedInto":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":180},"section":{"enum":["goal","convention","decision","progress","todo","file"]},"bookStatus":{"enum":["auto","confirmed","user"]}},"required":["id","chatId","agentId","scope","status","text","memoryID","updatedAt"]},"version":{"type":"object","properties":{"clock":{"$ref":"#/$defs/clock"},"value":{"type":"object","minProperties":1}},"required":["clock","value"]},"record":{"type":"object","properties":{"kind":{"enum":["agent","project","knowledge","conversation","message","memory"]},"id":{"$ref":"#/$defs/messageId"},"versions":{"type":"array","items":{"$ref":"#/$defs/version"},"maxItems":20,"minItems":1}},"required":["kind","id","versions"],"allOf":[{"if":{"properties":{"kind":{"const":"agent"}}},"then":{"properties":{"id":{"$ref":"#/$defs/id"},"versions":{"items":{"properties":{"value":{"$ref":"#/$defs/agent"}}}}}}},{"if":{"properties":{"kind":{"const":"project"}}},"then":{"properties":{"id":{"$ref":"#/$defs/id"},"versions":{"items":{"properties":{"value":{"$ref":"#/$defs/project"}}}}}}},{"if":{"properties":{"kind":{"const":"knowledge"}}},"then":{"properties":{"id":{"$ref":"#/$defs/id"},"versions":{"items":{"properties":{"value":{"$ref":"#/$defs/knowledge"}}}}}}},{"if":{"properties":{"kind":{"const":"conversation"}}},"then":{"properties":{"id":{"$ref":"#/$defs/id"},"versions":{"items":{"properties":{"value":{"$ref":"#/$defs/conversation"}}}}}}},{"if":{"properties":{"kind":{"const":"message"}}},"then":{"properties":{"id":{"$ref":"#/$defs/messageId"},"versions":{"items":{"properties":{"value":{"$ref":"#/$defs/message"}}}}}}},{"if":{"properties":{"kind":{"const":"memory"}}},"then":{"properties":{"id":{"$ref":"#/$defs/id"},"versions":{"items":{"properties":{"value":{"$ref":"#/$defs/memory"}}}}}}}]},"workspace":{"type":"object","properties":{"version":{"const":1},"records":{"type":"array","items":{"$ref":"#/$defs/record"}}},"required":["version","records"]},"date":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":100},"task":{"type":"object","properties":{"id":{"$ref":"#/$defs/id"},"title":{"type":"string","x-maxUtf16Length":500},"status":{"enum":["todo","running","blocked","review","done"]},"owner":{"type":"string","x-maxUtf16Length":100},"checkpoint":{"type":"string","x-maxUtf16Length":12000},"revision":{"$ref":"#/$defs/revision"},"sourceDevice":{"$ref":"#/$defs/id"},"updatedAt":{"$ref":"#/$defs/date"},"chatId":{"anyOf":[{"$ref":"#/$defs/id"},{"type":"null"}]},"needsApproval":{"type":"boolean"}},"required":["id","title","status","checkpoint","revision","sourceDevice","updatedAt"]},"handoff":{"type":"object","properties":{"id":{"$ref":"#/$defs/id"},"taskId":{"$ref":"#/$defs/id"},"fromDevice":{"$ref":"#/$defs/id"},"requestedAt":{"$ref":"#/$defs/date"},"revision":{"$ref":"#/$defs/revision"}},"required":["id","taskId","fromDevice","requestedAt","revision"]},"taskSync":{"type":"object","properties":{"tasks":{"type":"array","maxItems":500,"items":{"$ref":"#/$defs/task"}},"handoffs":{"type":"array","maxItems":1000,"items":{"$ref":"#/$defs/handoff"}}},"required":[]},"textMessage":{"type":"object","properties":{"id":{"$ref":"#/$defs/messageId"},"role":{"enum":["user","assistant"]},"content":{"type":"string"},"createdAt":{"$ref":"#/$defs/date"}},"required":["id","role","content","createdAt"]},"chat":{"type":"object","properties":{"id":{"$ref":"#/$defs/id"},"title":{"type":"string","x-maxUtf16Length":500},"createdAt":{"$ref":"#/$defs/date"},"updatedAt":{"$ref":"#/$defs/date"},"messages":{"type":"array","items":{"$ref":"#/$defs/textMessage"}}},"required":["id","title","createdAt","updatedAt","messages"]},"deletion":{"type":"object","properties":{"id":{"$ref":"#/$defs/id"},"deletedAt":{"$ref":"#/$defs/date"}},"required":["id","deletedAt"]},"snapshot":{"type":"object","properties":{"version":{"const":1},"chats":{"type":"array","items":{"$ref":"#/$defs/chat"}},"deletedChats":{"type":"array","items":{"$ref":"#/$defs/deletion"}},"workspace":{"$ref":"#/$defs/workspace"},"tasks":{"type":"array","maxItems":500,"items":{"$ref":"#/$defs/task"}},"handoffs":{"type":"array","maxItems":1000,"items":{"$ref":"#/$defs/handoff"}}},"required":["version","chats"]},"agentCapabilities":{"type":"object","required":["version","readFiles","writeFiles","runCommands","network","knowledgeMemory","generateMedia","delegate","mcpServers","skills","connectors"],"additionalProperties":false,"properties":{"version":{"const":1},"readFiles":{"type":"boolean"},"writeFiles":{"type":"boolean"},"runCommands":{"type":"boolean"},"network":{"type":"boolean"},"knowledgeMemory":{"type":"boolean"},"generateMedia":{"type":"boolean"},"delegate":{"type":"boolean"},"mcpServers":{"type":"array","maxItems":1000,"items":{"type":"string","minLength":1,"maxLength":200}},"skills":{"type":"array","maxItems":1000,"items":{"type":"string","minLength":1,"maxLength":200}},"connectors":{"type":"array","maxItems":1000,"items":{"type":"string","minLength":1,"maxLength":200}}}},"agentCollaboration":{"type":"object","required":["canDelegate","delegateTargets","maxDelegationDepth","maxIterations","maxTokens","timeoutMs"],"additionalProperties":false,"properties":{"canDelegate":{"type":"boolean"},"delegateTargets":{"type":"array","maxItems":1000,"items":{"type":"string","minLength":1,"maxLength":200}},"maxDelegationDepth":{"type":"integer","minimum":1,"maximum":3},"maxIterations":{"type":"integer","minimum":1,"maximum":20},"maxTokens":{"type":"integer","minimum":1,"maximum":200000},"timeoutMs":{"type":"integer","minimum":1,"maximum":900000}}},"agentContextSources":{"type":"object","required":["projects","knowledge","memory"],"additionalProperties":false,"properties":{"projects":{"type":"boolean"},"knowledge":{"type":"boolean"},"memory":{"type":"boolean"}}},"agentSettings":{"type":"object","required":["agentId","projectId","capabilities","collaboration","contextSources"],"additionalProperties":false,"properties":{"agentId":{"$ref":"#/$defs/id"},"projectId":{"anyOf":[{"$ref":"#/$defs/id"},{"type":"null"}]},"capabilities":{"$ref":"#/$defs/agentCapabilities"},"collaboration":{"$ref":"#/$defs/agentCollaboration"},"contextSources":{"$ref":"#/$defs/agentContextSources"}}},"projectMemory":{"type":"object","properties":{"id":{"$ref":"#/$defs/id"},"chatId":{"const":""},"agentId":{"$ref":"#/$defs/id"},"scope":{"enum":["project","agent","personal"]},"status":{"enum":["active","forgotten","historical","unconfirmed"]},"text":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":2000},"memoryID":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":180},"originalFact":{"type":["string","null"],"x-maxUtf16Length":2000},"sourceText":{"type":["string","null"],"x-maxUtf16Length":1600},"category":{"type":["string","null"],"x-maxUtf16Length":100},"messageId":{"type":["string","null"],"x-maxUtf16Length":180},"projectId":{"$ref":"#/$defs/id"},"validTo":{"type":["string","null"],"x-maxUtf16Length":100},"updatedAt":{"type":"string"},"userEdited":{"type":"boolean"},"mergedInto":{"type":"string","x-minUtf16Length":1,"x-maxUtf16Length":180},"section":{"enum":["goal","convention","decision","progress","todo","file"]},"bookStatus":{"enum":["auto","confirmed","user"]},"origin":{"const":"project"}},"required":["id","chatId","agentId","scope","status","text","memoryID","updatedAt","origin","projectId"]}}}"##.utf8))
    static func validate(_ value: SyncValue, definition: String = "workspace") throws {
        try check(value, schema["$defs"][definition])
    }
    static func check(_ value: SyncValue, _ rule: SyncValue) throws {
        func fail() throws { throw MeloError.message("同步数据不符合共享协议，原数据已保留。") }
        let fields = rule.object
        if let ref = fields["$ref"] { try check(value, schema["$defs"][ref.string.components(separatedBy: "/").last!]); return }
        if let fixed = fields["const"], fixed != value { try fail() }
        if let values = fields["enum"], !values.array.contains(value) { try fail() }
        if let excluded = fields["not"], (try? check(value, excluded)) != nil { try fail() }
        if let choices = fields["anyOf"], !choices.array.contains(where: { (try? check(value, $0)) != nil }) { try fail() }
        for item in rule["allOf"].array { try check(value, item) }
        if let condition = fields["if"], (try? check(value, condition)) != nil, let then = fields["then"] { try check(value, then) }
        let types = rule["type"].array.isEmpty ? [rule["type"].string] : rule["type"].array.map(\.string)
        var actual: String
        switch value {
        case .null: actual = "null"
        case .string: actual = "string"
        case .number: actual = "number"
        case .bool: actual = "boolean"
        case .array: actual = "array"
        case .object: actual = "object"
        }
        var integer = false
        if case .number(let n) = value { integer = n.isFinite && n.rounded() == n && abs(n) <= 9_007_199_254_740_991 }
        if fields["type"] != nil && !types.contains(actual) && !(types.contains("integer") && integer) { try fail() }
        func bounds(_ n: Double, _ minimum: String, _ maximum: String) throws {
            if case .number(let limit) = rule[minimum], n < limit { try fail() }
            if case .number(let limit) = rule[maximum], n > limit { try fail() }
        }
        switch value {
        case .string(let text):
            try bounds(Double(text.unicodeScalars.count), "minLength", "maxLength")
            try bounds(Double(text.utf16.count), "x-minUtf16Length", "x-maxUtf16Length")
            if let pattern = fields["pattern"], text.range(of: pattern.string, options: .regularExpression) == nil { try fail() }
        case .number(let n):
            if !n.isFinite { try fail() }
            try bounds(n, "minimum", "maximum")
        case .array(let items):
            try bounds(Double(items.count), "minItems", "maxItems")
            if let itemRule = fields["items"] { for item in items { try check(item, itemRule) } }
        case .object(let object):
            try bounds(Double(object.count), "minProperties", "maxProperties")
            for key in rule["required"].array { if object[key.string] == nil { try fail() } }
            for (key, item) in object {
                if let names = fields["propertyNames"] { try check(.string(key), names) }
                if let property = rule["properties"].object[key] { try check(item, property) }
                else if let extra = fields["additionalProperties"] {
                    if extra == .bool(false) { try fail() }
                    if case .object = extra { try check(item, extra) }
                }
            }
        default: break
        }
    }
}
// END GENERATED SYNC CONTRACT
