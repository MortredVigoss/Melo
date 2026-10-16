import Foundation

// Phone data tools for the Codex Responses loop. This file stays free of
// EventKit / Contacts / CoreLocation so the policy, parsing and approval rules
// compile into the offline Swift test suites. System access lives in
// DeviceDataSources.swift.

enum DeviceDataKind: String, CaseIterable, Codable, Identifiable {
    case calendar, reminders, contacts, location
    var id: String { rawValue }
    var label: String {
        switch self {
        case .calendar: return "日历"
        case .reminders: return "提醒事项"
        case .contacts: return "通讯录"
        case .location: return "当前位置"
        }
    }
    var detail: String {
        switch self {
        case .calendar: return "查看日程；新建日程前会请你确认。包括已添加到 iPhone 的 Google、iCloud 等日历。"
        case .reminders: return "查看提醒；新建或完成提醒前会请你确认。"
        case .contacts: return "按姓名查找联系人的电话、邮箱和公司。"
        case .location: return "需要时读取一次当前位置，用于“附近”“我在哪”这类问题。"
        }
    }
    var symbol: String {
        switch self {
        case .calendar: return "calendar"
        case .reminders: return "checklist"
        case .contacts: return "person.crop.circle"
        case .location: return "location"
        }
    }
}

/// Device-local opt-in. Never synced: these grants describe this iPhone's data.
struct DeviceToolPolicy: Equatable {
    static let defaultsKey = "deviceDataEnabledKinds"
    var enabled: Set<DeviceDataKind> = []
    static func load(_ defaults: UserDefaults = .standard) -> DeviceToolPolicy {
        let raw = defaults.stringArray(forKey: defaultsKey) ?? []
        return DeviceToolPolicy(enabled: Set(raw.compactMap(DeviceDataKind.init(rawValue:))))
    }
    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(enabled.map(\.rawValue).sorted(), forKey: Self.defaultsKey)
    }
    var tools: [DeviceToolSpec] { DeviceToolSpec.all.filter { enabled.contains($0.kind) } }
}

/// What one Agent may do when it runs on this iPhone. Desktop capabilities
/// govern desktop execution; these govern phone execution. Device-local and
/// never synced, like file bookmarks and OS permissions.
enum PhoneCapability: String, CaseIterable, Codable, Identifiable {
    case network, generateMedia, calendar, reminders, contacts, location
    var id: String { rawValue }
    var deviceKind: DeviceDataKind? { DeviceDataKind(rawValue: rawValue) }
    var label: String {
        switch self {
        case .network: return "联网搜索"
        case .generateMedia: return "生成与修改图片"
        default: return deviceKind!.label
        }
    }
    var symbol: String {
        switch self {
        case .network: return "globe"
        case .generateMedia: return "photo.badge.plus"
        default: return deviceKind!.symbol
        }
    }
}

struct PhoneAgentPermissions: Equatable {
    static let defaultsKey = "phoneAgentPermissions"
    static let migratedKey = "phoneAgentPermissionsMigrated"
    /// Agents without an entry keep the phone's existing behaviour: web search
    /// and image generation on, no personal data.
    static let baseline: Set<PhoneCapability> = [.network, .generateMedia]
    var grants: [String: Set<PhoneCapability>] = [:]

    func allowed(_ agentID: String) -> Set<PhoneCapability> { grants[agentID] ?? Self.baseline }
    func allows(_ agentID: String, _ capability: PhoneCapability) -> Bool { allowed(agentID).contains(capability) }
    mutating func set(_ agentID: String, _ capability: PhoneCapability, _ on: Bool) {
        var current = allowed(agentID)
        if on { current.insert(capability) } else { current.remove(capability) }
        grants[agentID] = current
    }

