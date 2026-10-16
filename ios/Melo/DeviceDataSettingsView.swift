import SwiftUI
import UIKit

/// Device-local switches for phone data tools. Off by default; turning one on
/// asks iOS for permission right away so the prompt appears in context.
struct DeviceDataSettings: View {
    @State private var policy = DeviceToolPolicy.load()
    @State private var requesting: DeviceDataKind?
    @State private var denied: DeviceDataKind?

    private func binding(_ kind: DeviceDataKind) -> Binding<Bool> {
        Binding(get: { policy.enabled.contains(kind) }, set: { on in
            denied = nil
            guard on else { policy.enabled.remove(kind); policy.save(); return }
            requesting = kind
            Task { @MainActor in
                let granted = await SystemDeviceData.shared.requestAccess(kind)
                requesting = nil
                if granted { policy.enabled.insert(kind); policy.save() }
                else { denied = kind }
            }
        })
    }

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                Text("开启后，Melo 在回答需要时读取这些数据。新建或修改数据前每次都会请你确认。设置只保存在这台 iPhone，不会同步。")
                    .font(.caption).foregroundStyle(.secondary)
                Text("读取结果会随本次请求发送给当前模型服务；关闭开关可停止后续访问。")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(DeviceDataKind.allCases) { kind in
                    Toggle(isOn: binding(kind)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(LocalizedStringKey(kind.label), systemImage: kind.symbol).font(.subheadline)
                            Text(LocalizedStringKey(kind.detail)).font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(requesting != nil)
                }
                if let denied { Text("iOS 未授予\(Text(LocalizedStringKey(denied.label)))权限。可在 iPhone 设置中允许 Melo 后再开启。").font(.caption).foregroundStyle(.orange) }
                Text("目前在 Codex 登录的对话中可用；API 连接暂不调用手机数据。").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 16)
            Button("打开系统权限设置") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }.padding(.top, 12)
        } label: { Label("手机数据", systemImage: "iphone").font(.headline) }
        .meloPanel()
        .onAppear {
            // Drop switches whose system permission was revoked in iPhone Settings.
            let revoked = policy.enabled.filter { SystemDeviceData.shared.access($0) == .denied }
            if !revoked.isEmpty { policy.enabled.subtract(revoked); policy.save() }
        }
    }
}
