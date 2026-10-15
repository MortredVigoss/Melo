import SwiftUI

struct MeloInput: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(12).frame(minHeight: 44)
            .background(MeloTheme.inset, in: RoundedRectangle(cornerRadius: MeloTheme.controlRadius))
            .overlay(RoundedRectangle(cornerRadius: MeloTheme.controlRadius).stroke(MeloTheme.edge))
    }
}
extension View { func meloInput() -> some View { modifier(MeloInput()) } }

struct MobileConnectionStatus: View {
    @EnvironmentObject var account: ChatGPTAccount
    @AppStorage("modelAuthMode") private var authMode = "chatgpt"
    @AppStorage("modelName") private var model = ""
    @AppStorage("chatgptModel") private var chatGPTModel = ""
    @AppStorage("activeLLMConnection") private var active = ""
    @AppStorage("modelEndpoint") private var activeEndpoint = ""
    @AppStorage("modelProtocol") private var activeProtocol = "chat-completions"
    private var selected: LLMConnection? { try? LLMConnection.saved().first { $0.id == active } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Image(systemName: "cpu").foregroundStyle(meloGold)
                VStack(alignment: .leading, spacing: 6) {
                    Text(authMode == "chatgpt" ? "Codex 登录" : selected?.name ?? "API 连接").font(.headline)
                    Text(authMode == "chatgpt" ? (chatGPTModel.isEmpty ? "尚未选择模型" : chatGPTModel) : (model.isEmpty ? "尚未选择模型" : model)).font(.subheadline).foregroundStyle(MeloTheme.muted).textSelection(.enabled)
                }
            }
            Text(status).font(.caption).foregroundStyle(MeloTheme.soft)
            Text("模型提供推理；对话、Agent和执行记录由 Melo 管理。").font(.caption).foregroundStyle(MeloTheme.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var status: String {
        if authMode == "chatgpt" { return account.signedIn ? "授权已保存 · 以实际请求结果确认可用性" : "尚未授权 · 在下方登录" }
        guard let connection = selected, !activeEndpoint.isEmpty, !model.isEmpty else { return "请在下方选择平台并测试连接" }
        return connection.probe?.matches(endpoint: activeEndpoint, model: model, apiProtocol: activeProtocol, key: Secrets.read("modelKey")) == true ? "此配置的模型请求已通过测试" : "配置已保存 · 尚未通过实际请求测试"
    }
}