    static func load(_ defaults: UserDefaults = .standard) -> PhoneAgentPermissions {
        var result = PhoneAgentPermissions()
        if let raw = defaults.dictionary(forKey: defaultsKey) as? [String: [String]] {
            result.grants = raw.mapValues { Set($0.compactMap(PhoneCapability.init(rawValue:))) }
        }
        // Phone data used to be device-wide. Keep it working for the default
        // Agent only; every other Agent must be granted explicitly.
        if !defaults.bool(forKey: migratedKey) {
            let legacy = DeviceToolPolicy.load(defaults).enabled
            if !legacy.isEmpty, result.grants["melo"] == nil {
                result.grants["melo"] = baseline.union(legacy.compactMap { PhoneCapability(rawValue: $0.rawValue) })
            }
            defaults.set(true, forKey: migratedKey)
            result.save(defaults)
        }
        return result
    }
    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(grants.mapValues { $0.map(\.rawValue).sorted() }, forKey: Self.defaultsKey)
    }

    /// Phone data needs both the device switch (with OS permission) and this Agent's grant.
    func devicePolicy(for agentID: String, device: DeviceToolPolicy) -> DeviceToolPolicy {
        DeviceToolPolicy(enabled: device.enabled.filter { allows(agentID, PhoneCapability(rawValue: $0.rawValue)!) })
    }
}

struct DeviceToolSpec {
    let name: String
    let kind: DeviceDataKind
    let writes: Bool
    let description: String
    let parameters: [String: Any]

    var responsesDefinition: [String: Any] {
        ["type": "function", "name": name, "description": description, "parameters": parameters, "strict": false]
    }

    static func object(_ properties: [String: [String: Any]], required: [String] = []) -> [String: Any] {
        ["type": "object", "properties": properties, "required": required, "additionalProperties": false]
    }
    static let isoDate: [String: Any] = ["type": "string", "description": "ISO 8601 date-time with time zone offset, e.g. 2026-10-16T09:00:00+11:00"]

    static let all: [DeviceToolSpec] = [
        DeviceToolSpec(name: "calendar_list_events", kind: .calendar, writes: false,
                       description: "List calendar events on this iPhone between start and end (max 92 days). Optional query filters by title, location or notes.",
                       parameters: object(["start": isoDate, "end": isoDate, "query": ["type": "string"]], required: ["start", "end"])),
        DeviceToolSpec(name: "calendar_create_event", kind: .calendar, writes: true,
                       description: "Create a calendar event in the default calendar. The user must approve before it is saved.",
                       parameters: object(["title": ["type": "string"], "start": isoDate, "end": isoDate, "location": ["type": "string"], "notes": ["type": "string"]], required: ["title", "start", "end"])),
        DeviceToolSpec(name: "reminders_list", kind: .reminders, writes: false,
                       description: "List reminders. By default only incomplete reminders. Optional query filters by title or notes.",
                       parameters: object(["includeCompleted": ["type": "boolean"], "query": ["type": "string"]])),
        DeviceToolSpec(name: "reminders_create", kind: .reminders, writes: true,
                       description: "Create a reminder in the default list, optionally with a due date. The user must approve before it is saved.",
                       parameters: object(["title": ["type": "string"], "due": isoDate, "notes": ["type": "string"]], required: ["title"])),
        DeviceToolSpec(name: "reminders_complete", kind: .reminders, writes: true,
                       description: "Mark one reminder as completed, using an id returned by reminders_list. The user must approve first.",
                       parameters: object(["id": ["type": "string"]], required: ["id"])),
        DeviceToolSpec(name: "contacts_search", kind: .contacts, writes: false,
                       description: "Search contacts by name. Returns at most 20 matches with phones, emails and organization.",
                       parameters: object(["query": ["type": "string"]], required: ["query"])),
        DeviceToolSpec(name: "location_current", kind: .location, writes: false,
                       description: "Read the iPhone's current approximate location once, with a reverse-geocoded place name.",
                       parameters: object([:])),
    ]
    static func named(_ name: String) -> DeviceToolSpec? { all.first { $0.name == name } }
}

/// One function call from a completed Responses output.
struct ResponsesFunctionCall: Equatable {
    let callID: String
    let name: String
    let arguments: String
}

struct DeviceEvent: Equatable {
    var id: String; var title: String; var start: Date; var end: Date; var allDay: Bool
    var location: String; var calendar: String; var notes: String
}
struct DeviceReminder: Equatable {
    var id: String; var title: String; var due: Date?; var completed: Bool; var list: String; var notes: String
}
struct DeviceContact: Equatable {
    var name: String; var organization: String; var phones: [String]; var emails: [String]
}
struct DevicePlace: Equatable {
    var latitude: Double; var longitude: Double; var accuracy: Double; var name: String
}

