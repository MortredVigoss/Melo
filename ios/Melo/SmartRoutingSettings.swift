import SwiftUI

struct SmartRoutingSettings: View {
    @EnvironmentObject var account: ChatGPTAccount
    @State private var connections: [LLMConnection] = []
    private var candidates: [PhoneRoutingCandidate] {
        var result = connections.flatMap { connection in
            Array(Set((connection.models ?? []) + [connection.model])).filter { !$0.isEmpty }.sorted().map {
                PhoneRoutingCandidate(connectionId: connection.id, model: $0, name: connection.name, contextWindow: connection.contextWindows?[$0] ?? 0, available: !connection.key.isEmpty)
            }
        }
        if account.signedIn {
            let models = Set(account.models.map(\.slug) + [UserDefaults.standard.string(forKey: "chatgptModel") ?? ""])
            result += models.filter { !$0.isEmpty }.sorted().map { PhoneRoutingCandidate(connectionId: "chatgpt", model: $0, name: "Codex") }
        }
        return result
    }
    var body: some View {
        EditableSection("智能模式", read: { PhoneRoutingPolicy.read() }, commit: { value in
            let keys = Set(candidates.map(\.id))
            guard value.tiers.values.flatMap({ $0 }).allSatisfy({ keys.contains($0.connectionId + ":" + $0.model) }) else { throw MeloError.message("模型目录已改变，请重新选择。") }
            return try PhoneRoutingPolicy.save(value)
        }) { value, _ in
            Picker("默认模式", selection: value.defaultMode) { Text("固定模型").tag("fixed"); Text("智能（自动）").tag("smart") }
            Picker("选择偏好", selection: value.preference) { Text("节省成本").tag("cost"); Text("均衡").tag("balanced"); Text("质量优先").tag("quality") }
            Toggle("允许智能模式向其他已保存连接发送内容", isOn: value.allowCrossConnection)
            Toggle("允许本轮任务最多升档一次", isOn: value.allowEscalation)
            Text("Agent 已指定固定模型时，智能模式沿用该模型。只配置一个可用模型时等同固定模型，不额外请求判断。").font(.caption).foregroundStyle(.secondary)
            ForEach(["light", "standard", "strong"], id: \.self) { tier in
                VStack(alignment: .leading, spacing: 8) {
                    Text(tier == "light" ? "轻" : tier == "standard" ? "标准" : "强").font(.headline)
                    ForEach(candidates.sorted { a, b in
                        let rows = value.wrappedValue.tiers[tier, default: []]
                        return (rows.firstIndex { $0.connectionId == a.connectionId && $0.model == a.model } ?? Int.max) < (rows.firstIndex { $0.connectionId == b.connectionId && $0.model == b.model } ?? Int.max)
                    }) { candidate in
                        Toggle(candidate.name + " · " + candidate.model, isOn: Binding(get: {
                            value.wrappedValue.tiers[tier, default: []].contains { $0.connectionId == candidate.connectionId && $0.model == candidate.model }
                        }, set: { checked in
                            var rows = value.wrappedValue.tiers[tier, default: []].filter { !($0.connectionId == candidate.connectionId && $0.model == candidate.model) }
                            if checked { rows.append(candidate.assignment) }; value.wrappedValue.tiers[tier] = rows
                        }))
                        if let index = value.wrappedValue.tiers[tier]?.firstIndex(where: { $0.connectionId == candidate.connectionId && $0.model == candidate.model }) {
                            HStack {
                                Button("↑") { value.wrappedValue.tiers[tier]?.swapAt(index, index - 1) }.disabled(index == 0)
                                Text("\(index + 1)")
                                Button("↓") { value.wrappedValue.tiers[tier]?.swapAt(index, index + 1) }.disabled(index >= value.wrappedValue.tiers[tier, default: []].count - 1)
                            }.buttonStyle(.borderless)
                            Toggle("支持图片理解", isOn: Binding(get: { value.wrappedValue.tiers[tier]?[index].vision ?? false }, set: { value.wrappedValue.tiers[tier]?[index].vision = $0 })).font(.caption)
                        }
                    }
                }
            }
        }.task {
            connections = (try? LLMConnection.saved()) ?? []
            let defaults = UserDefaults.standard
            let endpoint = defaults.string(forKey: "modelEndpoint") ?? ""
            if defaults.string(forKey: "modelAuthMode") != "chatgpt", !endpoint.isEmpty, !connections.contains(where: { WorkspaceProjection.base($0.baseURL) == WorkspaceProjection.base(endpoint) }) {
                connections.append(LLMConnection(id: "", name: "当前连接", baseURL: endpoint, model: defaults.string(forKey: "modelName") ?? "", key: Secrets.read("modelKey"), apiProtocol: defaults.string(forKey: "modelProtocol") ?? "chat-completions"))
            }
        }
    }
}
