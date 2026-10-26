import Foundation
@main struct InterfaceLanguageTests {
    static func main() {
        assert(InterfaceLanguage.allCases.count == 5)
        assert(InterfaceLanguage.resolve(nil) == InterfaceLanguage.system)
        assert(InterfaceLanguage.resolve("unsupported", systemLanguage: "ja_JP") == .japanese)
        assert(InterfaceLanguage.resolve(nil, systemLanguage: "ko-KR") == .korean)
        assert(InterfaceLanguage.resolve(nil, systemLanguage: "fr_FR") == .english)
        assert(InterfaceLanguage.resolve("es-MX", systemLanguage: "ja_JP") == .spanish)
        assert(InterfaceLanguage.resolve("zh-CN").localeID == "zh-Hans")
        for language in InterfaceLanguage.allCases {
            assert(InterfaceLanguage.resolve(language.rawValue) == language)
            assert(!language.name.isEmpty)
        }
        assert(Set(InterfaceTerm.allCases.map(\.rawValue)) == ["knowledge", "artifacts", "conversation", "device"])
        assert(InterfaceTerm.knowledge.key == "知识库")
        assert(InterfaceTerm.artifacts.key == "成果库")
        assert(InterfaceTerm.conversation.key == "对话")
        assert(InterfaceTerm.device.key == "这台手机上")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for language in InterfaceLanguage.allCases {
            let folder = directory.appendingPathComponent(language.localeID + ".lproj")
            try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let strings = NSDictionary(dictionary: ["待授权": "authorized-label-" + language.rawValue, "本机共享": "scope-label-" + language.rawValue])
            assert(strings.write(to: folder.appendingPathComponent("Localizable.strings"), atomically: true))
        }
        let bundle = Bundle(url: directory)!
        for language in InterfaceLanguage.allCases {
            assert(InterfaceCopy.localized("待授权", language: language.rawValue, bundle: bundle) == "authorized-label-" + language.rawValue)
            assert(InterfaceCopy.localized("本机共享", language: language.rawValue, bundle: bundle) == "scope-label-" + language.rawValue)
            assert(InterfaceCopy.localized("用户/Model 原文", language: language.rawValue, bundle: bundle) == "用户/Model 原文")
        }
        print("Interface language normalization and localized labels passed")
    }
}
