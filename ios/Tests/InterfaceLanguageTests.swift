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
        print("Interface language normalization passed")
    }
}
