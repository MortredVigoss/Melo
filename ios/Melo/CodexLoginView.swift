import SwiftUI

struct CodexLoginCard: View {
    @EnvironmentObject var store: ChatStore
    @EnvironmentObject var account: ChatGPTAccount
    @State private var copied = false
    @State private var showAuthorization = false
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            Label(account.signedIn ? "Codex 已连接" : "连接 Codex",systemImage:"person.crop.circle.badge.checkmark").font(.headline)
            Text("用 ChatGPT 账号授权，手机独立完成聊天、看图、搜索和修图。Melo 负责对话与任务执行，API 密钥连接仍可单独选择。")
                .font(.subheadline).foregroundStyle(.secondary)
            Text(account.status).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(account.registrations.enumerated()),id:\.element.id) { index,registration in
                Button { store.cancel(); account.select(registration.id) } label: {
                    HStack {
                        Image(systemName:account.activeID == registration.id ? "checkmark.circle.fill" : "circle")
                        VStack(alignment:.leading,spacing:3) {
                            Text(registration.email).lineLimit(1)
                            Text("账号 \(index+1) · \(registration.refreshToken.isEmpty ? "待授权" : "已保存到本机钥匙串")").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }.font(.subheadline)
                }.disabled(account.busy || store.anySending)
            }
            if let code=account.deviceCode {
                Text(code.userCode).font(.system(size:26,weight:.semibold,design:.monospaced)).tracking(2).textSelection(.enabled).accessibilityLabel("登录验证码 \(code.userCode)")
                HStack {
                    Button(copied ? "已复制" : "复制验证码",systemImage:copied ? "checkmark" : "doc.on.doc") { UIPasteboard.general.string=code.userCode; copied=true }
                    Spacer()
                    Button("打开官方授权页",systemImage:"arrow.up.right") { showAuthorization=true }
                }.font(.subheadline)
                Text("验证码 15 分钟内有效。授权页在 Melo 内打开，关闭网页不会取消登录。若切换到其他应用，回来后会继续等待。网页若提示未开启设备码登录，请在 ChatGPT 安全设置或工作区权限中开启。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("取消本次登录",role:.cancel) { account.cancelLogin() }
            } else if account.busy {
                HStack { ProgressView(); Text("正在连接官方服务…").font(.caption) }
                Button("取消",role:.cancel) { account.cancelLogin() }
            } else {
                Button { copied=false; Task { await account.signIn(existingID:account.activeID) } } label: {
                    Label("使用 ChatGPT 账号登录 Codex",systemImage:"arrow.up.right.circle").font(.subheadline.weight(.semibold)).frame(maxWidth:.infinity,minHeight:48)
                }.buttonStyle(.borderedProminent).tint(meloGold).foregroundStyle(.black).disabled(store.anySending)
                if !account.registrations.isEmpty {
                    Button("登录其他账号") { copied=false; Task { await account.signIn() } }.font(.caption).disabled(store.anySending)
                }
                if account.signedIn {
                    Text(account.imageVerified ? "此账号已成功返回图片" : "登录已完成 · 图片能力等待首次实际生成或编辑验证").font(.caption).foregroundStyle(.secondary)
                    Button("退出此手机的 Codex 登录",role:.destructive) { Task { await account.signOut() } }.font(.caption).disabled(store.anySending)
                }
            }
            if let error=account.error { Text(error).font(.footnote).foregroundStyle(.orange).textSelection(.enabled) }
            Text("使用你的 Codex 订阅额度；具体模型和图像权限由服务端决定。登录本身不会生成图片或发起测试对话。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .sheet(isPresented:$showAuthorization) { SourceBrowser(url:CodexOAuth.verificationURL).ignoresSafeArea() }
        .onChange(of:account.deviceCode?.id) { _, id in
            copied=false
            if id == nil { showAuthorization=false }
        }
    }
}
