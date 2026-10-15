import Foundation

enum InterfaceLanguage: String, CaseIterable, Identifiable {
    case chinese = "zh-CN", english = "en", korean = "ko", japanese = "ja", spanish = "es"
    var id: String { rawValue }
    var name: String {
        switch self { case .chinese: return "简体中文"; case .english: return "English"; case .korean: return "한국어"; case .japanese: return "日本語"; case .spanish: return "Español" }
    }
    var localeID: String { self == .chinese ? "zh-Hans" : rawValue }
    static func resolve(_ value: String?) -> Self { Self(rawValue: value ?? "") ?? .chinese }
}
