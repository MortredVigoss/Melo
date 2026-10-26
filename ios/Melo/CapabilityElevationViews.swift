import SwiftUI

// Capability elevation UI on the iPhone (2026-10-20): the request card's copy
// and the «临时授权» lists. Strings are the shared contract's source texts and
// the desktop's catalog rows (Localizable.xcstrings is generated from
// desktop-ui/translations.js + ios/native-translations.js), looked up for the
// chosen interface language and then filled, like the desktop's t(key, values).

enum CapabilityCopy {
    private static var bundle: Bundle {
        let language = InterfaceLanguage.resolve(UserDefaults.standard.string(forKey: "melo.interfaceLanguage")).localeID
        return Bundle.main.path(forResource: language, ofType: "lproj").flatMap(Bundle.init(path:)) ?? .main
    }
    static func localized(_ key: String) -> String { bundle.localizedString(forKey: key, value: key, table: nil) }
    static func template(_ key: String, _ values: [String: String]) -> String { AgentLoopContract.fill(localized(key), values) }
    private static var contract: CapabilityElevationContract { CapabilityElevation.contract }

    /// Atom labels in the interface language, joined with the contract separator.
    static func capability(_ atoms: [String]) -> String {
        CapabilityElevation.sort(atoms).map { atom -> String in
            if let separator = atom.firstIndex(of: ":"), let source = contract.listLabels[String(atom[..<separator])] {
                return template(source, ["id": String(atom[atom.index(after: separator)...])])
            }
            return localized(CapabilityElevation.label(atom))
        }.joined(separator: localized(contract.separator))
    }
    static func title(_ request: CapabilityRequest) -> String {
        localized(request.decision == "elevate-beyond-parent" ? "需要临时授权" : "需要开启能力")
    }
    static func prompt(_ request: CapabilityRequest) -> String {
        let capability = capability(request.atoms)
        return request.decision == "elevate-beyond-parent"
            ? template(contract.texts["beyondParentPrompt"] ?? "", ["agent": request.agentName, "parent": request.parentName ?? "", "capability": capability])
            : template(contract.texts["enableOwnPrompt"] ?? "", ["agent": request.agentName, "capability": capability])
    }
    /// The card body: why, what for, and what each choice changes.
    static func message(_ request: CapabilityRequest) -> String {
        let beyond = request.decision == "elevate-beyond-parent"
        var lines = [localized(beyond ? "超出发起者的能力，仍在这个 Agent 自己的设置范围内" : "这个 Agent 自己的设置没有开启这个能力"),
                     prompt(request), template(contract.texts["toolLine"] ?? "", ["tool": request.toolID])]
        if !beyond && !request.options.contains("always") { lines.append(template(contract.texts["alwaysUnavailable"] ?? "", ["capability": capability(request.atoms)])) }
        lines.append(localized(beyond
            ? "授权只对这个 Agent 有效，可在 Agent 页“这台手机上”下方或设置 > 权限与文件里随时撤销；撤销从下一次工具调用起生效。"
            : "「一直开启」会修改这个 Agent 在这台手机上的权限；「仅本次」只在这次任务中有效。"))
        return lines.joined(separator: "\n\n")
    }
    static func option(_ request: CapabilityRequest, _ option: String) -> String {
        localized(CapabilityElevation.optionLabel(request.decision, option, projectOptionScope: request.projectOptionScope ?? "project"))
    }
    static func scope(_ grant: CapabilityGrant) -> String {
        localized(grant.scope == "run" ? CapabilityElevation.optionLabel(grant.kind, "run") : CapabilityElevation.optionLabel("elevate-beyond-parent", "project", projectOptionScope: grant.scope))
    }
    static func expiry(_ grant: CapabilityGrant) -> String {
        guard grant.scope != "run" else { return localized("任务结束时失效") }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: InterfaceLanguage.resolve(UserDefaults.standard.string(forKey: "melo.interfaceLanguage")).localeID)
        formatter.setLocalizedDateFormatFromTemplate("MdHHmm")
        return template("到期 {time}", ["time": formatter.string(from: Date(timeIntervalSince1970: grant.expiresAt / 1000))])
    }
    static func kind(_ grant: CapabilityGrant) -> String { localized(grant.kind == "enable-own" ? "超出自身设置" : "超出发起者") }
}

/// One active grant with its revoke button.
struct CapabilityGrantRow: View {
    @EnvironmentObject var store: ChatStore
    let grant: CapabilityGrant
    @Binding var notice: String?
    var body: some View {
        let name = store.preferences.agents.first { $0.id == grant.agentId }?.name ?? grant.agentId
        let capability = CapabilityCopy.capability(grant.atoms)
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: name + " · " + capability).font(.subheadline)
                Text(verbatim: [CapabilityCopy.scope(grant), CapabilityCopy.expiry(grant), CapabilityCopy.kind(grant)].joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button(role: .destructive) {
                if store.revokeCapabilityGrant(grant.id) { notice = CapabilityCopy.localized("已撤销临时授权，下一次工具调用起生效。") }
            } label: { Text("撤销").frame(minHeight: 44) }
                .buttonStyle(.borderless)
                .accessibilityLabel(CapabilityCopy.template("撤销 {agent} 的『{capability}』临时授权", ["agent": name, "capability": capability]))
                .accessibilityIdentifier("capability-grant.revoke." + grant.id)
        }
    }
}

/// «临时授权» for one Agent, in its form (Agent page, below “这台手机上”).
struct CapabilityGrantsSection: View {
    @EnvironmentObject var store: ChatStore
    let agentID: String
    @State private var notice: String?
    var body: some View {
        let _ = store.capabilityGrantsRevision
        let grants = store.capabilityGrants(agentID: agentID)
        Section {
            Text("对话中临时允许的能力。任务结束、到期或撤销后失效；撤销从下一次工具调用起生效。").font(.caption).foregroundStyle(.secondary)
            if grants.isEmpty { Text("这个 Agent 还没有临时授权。").font(.caption).foregroundStyle(.secondary) }
            ForEach(grants) { grant in CapabilityGrantRow(grant: grant, notice: $notice) }
            if let notice { Text(verbatim: notice).font(.caption).foregroundStyle(.green).accessibilityAddTraits(.updatesFrequently) }
        } header: { Text("临时授权") }
        .accessibilityIdentifier("capability-grants.agent")
    }
}

/// «临时授权» for every Agent (设置 > 权限与文件).
struct CapabilityGrantsPanel: View {
    @EnvironmentObject var store: ChatStore
    @State private var notice: String?
    var body: some View {
        let _ = store.capabilityGrantsRevision
        let grants = store.capabilityGrants()
        VStack(alignment: .leading, spacing: 12) {
            Label("临时授权", systemImage: "clock.badge.checkmark").font(.headline)
            Text("对话中临时允许的能力。任务结束、到期或撤销后失效；撤销从下一次工具调用起生效。").font(.caption).foregroundStyle(.secondary)
            if grants.isEmpty { Text("还没有临时授权。").font(.caption).foregroundStyle(.secondary) }
            ForEach(grants) { grant in CapabilityGrantRow(grant: grant, notice: $notice) }
            if let notice { Text(verbatim: notice).font(.caption).foregroundStyle(.green) }
        }.meloPanel().accessibilityElement(children: .contain).accessibilityIdentifier("capability-grants.all")
    }
}
