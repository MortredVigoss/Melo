import SwiftUI

struct NeuralModule: Identifiable {
    let id: Int
    let name: String
    let english: String
    let symbol: String
    let x: Double
    let y: Double
    var color: Color { MeloTheme.neuralColors[Self.all.firstIndex(where: { $0.id == id }) ?? 0] }
    static let all = [
        NeuralModule(id: 1, name: InterfaceTerm.conversation.key, english: "CONVERSATIONS", symbol: "bubble.left", x: 0.20, y: 0.22),
        NeuralModule(id: 4, name: "项目", english: "PROJECTS", symbol: "square.stack.3d.up", x: 0.78, y: 0.24),
        NeuralModule(id: 2, name: "Agent", english: "AGENTS", symbol: "sparkles", x: 0.85, y: 0.48),
        NeuralModule(id: 5, name: InterfaceTerm.knowledge.key, english: "KNOWLEDGE", symbol: "point.3.connected.trianglepath.dotted", x: 0.68, y: 0.72),
        NeuralModule(id: 3, name: "系统", english: "SYSTEM", symbol: "slider.horizontal.3", x: 0.18, y: 0.66)
    ]
}

// A single WKWebView persists across navigation; desktop code supplies its geometry,
// topology, colors and motion. Native views remain accessible navigation targets.
struct NeuralField: View {
    var selected: Int
    var transmitting: Bool
    var compact: Bool
    var moduleFrames: [Int: CGRect]
    var hover: Int
    var tap: NeuralTap?
    var select: (Int) -> Void
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("melo.reduceMotion") private var localReduceMotion = false
    private var reduceMotion: Bool { systemReduceMotion || localReduceMotion }
    @Environment(\.scenePhase) private var phase
    @State private var failed = false
    @State private var generation = 0
    var body: some View {
        ZStack(alignment: .top) {
            NeuralWebView(selected: selected, transmitting: transmitting, compact: compact, frames: moduleFrames, hover: hover, tap: tap,
                still: reduceMotion || phase != .active, select: select, failure: { failed = true }, loaded: { failed = false }).id(generation)
                .allowsHitTesting(false).accessibilityHidden(true)
            if failed {
                Button("重新加载神经场景") { failed = false; generation += 1 }
                    .font(.caption2).padding(8).background(meloBackground, in: Capsule()).padding(.top, compact ? 0 : 76)
            }
        }
    }
}

struct NeuralTap {
    let id = UUID().uuidString
    var point: CGPoint
}

struct NeuralPressStyle: ButtonStyle {
    var id: Int
    var hover: (Int) -> Void
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 1 : 0.90)
            .onChange(of: configuration.isPressed) { _, pressed in hover(pressed ? id : -1) }
    }
}
