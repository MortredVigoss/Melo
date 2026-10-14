import SwiftUI
import SafariServices

struct SourcePage: Identifiable {
    let id = UUID()
    let url: URL
}

// System-managed browser sheet: closing it returns to the unchanged conversation.
struct SourceBrowser: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        return controller
    }
    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