/// System access boundary. Implementations request OS permission lazily.
protocol DeviceDataSource {
    func events(from start: Date, to end: Date) async throws -> [DeviceEvent]
    func createEvent(title: String, start: Date, end: Date, location: String, notes: String) async throws -> DeviceEvent
    func reminders(includeCompleted: Bool) async throws -> [DeviceReminder]
    func createReminder(title: String, due: Date?, notes: String) async throws -> DeviceReminder
    func completeReminder(id: String) async throws -> DeviceReminder
    func contacts(matching query: String) async throws -> [DeviceContact]
    func currentPlace() async throws -> DevicePlace
}

/// What the user sees before a write is allowed.
struct DeviceActionRequest: Identifiable, Equatable {
    let id = UUID()
    let tool: String
    let title: String
    let detail: String
    static func == (a: DeviceActionRequest, b: DeviceActionRequest) -> Bool { a.id == b.id }
}

enum DeviceToolError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}

enum DeviceToolRunner {
    static let maxOutputCharacters = 8000
    private struct AccessRevoked: Error {}

    static func parseDate(_ value: Any?) -> Date? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter(); withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func format(_ date: Date, timeZone: TimeZone = .current) -> String {
        let formatter = ISO8601DateFormatter(); formatter.timeZone = timeZone
        return formatter.string(from: date)
    }
    static func text(_ value: Any?, limit: Int = 500) -> String {
        String(((value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
    }

    /// Executes one model call. Every failure becomes a JSON result for the
    /// model; nothing reaches the data source unless the kind is enabled, the
    /// arguments validate, and (for writes) the user approved this exact call.
    static func run(_ call: ResponsesFunctionCall, policy: DeviceToolPolicy, source: DeviceDataSource,
                    approve: (DeviceActionRequest) async -> Bool, timeZone: TimeZone = .current,
                    isAllowed: (() -> Bool)? = nil) async -> String {
        func encode(_ object: [String: Any]) -> String {
            var bounded = object
            let rowsKey = ["events", "reminders", "contacts"].first { bounded[$0] is [[String: Any]] }
            if let key = rowsKey, let rows = bounded[key] as? [[String: Any]] {
                bounded["returnedCount"] = rows.count
                bounded["truncated"] = (bounded["count"] as? Int ?? rows.count) > rows.count
            }
            // Remove complete rows, never bytes from serialized JSON. The model
            // can narrow its query when returnedCount is smaller than count.
            while let data = try? JSONSerialization.data(withJSONObject: bounded, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8) {
                if text.count <= maxOutputCharacters { return text }
                guard let key = rowsKey, var rows = bounded[key] as? [[String: Any]], !rows.isEmpty else {
                    return #"{"ok":false,"error":"RESULT_TOO_LARGE","message":"Narrow the query to return less data."}"#
                }
                rows.removeLast(); bounded[key] = rows
                bounded["returnedCount"] = rows.count; bounded["truncated"] = true
            }
            return #"{"ok":false,"error":"ENCODING_FAILED"}"#
        }
        func failure(_ code: String, _ message: String) -> String { encode(["ok": false, "error": code, "message": message]) }
        func checkAccess() throws {
            try Task.checkCancellation()
            guard isAllowed?() ?? true else { throw AccessRevoked() }
        }
        guard let spec = DeviceToolSpec.named(call.name) else { return failure("UNKNOWN_TOOL", "This phone tool does not exist.") }
        guard policy.enabled.contains(spec.kind) else { return failure("NOT_ENABLED", "The user has not enabled \(spec.kind.label) access for Melo on this iPhone.") }
        guard let data = call.arguments.data(using: .utf8),
              let args = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return failure("INVALID_ARGUMENTS", "Arguments must be a JSON object.") }
        let date = { (date: Date) in format(date, timeZone: timeZone) }
        do {
            try checkAccess()
            switch spec.name {
            case "calendar_list_events":
                guard let start = parseDate(args["start"]), let end = parseDate(args["end"]), end > start else { throw DeviceToolError.invalid("start and end must be ISO 8601 dates and end must be after start.") }
                guard end.timeIntervalSince(start) <= 92 * 86_400 else { throw DeviceToolError.invalid("The range may not exceed 92 days.") }
                let query = text(args["query"]).lowercased()
                var events = try await source.events(from: start, to: end)
                try checkAccess()
                if !query.isEmpty { events = events.filter { ($0.title + " " + $0.location + " " + $0.notes).lowercased().contains(query) } }
                let rows = events.prefix(100).map { ["id": $0.id, "title": $0.title, "start": date($0.start), "end": date($0.end), "allDay": $0.allDay, "location": $0.location, "calendar": $0.calendar, "notes": String($0.notes.prefix(300))] as [String: Any] }
                return encode(["ok": true, "count": events.count, "events": rows])
            case "calendar_create_event":
                let title = text(args["title"], limit: 200)
                guard !title.isEmpty, let start = parseDate(args["start"]), let end = parseDate(args["end"]), end > start else { throw DeviceToolError.invalid("title, start and end are required and end must be after start.") }
                let location = text(args["location"], limit: 200), notes = text(args["notes"], limit: 2000)
                let detail = "\(title)\n\(date(start)) – \(date(end))" + (location.isEmpty ? "" : "\n地点：\(location)") + (notes.isEmpty ? "" : "\n备注：\(notes)")
                guard await approve(DeviceActionRequest(tool: spec.name, title: "新建日程", detail: detail)) else { return failure("USER_DECLINED", "The user declined to create this event.") }
                try checkAccess()
                let event = try await source.createEvent(title: title, start: start, end: end, location: location, notes: notes)
                return encode(["ok": true, "event": ["id": event.id, "title": event.title, "start": date(event.start), "end": date(event.end), "calendar": event.calendar]])
            case "reminders_list":
                let includeCompleted = args["includeCompleted"] as? Bool ?? false
                let query = text(args["query"]).lowercased()
                var items = try await source.reminders(includeCompleted: includeCompleted)
                try checkAccess()
                if !query.isEmpty { items = items.filter { ($0.title + " " + $0.notes).lowercased().contains(query) } }
                let rows = items.prefix(100).map { item -> [String: Any] in
                    var row: [String: Any] = ["id": item.id, "title": item.title, "completed": item.completed, "list": item.list, "notes": String(item.notes.prefix(300))]
                    if let due = item.due { row["due"] = date(due) }
                    return row
                }
                return encode(["ok": true, "count": items.count, "reminders": rows])
            case "reminders_create":
                let title = text(args["title"], limit: 200)
                guard !title.isEmpty else { throw DeviceToolError.invalid("title is required.") }
                let due = parseDate(args["due"])
                if args["due"] != nil, !(args["due"] is NSNull), due == nil { throw DeviceToolError.invalid("due must be an ISO 8601 date.") }
                let notes = text(args["notes"], limit: 2000)
                let detail = title + (due.map { "\n截止：\(date($0))" } ?? "") + (notes.isEmpty ? "" : "\n备注：\(notes)")
                guard await approve(DeviceActionRequest(tool: spec.name, title: "新建提醒", detail: detail)) else { return failure("USER_DECLINED", "The user declined to create this reminder.") }
                try checkAccess()
                let item = try await source.createReminder(title: title, due: due, notes: notes)
                return encode(["ok": true, "reminder": ["id": item.id, "title": item.title, "list": item.list]])
            case "reminders_complete":
                let id = text(args["id"], limit: 300)
                guard !id.isEmpty else { throw DeviceToolError.invalid("id is required.") }
                let current = try await source.reminders(includeCompleted: true).first { $0.id == id }
                try checkAccess()
                guard let current else { throw DeviceToolError.invalid("No reminder has this id. Call reminders_list first.") }
                guard await approve(DeviceActionRequest(tool: spec.name, title: "完成提醒", detail: current.title)) else { return failure("USER_DECLINED", "The user declined to complete this reminder.") }
                try checkAccess()
                let item = try await source.completeReminder(id: id)
                return encode(["ok": true, "reminder": ["id": item.id, "title": item.title, "completed": item.completed]])
            case "contacts_search":
                let query = text(args["query"], limit: 100)
                guard !query.isEmpty else { throw DeviceToolError.invalid("query is required.") }
                let people = try await source.contacts(matching: query)
                try checkAccess()
                return encode(["ok": true, "count": people.count, "contacts": people.prefix(20).map { ["name": $0.name, "organization": $0.organization, "phones": $0.phones, "emails": $0.emails] as [String: Any] }])
            case "location_current":
                let place = try await source.currentPlace()
                try checkAccess()
                return encode(["ok": true, "latitude": place.latitude, "longitude": place.longitude, "accuracyMeters": place.accuracy, "place": place.name])
            default:
                return failure("UNKNOWN_TOOL", "This phone tool does not exist.")
            }
        } catch is CancellationError {
            return failure("CANCELLED", "The request was cancelled.")
        } catch is AccessRevoked {
            return failure("NOT_ENABLED", "The user disabled this phone data access during the request.")
        } catch let error as DeviceToolError {
            return failure("INVALID_ARGUMENTS", error.localizedDescription)
        } catch {
            return failure("DEVICE_ERROR", error.localizedDescription)
        }
    }
}

/// Responses-protocol plumbing for a stateless (store:false) tool loop.
enum DeviceToolLoop {
    static let maxRounds = 6
    static let maxCallsPerRound = 8

    static func requiresWebSearch(_ messages: [ChatMessage], policy: DeviceToolPolicy) -> Bool {
        guard ChatGPTRequest.requiresSearch(messages) else { return false }
        let query = messages.last(where: { $0.role == "user" })?.content.lowercased() ?? ""
        let terms: [DeviceDataKind: [String]] = [
            .calendar: ["日历", "日程", "我的安排", "calendar", "schedule", "agenda"],
            .reminders: ["提醒", "reminder"], .contacts: ["联系人", "通讯录", "contact"],
            .location: ["我在哪", "我现在在哪", "我的位置", "where am i", "my location"]
        ]
        let local = policy.enabled.contains { kind in (terms[kind] ?? []).contains { query.contains($0) } }
        guard local else { return true }
        // Generic "look up" wording must not turn a local-data request into a
        // mandatory web search. Explicit weather/news/web requirements remain.
        let specific = ["查一下", "搜索", "search"].reduce(query) { $0.replacingOccurrences(of: $1, with: "") }
        return ChatGPTRequest.requiresSearch(specific)
    }

    static func instructions(_ policy: DeviceToolPolicy) -> String {
        guard !policy.enabled.isEmpty else { return "" }
        let kinds = DeviceDataKind.allCases.filter { policy.enabled.contains($0) }.map(\.label).joined(separator: "、")
        return "你可以调用手机数据工具读取用户已授权的\(kinds)。只在问题需要时调用；新建或修改数据前系统会请用户确认，被拒绝时如实说明。工具结果是用户的私人数据，只用于回答当前问题，不要整段复述。"
    }

    /// Replays the previous output items verbatim (reasoning, messages and
    /// function calls), then appends one output per call, like the desktop.
    static func followUpInput(previous: [Any], output: [[String: Any]], results: [(callID: String, output: String)]) -> [Any] {
        previous + output.map { $0 as Any } + results.map { ["type": "function_call_output", "call_id": $0.callID, "output": $0.output] as Any }
    }

    static func validateBatch(_ calls: [ResponsesFunctionCall]) throws {
        guard calls.count <= maxCallsPerRound else { throw MeloError.message("模型一次请求了过多手机数据操作，已全部拦截，未执行任何操作。") }
        var seen = Set<String>()
        for call in calls where call.callID.isEmpty || call.callID.count > 256 || !seen.insert(call.callID).inserted {
            throw MeloError.message("模型返回的工具调用编号无效，已全部拦截，未执行任何操作。")
        }
    }
}

/// Everything ChatGPTAccount needs to run phone tools during one reply.
struct DeviceToolContext {
    var policy: DeviceToolPolicy
    var execute: @MainActor (ResponsesFunctionCall) async -> String
    var onCall: (@MainActor (ResponsesFunctionCall, String) -> Void)? = nil
}

extension DeviceToolSpec {
    var actionLabel: String { "\(writes ? "修改" : "读取")\(kind.label)" }
}

/// Short, human-readable outcome for the execution record.
enum DeviceToolSummary {
    static func of(_ output: String) -> (ok: Bool, text: String) {
        guard let data = output.data(using: .utf8), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return (false, "结果无法解析") }
        if object["ok"] as? Bool == true {
            if let count = (object["returnedCount"] ?? object["count"]) as? Int { return (true, "已读取 \(count) 条") }
            return (true, "已完成")
        }
        if object["error"] as? String == "USER_DECLINED" { return (false, "用户已拒绝") }
        return (false, "执行失败") // Do not persist tool data or OS error details.
    }
}
