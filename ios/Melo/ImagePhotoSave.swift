import Foundation
import Combine

// One device-local receipt per immutable image ID, shared by all save entry points.
// This records successful exports; it does not request read access to the photo library.
@MainActor final class ImagePhotoSaveStore: ObservableObject {
    static let shared = ImagePhotoSaveStore(defaults: .standard)
    static let receiptKey = "melo.localPhotoSaveReceipts.v1"
    @Published private(set) var savedIDs: Set<String>
    @Published private(set) var savingIDs: Set<String> = []
    private let defaults: UserDefaults

    enum Outcome: Equatable { case saved, needsConfirmation, alreadySaving }

    init(defaults: UserDefaults) {
        self.defaults = defaults
        savedIDs = Set(defaults.stringArray(forKey: Self.receiptKey) ?? [])
    }

    func save(id: String, confirmedRepeat: Bool = false, write: () async throws -> Void) async throws -> Outcome {
        // Claim before the first suspension, including the permission prompt.
        guard !savingIDs.contains(id) else { return .alreadySaving }
        guard confirmedRepeat || !savedIDs.contains(id) else { return .needsConfirmation }
        savingIDs.insert(id)
        defer { savingIDs.remove(id) }
        try Task.checkCancellation()
        try await write()
        // Only Photos' successful completion creates a receipt. Do not check cancellation
        // here: the photo may already exist even if its originating view disappeared.
        savedIDs.insert(id)
        defaults.set(savedIDs.sorted(), forKey: Self.receiptKey)
        return .saved
    }
}
