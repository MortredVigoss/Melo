import Foundation

// Offline checks for phone data tools: policy, Responses parsing, follow-up
// input, and the guarantee that nothing touches device data unless enabled,
// valid and (for writes) approved. Counters prove the source was not called.
final class FakeSource: DeviceDataSource {
    var reads = 0, writes = 0
    var stored = [DeviceReminder(id: "r1", title: "交房租", due: nil, completed: false, list: "提醒", notes: "")]
    func events(from start: Date, to end: Date) async throws -> [DeviceEvent] {
        reads += 1
        return [DeviceEvent(id: "e1", title: "牙医", start: start, end: start.addingTimeInterval(3600), allDay: false, location: "诊所", calendar: "家庭", notes: ""),
                DeviceEvent(id: "e2", title: "周会", start: start, end: start.addingTimeInterval(1800), allDay: false, location: "", calendar: "工作", notes: "")]
    }
    func createEvent(title: String, start: Date, end: Date, location: String, notes: String) async throws -> DeviceEvent {
        writes += 1
        return DeviceEvent(id: "new", title: title, start: start, end: end, allDay: false, location: location, calendar: "家庭", notes: notes)
    }
    func reminders(includeCompleted: Bool) async throws -> [DeviceReminder] { reads += 1; return stored }
    func createReminder(title: String, due: Date?, notes: String) async throws -> DeviceReminder {
        writes += 1; return DeviceReminder(id: "r2", title: title, due: due, completed: false, list: "提醒", notes: notes)
    }
    func completeReminder(id: String) async throws -> DeviceReminder {
        writes += 1; var item = stored[0]; item.completed = true; return item
    }
    func contacts(matching query: String) async throws -> [DeviceContact] { reads += 1; return [DeviceContact(name: "张三", organization: "Melo", phones: ["123"], emails: [])] }
    func currentPlace() async throws -> DevicePlace { reads += 1; return DevicePlace(latitude: -33.86, longitude: 151.2, accuracy: 50, name: "Sydney") }
}

func json(_ text: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
}
func call(_ name: String, _ args: String, id: String = "c1") -> ResponsesFunctionCall { ResponsesFunctionCall(callID: id, name: name, arguments: args) }

