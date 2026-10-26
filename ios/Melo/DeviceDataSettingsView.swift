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
                Text("还需要在 Agent 页的“这台手机上”为每个 Agent 单独授权。")
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
                Text("Codex 登录与 API 密钥连接的对话都可以调用这些数据。").font(.caption).foregroundStyle(.secondary)
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

/// Per-Agent permissions for execution on this iPhone. Applies immediately,
/// stays on this device, and is independent of the desktop capability range.
struct PhoneAgentPermissionsSection: View {
    let agentID: String
    @State private var permissions = PhoneAgentPermissions.load()
    @State private var device = DeviceToolPolicy.load()

    private func binding(_ capability: PhoneCapability) -> Binding<Bool> {
        Binding(get: { permissions.allows(agentID, capability) }, set: { on in
            permissions.set(agentID, capability, on); permissions.save()
        })
    }
    var body: some View {
        Section(LocalizedStringKey(InterfaceTerm.device.key)) {
            Text("只在这台 iPhone 上生效，立即保存，不同步。手机数据还需要在设置 > 手机数据中开启对应类型。").font(.caption).foregroundStyle(.secondary)
            ForEach(PhoneCapability.allCases) { capability in
                let unavailable = capability.deviceKind.map { !device.enabled.contains($0) } ?? false
                Toggle(isOn: binding(capability)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(LocalizedStringKey(capability.label), systemImage: capability.symbol)
                        if let detail = capability.detail { Text(LocalizedStringKey(detail)).font(.caption).foregroundStyle(.secondary) }
                        if unavailable { Text("设置中尚未开启").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .disabled(!permissions.canEdit(agentID, capability, device: device))
                .accessibilityIdentifier("phone-permission." + capability.rawValue)
            }
        }
        .onAppear { permissions = PhoneAgentPermissions.load(); device = DeviceToolPolicy.load() }
    }
}
