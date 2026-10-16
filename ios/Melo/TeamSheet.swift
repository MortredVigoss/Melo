import SwiftUI

/// Chooses a team for the next message. Members come from the lead's synced
/// delegation targets (same rule as the desktop) and run in tick order.
struct TeamSheet: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    let chatID: String
    @State private var order: [String] = []
    @State private var templateID = "research-build-review"
    @State private var loaded = false
    private var lead: AgentProfile { store.agent(for: chatID) }
    private func name(_ id: String) -> String { store.preferences.agents.first { $0.id == id }?.name ?? id }
    private var problem: String? {
        guard !order.isEmpty else { return "请至少勾选一位成员。" }
        if templateID == "review-loop" && order.count != 2 { return "实施 / 复核循环需要正好勾选两位成员。" }
        return nil
    }
    var body: some View {
        NavigationStack {
            MeloForm {
                switch store.teamState(for: chatID) {
                case .delegateOff:
                    Section { Text("「\(lead.name)」未开启委派。请在电脑的 Agent 设置里开启“委派”，并勾选可以协作的 Agent；设置会同步到这台手机。").foregroundStyle(.secondary) }
                case .noTargets:
                    Section { Text("「\(lead.name)」还没有可协作的 Agent。请在电脑的 Agent 设置里勾选委派对象；设置会同步到这台手机。").foregroundStyle(.secondary) }
                case .ready(let targets):
                    Section { Text("由「\(lead.name)」发起并汇总结果。成员按勾选顺序接力；并行模式下最后一位负责复核；循环模式需要正好两位：先实施，后复核。").font(.footnote).foregroundStyle(.secondary) }
                    Section("成员") {
                        ForEach(targets, id: \.self) { id in
                            Button { toggle(id) } label: {
                                HStack {
                                    Text(name(id)).foregroundStyle(.primary)
                                    Spacer()
                                    if let index = order.firstIndex(of: id) {
                                        Text("\(index + 1)").font(.caption.weight(.semibold)).foregroundStyle(MeloTheme.dialog).frame(width: 22, height: 22).background(meloGold, in: Circle())
                                    } else { Image(systemName: "circle").foregroundStyle(.secondary) }
                                }.frame(minHeight: 36)
                            }.accessibilityLabel(order.firstIndex(of: id).map { "\(name(id))，第 \($0 + 1) 位" } ?? name(id))
                        }
                        if !order.isEmpty { (Text("执行顺序：") + Text(verbatim: order.map(name).joined(separator: " → "))).font(.caption).foregroundStyle(.secondary) }
                    }
                    Section("协作方式") {
                        Picker("协作方式", selection: $templateID) { ForEach(AgentTeam.templates, id: \.id) { Text(LocalizedStringKey($0.label)).tag($0.id) } }.pickerStyle(.inline).labelsHidden()
                    }
                    Section {
                        Text("每位成员在这台手机上单独调用一次模型，只处理文字；联网搜索需要发起者和该成员在“这台手机上”都已开启。整个团队最多 15 分钟。").font(.caption).foregroundStyle(.secondary)
                        Text("只作用于下一条消息，发送后自动取消。").font(.caption).foregroundStyle(.secondary)
                        if let problem { Text(LocalizedStringKey(problem)).font(.caption).foregroundStyle(meloGold) }
                    }
                }
            }
            .navigationTitle("团队")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(store.pendingTeams[chatID] == nil ? "关闭" : "不用团队") { store.armTeam(nil, chatID: chatID); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("用于下一条消息") { store.armTeam(PhoneTeamPlan(templateID: templateID, members: order), chatID: chatID); dismiss() }
                        .disabled(problem != nil || { if case .ready = store.teamState(for: chatID) { return false }; return true }())
                }
            }
            .onAppear {
                guard !loaded else { return }
                loaded = true
                if let armed = store.pendingTeams[chatID] { order = armed.members; templateID = armed.templateID }
            }
        }.presentationBackground(MeloTheme.dialog)
    }
    private func toggle(_ id: String) {
        if let index = order.firstIndex(of: id) { order.remove(at: index) } else { order.append(id) }
    }
}