@main struct DeviceToolsTests {
    static func main() async {
        let all = DeviceToolPolicy(enabled: Set(DeviceDataKind.allCases))
        let none = DeviceToolPolicy()

        // Exposure: disabled kinds are never offered to the model.
        assert(none.tools.isEmpty)
        assert(DeviceToolPolicy(enabled: [.contacts]).tools.map(\.name) == ["contacts_search"])
        assert(all.tools.count == DeviceToolSpec.all.count)
        assert(all.tools.allSatisfy { $0.responsesDefinition["type"] as? String == "function" })
        assert(DeviceToolLoop.instructions(none).isEmpty)
        assert(DeviceToolLoop.instructions(DeviceToolPolicy(enabled: [.calendar])).contains("日历"))
        assert(!DeviceToolLoop.requiresWebSearch([ChatMessage(role: "user", content: "查一下我明天的日程")], policy: all))
        assert(!DeviceToolLoop.requiresWebSearch([ChatMessage(role: "user", content: "search my contacts for Sam")], policy: all))
        assert(DeviceToolLoop.requiresWebSearch([ChatMessage(role: "user", content: "查一下我明天的日程和悉尼天气")], policy: all))
        assert(DeviceToolLoop.requiresWebSearch([ChatMessage(role: "user", content: "查一下附近餐厅")], policy: all))
        assert(DeviceToolLoop.requiresWebSearch([ChatMessage(role: "user", content: "查一下我明天的日程")], policy: none))

        // Policy persists only device-local kinds and ignores unknown values.
        let defaults = UserDefaults(suiteName: "melo.device-tools.test.\(UUID().uuidString)")!
        DeviceToolPolicy(enabled: [.reminders, .location]).save(defaults)
        assert(DeviceToolPolicy.load(defaults).enabled == [.reminders, .location])
        defaults.set(["calendar", "bogus"], forKey: DeviceToolPolicy.defaultsKey)
        assert(DeviceToolPolicy.load(defaults).enabled == [.calendar])

        // Disabled kind: rejected before the source or an approval prompt.
        var source = FakeSource(); var prompts = 0
        let approveYes: (DeviceActionRequest) async -> Bool = { _ in prompts += 1; return true }
        let approveNo: (DeviceActionRequest) async -> Bool = { _ in prompts += 1; return false }
        var out = await DeviceToolRunner.run(call("calendar_list_events", #"{"start":"2026-10-16T00:00:00+11:00","end":"2026-10-17T00:00:00+11:00"}"#), policy: none, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "NOT_ENABLED" && source.reads == 0 && prompts == 0)

        // Unknown tool and malformed arguments never reach the source.
        out = await DeviceToolRunner.run(call("shell_exec", "{}"), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "UNKNOWN_TOOL")
        out = await DeviceToolRunner.run(call("calendar_list_events", "not json"), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "INVALID_ARGUMENTS")
        out = await DeviceToolRunner.run(call("calendar_list_events", #"{"start":"tomorrow","end":"2026-10-17T00:00:00Z"}"#), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "INVALID_ARGUMENTS")
        out = await DeviceToolRunner.run(call("calendar_list_events", #"{"start":"2026-01-01T00:00:00Z","end":"2026-12-31T00:00:00Z"}"#), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "INVALID_ARGUMENTS", "ranges over 92 days are refused")
        assert(source.reads == 0 && source.writes == 0 && prompts == 0)

        // Reads run without an approval prompt and honour the query filter.
        out = await DeviceToolRunner.run(call("calendar_list_events", #"{"start":"2026-10-16T00:00:00+11:00","end":"2026-10-17T00:00:00+11:00","query":"牙"}"#), policy: all, source: source, approve: approveYes)
        let listed = json(out)
        assert(listed["ok"] as? Bool == true && listed["count"] as? Int == 1 && source.reads == 1 && prompts == 0)
        assert(((listed["events"] as? [[String: Any]])?.first?["title"] as? String) == "牙医")

        // Writes: declined → zero side effects; approved → exactly one.
        source = FakeSource(); prompts = 0
        let create = call("calendar_create_event", #"{"title":"看牙","start":"2026-10-20T09:00:00+11:00","end":"2026-10-20T10:00:00+11:00","location":"诊所"}"#)
        out = await DeviceToolRunner.run(create, policy: all, source: source, approve: approveNo)
        assert(json(out)["error"] as? String == "USER_DECLINED" && source.writes == 0 && prompts == 1)
        out = await DeviceToolRunner.run(create, policy: all, source: source, approve: approveYes)
        assert(json(out)["ok"] as? Bool == true && source.writes == 1 && prompts == 2)
        // Invalid write arguments are refused before asking the user.
        out = await DeviceToolRunner.run(call("calendar_create_event", #"{"title":"x","start":"2026-10-20T10:00:00Z","end":"2026-10-20T09:00:00Z"}"#), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "INVALID_ARGUMENTS" && source.writes == 1 && prompts == 2)
        out = await DeviceToolRunner.run(call("reminders_create", #"{"title":"买牛奶","due":"someday"}"#), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "INVALID_ARGUMENTS" && source.writes == 1 && prompts == 2)

        // Completing an unknown reminder never prompts or writes.
        out = await DeviceToolRunner.run(call("reminders_complete", #"{"id":"missing"}"#), policy: all, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "INVALID_ARGUMENTS" && source.writes == 1 && prompts == 2)
        out = await DeviceToolRunner.run(call("reminders_complete", #"{"id":"r1"}"#), policy: all, source: source, approve: approveYes)
        assert(json(out)["ok"] as? Bool == true && source.writes == 2 && prompts == 3)

        // Kind isolation: enabling contacts does not allow reminders writes.
        source = FakeSource(); prompts = 0
        out = await DeviceToolRunner.run(call("reminders_create", #"{"title":"x"}"#), policy: DeviceToolPolicy(enabled: [.contacts]), source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "NOT_ENABLED" && source.writes == 0 && prompts == 0)
        out = await DeviceToolRunner.run(call("contacts_search", #"{"query":"张"}"#), policy: DeviceToolPolicy(enabled: [.contacts]), source: source, approve: approveYes)
        assert(json(out)["count"] as? Int == 1 && source.reads == 1)
        out = await DeviceToolRunner.run(call("location_current", "{}"), policy: all, source: source, approve: approveYes)
        assert(DeviceToolSummary.of(out) == (true, "已完成"), "Do not persist location names in execution records")
        assert(DeviceToolSummary.of(#"{"ok":false,"error":"USER_DECLINED"}"#).text == "用户已拒绝")

        // Large reads stay valid JSON, report truncation and retain complete rows.
        source = FakeSource()
        source.stored = (0..<100).map { DeviceReminder(id: "r\($0)", title: String(repeating: "较长标题", count: 25), due: nil, completed: false, list: "测试", notes: String(repeating: "长备注", count: 200)) }
        out = await DeviceToolRunner.run(call("reminders_list", "{}"), policy: all, source: source, approve: approveYes)
        let bounded = json(out), rows = json(out)["reminders"] as? [[String: Any]] ?? []
        assert(bounded["ok"] as? Bool == true && bounded["truncated"] as? Bool == true)
        assert(bounded["count"] as? Int == 100 && !rows.isEmpty && rows.count < 100)
        assert(bounded["returnedCount"] as? Int == rows.count && out.count <= DeviceToolRunner.maxOutputCharacters)
        assert(DeviceToolSummary.of(out).text == "已读取 \(rows.count) 条")
        assert(DeviceToolSummary.of(#"{"ok":false,"message":"private address"}"#).text == "执行失败")

        // A switch revoked before execution or while approval is open stops all access.
        source = FakeSource(); prompts = 0
        out = await DeviceToolRunner.run(create, policy: all, source: source, approve: approveYes, isAllowed: { false })
        assert(json(out)["error"] as? String == "NOT_ENABLED" && source.writes == 0 && prompts == 0)
        var enabled = true
        out = await DeviceToolRunner.run(create, policy: all, source: source, approve: { _ in enabled = false; return true }, isAllowed: { enabled })
        assert(json(out)["error"] as? String == "NOT_ENABLED" && source.writes == 0)
        let cancelledSource = FakeSource()
        let cancelledOutput = await Task {
            await DeviceToolRunner.run(create, policy: all, source: cancelledSource, approve: { _ in
                withUnsafeCurrentTask { $0?.cancel() }; return true
            })
        }.value
        assert(json(cancelledOutput)["error"] as? String == "CANCELLED" && cancelledSource.writes == 0)
        // Approval must show every user-visible field that will be written.
        let withNotes = call("reminders_create", #"{"title":"测试提醒","notes":"需确认的备注"}"#)
        out = await DeviceToolRunner.run(withNotes, policy: all, source: source, approve: { request in
            assert(request.detail.contains("需确认的备注")); return false
        })
        assert(json(out)["error"] as? String == "USER_DECLINED")

        // Batch validation happens before any call executes.
        do { try DeviceToolLoop.validateBatch([call("a", "{}", id: "x"), call("b", "{}", id: "x")]); assert(false, "duplicate ids") } catch {}
        do { try DeviceToolLoop.validateBatch((0..<9).map { call("a", "{}", id: "id\($0)") }); assert(false, "too many calls") } catch {}
        do { try DeviceToolLoop.validateBatch([call("a", "{}", id: "")]); assert(false, "empty id") } catch {}
        do { try DeviceToolLoop.validateBatch([call("a", "{}", id: "1"), call("b", "{}", id: "2")]) } catch { assert(false, "valid batch") }

        // Responses parsing: a completed response with a function call and no text.
        var stream = ChatGPTStream()
        let reasoning: [String: Any] = ["type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "opaque"]
        let fc: [String: Any] = ["type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "calendar_list_events", "arguments": #"{"start":"a","end":"b"}"#, "status": "completed"]
        func event(_ object: [String: Any]) -> String { String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)! }
        try! stream.accept(event(["type": "response.completed", "response": ["status": "completed", "output": [reasoning, fc]]]))
        assert(stream.completed && stream.functionCalls == [ResponsesFunctionCall(callID: "call_1", name: "calendar_list_events", arguments: #"{"start":"a","end":"b"}"#)])
        assert(stream.outputItems.count == 2)

        // Canonical output missing: fall back to finished streamed items in order.
        var streamed = ChatGPTStream()
        try! streamed.accept(event(["type": "response.output_item.done", "output_index": 1, "item": fc]))
        try! streamed.accept(event(["type": "response.output_item.done", "output_index": 0, "item": reasoning]))
        try! streamed.accept(event(["type": "response.completed", "response": ["status": "completed", "output": []]]))
        assert(streamed.outputItems.first?["type"] as? String == "reasoning" && streamed.functionCalls.count == 1)

        // Unfinished function calls are refused rather than executed.
        var unfinished = ChatGPTStream()
        var pending = fc; pending["status"] = "in_progress"
        do { try unfinished.accept(event(["type": "response.completed", "response": ["status": "completed", "output": [pending]]])); assert(false, "must refuse") } catch {}
        assert(unfinished.functionCalls.isEmpty || !unfinished.completed)

        // Plain text replies expose no calls.
        var text = ChatGPTStream()
        try! text.accept(event(["type": "response.completed", "response": ["status": "completed", "output": [["type": "message", "content": [["type": "output_text", "text": "你好", "annotations": []]]]]]]))
        assert(text.functionCalls.isEmpty && (try? text.result()) == "你好")

        // Follow-up input replays output items verbatim, then one output per call.
        let previous: [Any] = [["role": "user", "content": "我明天有什么安排"]]
        let next = DeviceToolLoop.followUpInput(previous: previous, output: stream.outputItems, results: [(callID: "call_1", output: #"{"ok":true}"#)])
        assert(next.count == 4)
        assert((next[1] as? [String: Any])?["encrypted_content"] as? String == "opaque")
        assert((next[2] as? [String: Any])?["call_id"] as? String == "call_1")
        let output = next[3] as? [String: Any]
        assert(output?["type"] as? String == "function_call_output" && output?["call_id"] as? String == "call_1" && output?["output"] as? String == #"{"ok":true}"#)

        // Reading permissions must never infer a grant from a device switch.
        let freshReadName = "melo.phone-perms.read-only.\(UUID().uuidString)"
        let freshRead = UserDefaults(suiteName: freshReadName)!
        defer { freshRead.removePersistentDomain(forName: freshReadName) }
        DeviceToolPolicy(enabled: [.contacts]).save(freshRead)
        let readOnly = PhoneAgentPermissions.load(freshRead)
        assert(!readOnly.allows("melo", .contacts), "reading new device settings must not grant personal data to an Agent")
        assert(freshRead.object(forKey: PhoneAgentPermissions.migratedKey) == nil, "read must not mark a migration completed")

        // Per-Agent phone permissions: baseline keeps search/images, never data.
        let perms = UserDefaults(suiteName: "melo.phone-perms.test.\(UUID().uuidString)")!
        var phone = PhoneAgentPermissions.load(perms)
        assert(phone.allowed("writer") == [.network, .generateMedia])
        let device = DeviceToolPolicy(enabled: [.calendar, .contacts])
        assert(phone.devicePolicy(for: "writer", device: device).enabled.isEmpty, "no Agent gets phone data by default")
        phone.set("writer", .calendar, true); phone.set("writer", .network, false); phone.save(perms)
        let reloaded = PhoneAgentPermissions.load(perms)
        assert(reloaded.allows("writer", .calendar) && !reloaded.allows("writer", .network) && reloaded.allows("writer", .generateMedia))
        // Device switch and Agent grant must both allow: reminders granted to the Agent but off on the device stays off.
        phone.set("writer", .reminders, true)
        assert(phone.devicePolicy(for: "writer", device: device).enabled == [.calendar])
        assert(phone.devicePolicy(for: "analyst", device: device).enabled.isEmpty, "grants never leak across Agents")

        // Migration: legacy device-wide kinds go to the default Agent only, once.
        let legacy = UserDefaults(suiteName: "melo.phone-perms.legacy.\(UUID().uuidString)")!
        DeviceToolPolicy(enabled: [.calendar, .location]).save(legacy)
        PhoneAgentPermissions.initializeAtLaunch(legacy)
        let migrated = PhoneAgentPermissions.load(legacy)
        assert(migrated.allowed("melo") == [.network, .generateMedia, .calendar, .location])
        assert(migrated.devicePolicy(for: "writer", device: DeviceToolPolicy(enabled: [.calendar, .location])).enabled.isEmpty)
        var revoked = migrated; revoked.set("melo", .calendar, false); revoked.save(legacy)
        assert(!PhoneAgentPermissions.load(legacy).allows("melo", .calendar), "migration never re-grants after the user revokes")

        // Both first-use orders after application launch must leave new data
        // access denied, including after relaunch and repeated policy reads.
        for readFirst in [false, true] {
            let name = "melo.phone-perms.startup.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: name)!
            defer { defaults.removePersistentDomain(forName: name) }
            PhoneAgentPermissions.initializeAtLaunch(defaults)
            if readFirst { _ = PhoneAgentPermissions.load(defaults) }
            DeviceToolPolicy(enabled: [.contacts]).save(defaults)
            PhoneAgentPermissions.initializeAtLaunch(defaults)
            let effective = PhoneAgentPermissions.load(defaults).devicePolicy(for: "melo", device: DeviceToolPolicy.load(defaults))
            source = FakeSource(); prompts = 0
            out = await DeviceToolRunner.run(call("contacts_search", #"{"query":"fixture"}"#), policy: effective, source: source, approve: approveYes)
            assert(json(out)["error"] as? String == "NOT_ENABLED" && source.reads == 0 && prompts == 0)
        }
        // Existing explicit revocations survive an unfinished migration and
        // subsequent launches; a device-level grant cannot overwrite them.
        let existingName = "melo.phone-perms.existing.\(UUID().uuidString)"
        let existing = UserDefaults(suiteName: existingName)!
        defer { existing.removePersistentDomain(forName: existingName) }
        DeviceToolPolicy(enabled: [.contacts]).save(existing)
        var explicit = PhoneAgentPermissions(); explicit.set("melo", .contacts, false); explicit.save(existing)
        PhoneAgentPermissions.initializeAtLaunch(existing)
        assert(!PhoneAgentPermissions.load(existing).allows("melo", .contacts))
        PhoneAgentPermissions.initializeAtLaunch(legacy)
        assert(!PhoneAgentPermissions.load(legacy).allows("melo", .calendar))

        // The actual UI gate must permit revocation while the device kind is
        // off. Persist it and re-enable the device: the source still cannot run.
        var removable = PhoneAgentPermissions(); removable.set("writer", .contacts, true)
        assert(removable.canEdit("writer", .contacts, device: DeviceToolPolicy()))
        assert(!removable.canEdit("analyst", .contacts, device: DeviceToolPolicy()))
        removable.set("writer", .contacts, false); removable.save(existing)
        let afterRevoke = PhoneAgentPermissions.load(existing)
        let reenabled = afterRevoke.devicePolicy(for: "writer", device: DeviceToolPolicy(enabled: [.contacts]))
        source = FakeSource(); prompts = 0
        out = await DeviceToolRunner.run(call("contacts_search", #"{"query":"fixture"}"#), policy: reenabled, source: source, approve: approveYes)
        assert(json(out)["error"] as? String == "NOT_ENABLED" && source.reads == 0 && prompts == 0)
        assert(afterRevoke.canEdit("writer", .contacts, device: DeviceToolPolicy(enabled: [.contacts])))
        assert(afterRevoke.canEdit("writer", .network, device: DeviceToolPolicy()))

        // A grant revoked mid-reply stops the next call before the data source.
        source = FakeSource(); prompts = 0
        var grant = true
        out = await DeviceToolRunner.run(call("contacts_search", #"{"query":"张"}"#), policy: all, source: source, approve: approveYes, isAllowed: { grant })
        assert(json(out)["ok"] as? Bool == true && source.reads == 1)
        grant = false
        out = await DeviceToolRunner.run(call("contacts_search", #"{"query":"张"}"#), policy: all, source: source, approve: approveYes, isAllowed: { grant })
        assert(json(out)["ok"] as? Bool != true && source.reads == 1)

        print("DeviceToolsTests passed")
    }
}
