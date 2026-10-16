#if DEBUG && targetEnvironment(simulator)
import Foundation
import EventKit
import Contacts

/// Simulator-only acceptance against the real EventKit / Contacts / CoreLocation
/// stores (permissions pre-granted with `simctl privacy`). Creates uniquely
/// named fixtures, runs them through DeviceToolRunner, then deletes them.
@MainActor enum DeviceDataVerification {
    // Exercises the actual SwiftUI approval presentation with no account or
    // system-data writes. Only compiled into the simulator Debug build.
    static func approvalStore() -> ChatStore {
        weak var target: ChatStore?
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("device-approval-preview-" + UUID().uuidString)
        let store = ChatStore(directory: root, replyLoader: { _, _ in
            guard let store = target else { throw CancellationError() }
            let allowed = await store.requestDeviceApproval(DeviceActionRequest(tool: "calendar_create_event", title: "新建日程", detail: "确认弹窗测试（不会写入日历）\n明天 09:00–10:00\n地点：测试会议室\n备注：核对全部写入内容"))
            let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/device-approval-verification.json")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: ["resolved": true, "allowed": allowed, "realWrite": false]).write(to: url, options: .atomic)
            return ModelReply(text: allowed ? "已允许测试操作，未写入系统数据。" : "已拒绝测试操作。", sources: [], searched: false)
        })
        target = store
        return store
    }
    static func startApproval(_ store: ChatStore) {
        guard !store.anySending, let chat = store.newChat() else { return }
        store.send("确认弹窗测试", chatID: chat)
    }
    static func run() async {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/device-data-verification.json")
        var result: [String: Any] = ["passed": false]
        let marker = "Melo验证-" + UUID().uuidString.prefix(8)
        let policy = DeviceToolPolicy(enabled: Set(DeviceDataKind.allCases))
        let source = SystemDeviceData.shared
        var approvals: [String] = []
        func run(_ name: String, _ args: [String: Any], approve: Bool = true) async -> [String: Any] {
            let data = try! JSONSerialization.data(withJSONObject: args)
            let output = await DeviceToolRunner.run(ResponsesFunctionCall(callID: UUID().uuidString, name: name, arguments: String(decoding: data, as: UTF8.self)),
                                                    policy: policy, source: source, approve: { approvals.append($0.title); return approve })
            return (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any] ?? [:]
        }
        let iso = { (date: Date) in DeviceToolRunner.format(date) }
        let start = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
        let store = EKEventStore()
        let people = CNContactStore()
        do {
            for kind in DeviceDataKind.allCases { result["access." + kind.rawValue] = await source.requestAccess(kind) }

            // Calendar: declined write leaves nothing; approved write is listed.
            let declined = await run("calendar_create_event", ["title": marker + "-拒绝", "start": iso(start), "end": iso(start.addingTimeInterval(1800))], approve: false)
            guard declined["error"] as? String == "USER_DECLINED" else { throw MeloError.message("declined event: \(declined)") }
            let created = await run("calendar_create_event", ["title": marker, "start": iso(start), "end": iso(start.addingTimeInterval(3600)), "location": "测试地点"])
            guard created["ok"] as? Bool == true else { throw MeloError.message("create event: \(created)") }
            let listed = await run("calendar_list_events", ["start": iso(start.addingTimeInterval(-3600)), "end": iso(start.addingTimeInterval(7200)), "query": "Melo验证"])
            let titles = (listed["events"] as? [[String: Any]] ?? []).compactMap { $0["title"] as? String }
            guard titles.contains(marker), !titles.contains(marker + "-拒绝") else { throw MeloError.message("listed events: \(titles)") }
            result["calendar"] = "declined write absent; approved event created and listed with query"

            // Reminders: create → list → complete → listed as completed.
            let reminder = await run("reminders_create", ["title": marker, "due": iso(start)])
            guard reminder["ok"] as? Bool == true, let id = (reminder["reminder"] as? [String: Any])?["id"] as? String else { throw MeloError.message("create reminder: \(reminder)") }
            let open = await run("reminders_list", ["query": marker])
            guard open["count"] as? Int == 1 else { throw MeloError.message("open reminders: \(open)") }
            let done = await run("reminders_complete", ["id": id])
            guard done["ok"] as? Bool == true else { throw MeloError.message("complete reminder: \(done)") }
            let afterOpen = await run("reminders_list", ["query": marker])
            let afterAll = await run("reminders_list", ["query": marker, "includeCompleted": true])
            guard afterOpen["count"] as? Int == 0, (afterAll["reminders"] as? [[String: Any]])?.first?["completed"] as? Bool == true else { throw MeloError.message("completed reminder: \(afterOpen) \(afterAll)") }
            result["reminders"] = "created, listed, completed after approval; hidden from open list"

            // Contacts: a uniquely named fixture is found by name.
            let contact = CNMutableContact(); contact.givenName = marker; contact.organizationName = "Melo"
            contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: "+61 400 000 000"))]
            let save = CNSaveRequest(); save.add(contact, toContainerWithIdentifier: nil); try people.execute(save)
            let found = await run("contacts_search", ["query": marker])
            guard found["count"] as? Int == 1 else { throw MeloError.message("contacts: \(found)") }
            result["contacts"] = "fixture contact found by name with phone"

            // Location: the simulator's simulated coordinate is returned.
            let place = await run("location_current", [:])
            guard place["ok"] as? Bool == true, place["latitude"] is Double else { throw MeloError.message("location: \(place)") }
            result["location"] = ["latitude": place["latitude"] ?? 0, "longitude": place["longitude"] ?? 0, "place": place["place"] ?? ""]

            result["approvals"] = approvals
            guard approvals == ["新建日程", "新建日程", "新建提醒", "完成提醒"] else { throw MeloError.message("approvals: \(approvals)") }
            result["passed"] = true
        } catch { result["error"] = error.localizedDescription }

        // Cleanup every fixture regardless of outcome.
        let window = store.predicateForEvents(withStart: start.addingTimeInterval(-86_400), end: start.addingTimeInterval(86_400), calendars: nil)
        for event in store.events(matching: window) where (event.title ?? "").hasPrefix(marker) { try? store.remove(event, span: .thisEvent, commit: true) }
        let reminders: [EKReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: store.predicateForReminders(in: nil)) { continuation.resume(returning: $0 ?? []) }
        }
        for item in reminders where (item.title ?? "").hasPrefix(marker) { try? store.remove(item, commit: true) }
        if let contacts = try? people.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: marker), keysToFetch: [CNContactGivenNameKey as CNKeyDescriptor]) {
            let remove = CNSaveRequest(); for contact in contacts { remove.delete(contact.mutableCopy() as! CNMutableContact) }; try? people.execute(remove)
        }
        result["cleanedUp"] = true
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: url, options: .atomic) }
    }
}
#endif
