import Foundation
import EventKit
import Contacts
import CoreLocation

// iPhone system data behind DeviceDataSource. Permission prompts appear on
// first real use (or when the user enables a kind in settings); Melo never
// reads a kind the user has not switched on (see DeviceToolRunner).
final class SystemDeviceData: DeviceDataSource {
    static let shared = SystemDeviceData()
    private let events = EKEventStore()
    private let people = CNContactStore()
    @MainActor private lazy var locator = OneShotLocator()

    enum Access { case granted, denied, notDetermined }

    func access(_ kind: DeviceDataKind) -> Access {
        switch kind {
        case .calendar:
            switch EKEventStore.authorizationStatus(for: .event) {
            case .fullAccess: return .granted
            case .notDetermined: return .notDetermined
            default: return .denied
            }
        case .reminders:
            switch EKEventStore.authorizationStatus(for: .reminder) {
            case .fullAccess: return .granted
            case .notDetermined: return .notDetermined
            default: return .denied
            }
        case .contacts:
            let status = CNContactStore.authorizationStatus(for: .contacts)
            if status == .authorized { return .granted }
            if #available(iOS 18.0, *), status == .limited { return .granted }
            return status == .notDetermined ? .notDetermined : .denied
        case .location:
            switch CLLocationManager().authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways: return .granted
            case .notDetermined: return .notDetermined
            default: return .denied
            }
        }
    }

    /// Shows the system prompt if needed. Returns whether Melo may read this kind.
    func requestAccess(_ kind: DeviceDataKind) async -> Bool {
        switch access(kind) {
        case .granted: return true
        case .denied: return false
        case .notDetermined: break
        }
        switch kind {
        case .calendar: return (try? await events.requestFullAccessToEvents()) ?? false
        case .reminders: return (try? await events.requestFullAccessToReminders()) ?? false
        case .contacts:
            _ = try? await people.requestAccess(for: .contacts)
            return access(.contacts) == .granted
        case .location: return await locator.authorize()
        }
    }

    private func require(_ kind: DeviceDataKind) async throws {
        try Task.checkCancellation()
        guard await requestAccess(kind) else {
            throw MeloError.message("Melo 没有\(kind.label)权限。请在 iPhone 设置 > 隐私与安全性 > \(kind.label) 中允许 Melo 完全访问后重试。")
        }
        try Task.checkCancellation()
    }

    private func event(_ item: EKEvent) -> DeviceEvent {
        DeviceEvent(id: item.eventIdentifier ?? item.calendarItemIdentifier, title: item.title ?? "", start: item.startDate, end: item.endDate,
                    allDay: item.isAllDay, location: item.location ?? "", calendar: item.calendar?.title ?? "", notes: item.notes ?? "")
    }
    private func reminder(_ item: EKReminder) -> DeviceReminder {
        DeviceReminder(id: item.calendarItemIdentifier, title: item.title ?? "", due: item.dueDateComponents.flatMap { Calendar.current.date(from: $0) },
                       completed: item.isCompleted, list: item.calendar?.title ?? "", notes: item.notes ?? "")
    }

    func events(from start: Date, to end: Date) async throws -> [DeviceEvent] {
        try await require(.calendar)
        let predicate = events.predicateForEvents(withStart: start, end: end, calendars: nil)
        return events.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map(event)
    }

    func createEvent(title: String, start: Date, end: Date, location: String, notes: String) async throws -> DeviceEvent {
        try await require(.calendar)
        guard let calendar = events.defaultCalendarForNewEvents else { throw MeloError.message("iPhone 上没有可写入的默认日历。") }
        let item = EKEvent(eventStore: events)
        item.calendar = calendar; item.title = title; item.startDate = start; item.endDate = end
        if !location.isEmpty { item.location = location }
        if !notes.isEmpty { item.notes = notes }
        try events.save(item, span: .thisEvent, commit: true)
        return event(item)
    }

    func reminders(includeCompleted: Bool) async throws -> [DeviceReminder] {
        try await require(.reminders)
        let predicate = includeCompleted ? events.predicateForReminders(in: nil)
            : events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return await withCheckedContinuation { continuation in
            events.fetchReminders(matching: predicate) { items in
                continuation.resume(returning: (items ?? []).map(self.reminder))
            }
        }
    }

    func createReminder(title: String, due: Date?, notes: String) async throws -> DeviceReminder {
        try await require(.reminders)
        guard let list = events.defaultCalendarForNewReminders() else { throw MeloError.message("iPhone 上没有可写入的默认提醒列表。") }
        let item = EKReminder(eventStore: events)
        item.calendar = list; item.title = title
        if !notes.isEmpty { item.notes = notes }
        if let due { item.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due) }
        try events.save(item, commit: true)
        return reminder(item)
    }

    func completeReminder(id: String) async throws -> DeviceReminder {
        try await require(.reminders)
        guard let item = events.calendarItem(withIdentifier: id) as? EKReminder else { throw MeloError.message("找不到这条提醒，可能已被删除。") }
        item.isCompleted = true
        try events.save(item, commit: true)
        return reminder(item)
    }

    func contacts(matching query: String) async throws -> [DeviceContact] {
        try await require(.contacts)
        let store = people
        return try await Task.detached(priority: .userInitiated) {
            let keys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
                                           CNContactOrganizationNameKey as CNKeyDescriptor,
                                           CNContactPhoneNumbersKey as CNKeyDescriptor,
                                           CNContactEmailAddressesKey as CNKeyDescriptor]
            let found = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: keys)
            return found.prefix(20).map { contact in
                DeviceContact(name: CNContactFormatter.string(from: contact, style: .fullName) ?? "", organization: contact.organizationName,
                              phones: contact.phoneNumbers.map { $0.value.stringValue }, emails: contact.emailAddresses.map { $0.value as String })
            }
        }.value
    }

    func currentPlace() async throws -> DevicePlace {
        try await require(.location)
        let location = try await locator.locate()
        var name = ""
        if let mark = try? await CLGeocoder().reverseGeocodeLocation(location).first {
            name = [mark.name, mark.subLocality, mark.locality, mark.administrativeArea, mark.country]
                .compactMap { $0 }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }.joined(separator: ", ")
        }
        return DevicePlace(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                           accuracy: location.horizontalAccuracy, name: name)
    }
}

/// One-shot when-in-use location with a bounded wait.
@MainActor final class OneShotLocator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var authorization: CheckedContinuation<Bool, Never>?
    private var reading: CheckedContinuation<CLLocation, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }
    private var granted: Bool { [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus) }

    func authorize() async -> Bool {
        guard manager.authorizationStatus == .notDetermined else { return granted }
        guard authorization == nil else { return false }
        return await withCheckedContinuation { continuation in
            authorization = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    func locate() async throws -> CLLocation {
        guard granted else { throw MeloError.message("Melo 没有定位权限。") }
        guard reading == nil else { throw MeloError.message("正在读取位置，请稍后再试。") }
        let timeout = Task { [weak self] in
            try await Task.sleep(for: .seconds(15))
            self?.finish(.failure(MeloError.message("读取位置超时，请到信号较好的地方再试。")))
        }
        defer { timeout.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            reading = continuation
            manager.requestLocation()
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        guard let reading else { return }
        self.reading = nil
        reading.resume(with: result)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard status != .notDetermined, let authorization = self.authorization else { return }
            self.authorization = nil
            authorization.resume(returning: [.authorizedWhenInUse, .authorizedAlways].contains(status))
        }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in self.finish(.success(location)) }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(.failure(MeloError.message("读取位置失败：\(error.localizedDescription)"))) }
    }
}
