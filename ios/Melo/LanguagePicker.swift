import SwiftUI

struct InterfaceLanguageMenu: View {
    @AppStorage("melo.interfaceLanguage") private var language = "zh-CN"
    var body: some View {
        Menu {
            Picker("界面语言", selection: $language) {
                ForEach(InterfaceLanguage.allCases) { value in Text(verbatim: value.name).tag(value.rawValue) }
            }
        } label: {
            Label(InterfaceLanguage.resolve(language).name, systemImage: "globe")
                .font(.caption).padding(.horizontal, 12).frame(minHeight: 44)
                .background(MeloTheme.card, in: Capsule())
                .overlay(Capsule().stroke(MeloTheme.edge))
        }.accessibilityLabel("切换语言")
    }
}
