import SwiftUI

/// Application-owned form surfaces share the desktop theme. Keep native rows,
/// pickers and keyboard handling; remove only the system grouped background.
struct MeloForm<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        Form { content().listRowBackground(MeloTheme.card) }
            .scrollContentBackground(.hidden)
            .background(Color.clear)
            .tint(MeloTheme.gold)
    }
}
