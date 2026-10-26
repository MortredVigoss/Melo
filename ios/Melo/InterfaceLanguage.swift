// Generated from shared/protocol/interface-languages.json and interface-terms.json. Do not edit.
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

enum InterfaceTerm: String, CaseIterable {
    case knowledge, artifacts, conversation, device
    var key: String { switch self { case .knowledge: return "知识库"; case .artifacts: return "成果库"; case .conversation: return "对话"; case .device: return "这台手机上" } }
}

enum InterfaceCopy {
    static func localized(_ key: String, language: String? = UserDefaults.standard.string(forKey: "melo.interfaceLanguage"), bundle: Bundle = .main) -> String {
        let locale = InterfaceLanguage.resolve(language).localeID
        let localized = bundle.path(forResource: locale, ofType: "lproj").flatMap(Bundle.init(path:)) ?? bundle
        return localized.localizedString(forKey: key, value: key, table: nil)
    }
}
