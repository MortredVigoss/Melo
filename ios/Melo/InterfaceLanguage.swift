// Generated from shared/protocol/interface-languages.json. Do not edit.
import Foundation

enum InterfaceLanguage: String, CaseIterable, Identifiable {
    case chinese = "zh-CN", english = "en", korean = "ko", japanese = "ja", spanish = "es"
    var id: String { rawValue }
    var name: String { switch self { case .chinese: return "简体中文"; case .english: return "English"; case .korean: return "한국어"; case .japanese: return "日本語"; case .spanish: return "Español" } }
    var localeID: String { switch self { case .chinese: return "zh-Hans"; case .english: return "en"; case .korean: return "ko"; case .japanese: return "ja"; case .spanish: return "es" } }
    static var system: Self { resolve(nil) }
    static func resolve(_ value: String?, systemLanguage: String = Locale.current.identifier) -> Self {
        func match(_ value: String) -> Self? {
            let base = value.replacingOccurrences(of: "_", with: "-").split(separator: "-").first?.lowercased()
            return allCases.first { $0.rawValue.split(separator: "-").first?.lowercased() == base }
        }
        return value.flatMap(match) ?? match(systemLanguage) ?? .english
    }
}
