import Foundation
@main struct InterfaceLanguageTests {
    static func main() {
        assert(InterfaceLanguage.allCases.count == 5)
        assert(InterfaceLanguage.resolve(nil) == .chinese)
        assert(InterfaceLanguage.resolve("unsupported") == .chinese)
        assert(InterfaceLanguage.resolve("zh-CN").localeID == "zh-Hans")
        for language in InterfaceLanguage.allCases {
            assert(InterfaceLanguage.resolve(language.rawValue) == language)
            assert(!language.name.isEmpty)
        }
        print("Interface language normalization passed")
    }
}
