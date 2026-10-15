import SwiftUI

let meloAccent = MeloTheme.gold
let meloGold = MeloTheme.gold.opacity(0.85)
let meloBackground = Color(red: 0.025, green: 0.028, blue: 0.035)

struct MeloPanel: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(20).background(MeloTheme.card, in: RoundedRectangle(cornerRadius: MeloTheme.cardRadius))
            .overlay(RoundedRectangle(cornerRadius: MeloTheme.cardRadius).stroke(MeloTheme.edge))
            .shadow(color: .black.opacity(0.15), radius: 18, y: 8)
    }
}
extension View { func meloPanel() -> some View { modifier(MeloPanel()) } }

struct ContentView: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("melo.reduceMotion") private var localReduceMotion = false
    private var reduceMotion: Bool { systemReduceMotion || localReduceMotion }
    @Environment(\.scenePhase) private var scenePhase
    @State private var section = ContentView.previewSection
    private static var previewSection: Int {
        if ProcessInfo.processInfo.arguments.contains("-melo-open-task-space") { return 1 }
        #if DEBUG && targetEnvironment(simulator)
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-melo-preview-section"), args.count > i + 1 { return Int(args[i + 1]) ?? 0 }
        #endif
        return 0
    }
    @State private var path: [String] = []
    @State private var moduleFrames: [Int: CGRect] = [:]
    @State private var hoveredModule = -1
    @State private var openingModule = -1
    @State private var openingTask: Task<Void, Never>?
    @State private var coreTap: NeuralTap?
    private var expanded: Bool { section != 0 || !path.isEmpty }
    private var selected: Int { path.isEmpty ? section : 1 }
    private func selectModule(_ id: Int) {
        openingTask?.cancel()
        coreTap = nil
        openingModule = id
        openingTask = Task { @MainActor in
            // Touch gives the same short alignment reveal as desktop hover.
            if !reduceMotion { do { try await Task.sleep(for: .milliseconds(220)) } catch { return } }
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.45)) { path = []; section = id }
            openingModule = -1; hoveredModule = -1
        }
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                NeuralField(selected: selected, transmitting: store.sendingID != nil, compact: expanded, moduleFrames: moduleFrames, hover: openingModule >= 0 ? openingModule : hoveredModule, tap: coreTap, select: selectModule)
                    .frame(height: geometry.size.height)
                    .mask(alignment: .top) { Rectangle().frame(height: expanded ? 138 : geometry.size.height) }
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.45), value: expanded)
                VStack(spacing: 0) {
                    if expanded {
                        VStack(spacing: 0) {
                            HStack {
                                Button { openingTask?.cancel(); openingModule = -1; coreTap = nil; withAnimation { path = []; section = 0 } } label: { Label("返回中枢", systemImage: "circle.hexagongrid.fill").font(.system(size: 10)).frame(minHeight: 44) }
                                Spacer(minLength: 100)
                            }.padding(.horizontal, 20).frame(height: 70)
                            HStack(spacing: 0) {
                                ForEach(NeuralModule.all) { module in
                                    Button { selectModule(module.id) } label: {
                                        VStack(spacing: 5) {
                                            NeuralGlyphAnchor(module: module, size: 28)
                                            Text(LocalizedStringKey(module.name)).font(.system(size: 11, weight: selected == module.id ? .semibold : .regular))
                                        }.foregroundStyle(module.color.opacity(selected == module.id ? 1 : 0.8))
                                            .frame(maxWidth: .infinity).frame(height: 54).contentShape(Rectangle())
                                    }.buttonStyle(NeuralPressStyle(id: module.id, hover: { hoveredModule = $0 }))
                                        .accessibilityLabel(LocalizedStringKey(module.name)).accessibilityAddTraits(selected == module.id ? .isSelected : [])
                                }
                            }.padding(.horizontal, 10)
                            Spacer(minLength: 0)
                        }.frame(height: 138).overlay(alignment: .bottom) { Rectangle().fill(meloGold.opacity(0.16)).frame(height: 0.5) }
                    }
                    Group {
                        if let chatID = path.last { ChatView(chatID: chatID).id(chatID) }
                        else { switch section {
                        case 1: ConversationWorkspace()
                        case 2: AgentsView { path.append($0) }
                        case 3: SettingsContent()
                        case 4: ProjectsView(open: { path.append($0) })
                        case 5: KnowledgeView()
                        default: HomeView(open: { path.append($0) }, select: selectModule, hover: { hoveredModule = $0 })
                            .contentShape(Rectangle())
                            .simultaneousGesture(SpatialTapGesture(coordinateSpace: .named("neuralHeader")).onEnded { coreTap = NeuralTap(point: $0.location) })
                        } }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity).background(expanded ? meloBackground : .clear)
                }
                .alert("Melo", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) { Button("知道了") { store.error = nil } } message: { Text(store.error ?? "") }
            }
        }
        .coordinateSpace(name: "neuralHeader").onPreferenceChange(ModuleFrameKey.self) { moduleFrames = $0 }.background(meloBackground.ignoresSafeArea()).tint(meloAccent)
            .onDisappear { openingTask?.cancel() }
            .onChange(of: path) { _, value in if !value.isEmpty { openingTask?.cancel(); openingModule = -1 } }
            .onChange(of: scenePhase) { _, value in if value != .active { openingTask?.cancel(); openingModule = -1; hoveredModule = -1; coreTap = nil } }
    }
}

struct ModuleFrameKey: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, new in new }) }
}

struct NeuralGlyphAnchor: View {
    let module: NeuralModule
    let size: CGFloat
    var body: some View {
        Color.clear.frame(width: size, height: size)
            .background(GeometryReader { proxy in Color.clear.preference(key: ModuleFrameKey.self, value: [module.id: proxy.frame(in: .named("neuralHeader"))]) })
            .accessibilityHidden(true)
    }
}

struct PageHeading: View {
    let eyebrow: String
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(eyebrow).font(.system(size: 10, weight: .semibold)).tracking(3).foregroundStyle(meloAccent)
            Text(LocalizedStringKey(title)).font(.system(size: 28, weight: .medium, design: .rounded))
            Text(LocalizedStringKey(detail)).font(.subheadline).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct HomeView: View {
    @EnvironmentObject var store: ChatStore
    @EnvironmentObject var account: ChatGPTAccount
    @AppStorage("modelAuthMode") private var authMode = "chatgpt"
    @AppStorage("modelName") private var apiModel = ""
    let open: (String) -> Void
    let select: (Int) -> Void
    let hover: (Int) -> Void
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ForEach(NeuralModule.all) { module in
                    Button { select(module.id) } label: {
                        VStack(spacing: 7) {
                            NeuralGlyphAnchor(module: module, size: 60)
                            Text(LocalizedStringKey(module.name)).font(.system(size: 15, weight: .medium)).foregroundStyle(module.color)
                            if geometry.size.height >= 600 { Text(module.english).font(.system(size: 7)).tracking(1).foregroundStyle(module.color.opacity(0.66)) }
                        }.frame(width: 94).contentShape(Rectangle())
                    }.buttonStyle(NeuralPressStyle(id: module.id, hover: hover)).accessibilityLabel(LocalizedStringKey(module.name))
                        .position(x: geometry.size.width * module.x, y: geometry.size.height < 600 ? min(max(128, geometry.size.height * module.y), geometry.size.height - 165) : geometry.size.height * module.y)
                }
                VStack {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 6) { HStack(spacing: 8) { Image(systemName: "asterisk").font(.system(size: 20, weight: .ultraLight)).foregroundStyle(meloGold); Text("melo").font(.system(size: 27, weight: .light, design: .serif)) }; Text("NEURAL WORKSPACE").font(.system(size: 8)).tracking(2.4).foregroundStyle(meloGold) }
                        Spacer()
                        Button { select(3) } label: { LocalProfileBadge(size: 26); Circle().fill((authMode == "api" ? !apiModel.isEmpty : account.signedIn) ? meloGold : Color.secondary).frame(width: 5, height: 5); Text(LocalizedStringKey(authMode == "api" ? (apiModel.isEmpty ? "选择模型" : "API 模型") : account.signedIn ? "ChatGPT" : "连接账号")).font(.caption2).foregroundStyle(.secondary) }
                    }.padding(.horizontal, 26).padding(.top, 14)
                    Spacer()
                    VStack(spacing: 13) {
                        if geometry.size.height >= 600 { Text("选择一个节点，展开思考。").font(.caption).foregroundStyle(Color(red: 0.66, green: 0.62, blue: 0.53)) }
                        Button { if let id = store.newChat() { open(id) } } label: {
                            HStack { Text("从一个想法开始…").font(.subheadline).foregroundStyle(.secondary); Spacer(); Image(systemName: "arrow.up.right").font(.callout).foregroundStyle(meloAccent) }.padding(19).background(meloBackground.opacity(0.42), in: RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(meloGold.opacity(0.3), lineWidth: 0.6))
                        }.disabled(!store.storageReady)
                        HStack { InterfaceLanguageMenu(); Spacer(); VStack(alignment: .trailing, spacing: 4) { Text("\(store.chats.count) 段对话 · \(store.preferences.agents.count) 个角色"); Text("本机工作空间") }.font(.system(size: 9)).foregroundStyle(meloGold.opacity(0.7)) }
                    }.padding(.horizontal, 26).padding(.bottom, 22)
                }
            }
        }
    }
}
struct CoreView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24, paused: reduceMotion)) { timeline in
            Canvas { context, size in
                let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                for index in 0..<740 {
                    let fraction = Double(index) / 740
                    let radius = sqrt(fraction) * min(size.width, size.height) * 0.48
                    let angle = Double(index) * 2.399963 + time * (0.045 + fraction * 0.03)
                    let x = center.x + cos(angle) * radius
                    let y = center.y + sin(angle) * radius * 0.8 + sin(time * 0.5 + angle) * 7
                    let diameter = 0.8 + (1 - fraction) * 1.8
                    let opacity = 0.15 + (1 + sin(angle + time * 0.45)) * 0.28
                    let color = index % 17 == 0 ? Color(red: 0.35, green: 0.65, blue: 0.67) : index % 3 == 0 ? meloGold : meloAccent
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: diameter, height: diameter)), with: .color(color.opacity(opacity)))
                }
            }
        }
    }
}
struct ConversationRow: View {
    let chat: Conversation
    let agent: AgentProfile
    var pinned = false
    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            AgentAvatar(agent: agent, size: 38)
            VStack(alignment: .leading, spacing: 7) {
                HStack { Text(chat.title).font(.system(size: 15, weight: .medium)).lineLimit(1); if pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(meloGold) } }
                Text(ReplyDocument.plainText(chat.messages.last?.content ?? "等待你的第一个想法")).font(.caption).lineLimit(2).foregroundStyle(.secondary)
                Text("\(agent.name) · \(chat.messages.count) 条消息").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(.tertiary).padding(.top, 4)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 14).padding(.horizontal, 12).background(meloGold.opacity(0.045), in: RoundedRectangle(cornerRadius: 14)).overlay(alignment: .leading) { Rectangle().fill(meloGold.opacity(0.2)).frame(width: 0.5).padding(.vertical, 8) }
    }
}


struct AgentsView: View {
    @EnvironmentObject var store: ChatStore
    let open: (String) -> Void
    @State private var editing: AgentProfile?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeading(eyebrow: "AGENTS", title: "不同角色，同样默契。", detail: "为每一种工作，选择合适的思考方式。")
                ForEach(store.preferences.agents) { agent in
                    VStack(alignment: .leading, spacing: 18) {
                        HStack { AgentAvatar(agent: agent, size: 48); Spacer(); Button { editing = agent } label: { Image(systemName: "slider.horizontal.3").foregroundStyle(.secondary).padding(8) }.accessibilityLabel("查看\(agent.name)") }
                        VStack(alignment: .leading, spacing: 6) { Text(agent.name).font(.title3.weight(.medium)); Text(agent.subtitle).font(.caption).foregroundStyle(meloGold); Text(agent.instructions).font(.subheadline).foregroundStyle(.secondary).lineLimit(3).padding(.top, 4) }
                        Button { if let id = store.newChat(agentID: agent.id) { open(id) } } label: { HStack { Text("与\(agent.name)对话"); Spacer(); Image(systemName: "arrow.up.right") }.font(.subheadline.weight(.medium)).foregroundStyle(meloAccent) }
                    }.meloPanel()
                }
                Button { editing = AgentProfile(name: "", subtitle: "", symbol: "person.crop.square", instructions: "") } label: { Label("创建你的角色", systemImage: "plus").font(.subheadline.weight(.medium)).frame(maxWidth: .infinity).padding(20).background(meloAccent.opacity(0.1), in: RoundedRectangle(cornerRadius: 20)) }
                Text("角色名称、定位和回复要求会随每轮消息生效。可直接在对话中切换角色；配置与头像保存在本机。").font(.caption).foregroundStyle(.secondary)
            }.padding(20)
        }.sheet(item: $editing) { agent in AgentEditor(agent: agent, isNew: !store.preferences.agents.contains { $0.id == agent.id }).presentationBackground(MeloTheme.dialog) }
    }
}

struct ConversationWorkspace: View {
    @EnvironmentObject var store: ChatStore
    @State private var selected: String?
    var body: some View {
        Group {
            if let selected { ChatView(chatID: selected).id(selected) }
            else { HistoryView { selected = $0 } }

        }.onAppear { if selected == nil { selected = store.chats.first { $0.id == store.selectedConversationID }?.id ?? store.chats.filter { !store.preferences.archivedChats.contains($0.id) }.sorted { $0.updatedAt > $1.updatedAt }.first?.id } }
    }
}
struct ChatView: View {
    @AppStorage("melo.localName") private var localName = "你"
    @AppStorage("melo.autoSpeak") private var autoSpeak = false
    @ObservedObject private var deviceSpeech = LocalDeviceServices.shared
    @EnvironmentObject var store: ChatStore
    @EnvironmentObject var account: ChatGPTAccount
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var voiceInput = VoiceInput(engine: SystemSpeechInput())
    @AppStorage("melo.voiceLanguage") private var voiceLanguage = "zh-CN"
    @State var chatID: String
    @State private var historyVisible = ChatView.previewHistory
    private static var previewHistory: Bool {
        #if DEBUG && targetEnvironment(simulator)
        return ProcessInfo.processInfo.arguments.contains("-melo-preview-history")
        #else
        return false
        #endif
    }
    @FocusState private var composerFocused: Bool
    private var draft: String {
        get { store.composerDrafts[chatID]?.text ?? "" }
        nonmutating set { store.composerDrafts[chatID, default: ConversationDraft()].text = newValue }
    }
    private var imagePlan: ImageTaskPlan {
        get { store.composerDrafts[chatID]?.imagePlan ?? ImageTaskPlan() }
        nonmutating set { store.composerDrafts[chatID, default: ConversationDraft()].imagePlan = newValue }
    }
    @State private var imagePreview: LocalImage?
    @State private var imageImportID: UUID?
    @State private var settings = false
    @State private var sourcePage: SourcePage?
    @State private var showExecution = false
    @State private var executionRunID: String?
    @State private var renaming = false
    @State private var editedTitle = ""
    private var chat: Conversation? { store.chats.first { $0.id == chatID } }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Button { withAnimation(.easeInOut(duration: 0.3)) { historyVisible.toggle() } } label: { VStack(spacing: 3) { Image(systemName: "sidebar.left").font(.system(size: 18, weight: .light)); Text("历史").font(.system(size: 9)) }.frame(width: 40, height: 44) }.accessibilityLabel("展开历史对话")
                VStack(alignment: .leading, spacing: 3) { Text("WORKSPACE / CHAT").font(.system(size: 8)).tracking(1.5).foregroundStyle(meloGold); Button { editedTitle = chat?.title ?? ""; renaming = true } label: { HStack(spacing: 6) { Text(chat?.title ?? "对话").font(.subheadline).lineLimit(1); Image(systemName: "pencil").font(.caption2).foregroundStyle(meloGold) } }.foregroundStyle(.primary).accessibilityLabel("重命名当前对话") }
                Spacer()
                Button { settings = true } label: { Image(systemName: "slider.horizontal.3").frame(width: 36, height: 38) }.accessibilityLabel("模型设置")
            }.padding(.horizontal, 16).padding(.vertical, 9).background(meloBackground.opacity(0.3)).overlay(alignment: .bottom) { Rectangle().fill(meloGold.opacity(0.13)).frame(height: 0.5) }
            ConversationControls(chatID: chatID, settings: { settings = true })
                .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if chat == nil {
                        Text("这段对话已被删除").foregroundStyle(.secondary)
                        Button("开启新对话") { if let id = store.newChat() { chatID = id } }
                    } else if chat?.messages.isEmpty != false {
                        VStack(alignment: .leading, spacing: 14) {
                            AgentAvatar(agent: store.agent(for: chatID), size: 52).padding(.bottom, 8)
                            Text("对话 / \(store.agent(for: chatID).name)").font(.system(size: 29, weight: .medium, design: .rounded))
                            Text(store.agent(for: chatID).subtitle).font(.subheadline).foregroundStyle(.secondary)
                            ForEach(["帮我梳理一个想法", "一起拟一份今天的计划", "帮我润色一段文字"], id: \.self) { text in Button { draft = text } label: { HStack { Text(text); Spacer(); Image(systemName: "arrow.up.left") }.font(.subheadline).padding(15).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 15)) }.foregroundStyle(.secondary) }
                        }.padding(.top, 45).padding(.horizontal, 8)
                    }
                    ForEach(chat?.messages ?? []) { message in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack { if message.role == "user" { LocalProfileBadge(size: 24) } else if let persona = store.preferences.messageAgents?[message.id], let agent = store.preferences.agents.first(where: { $0.id == persona.agentID }) { AgentAvatar(agent: agent, size: 24) } else { Image(systemName: "sparkles") }; Text(message.role == "user" ? localName : (store.preferences.messageAgents?[message.id]?.name ?? "Melo")).font(.caption.weight(.semibold)); Spacer(); Button { UIPasteboard.general.string = ReplyDocument.plainText(message.content) } label: { Image(systemName: "doc.on.doc").font(.caption2).foregroundStyle(.tertiary) }.accessibilityLabel("复制消息") }.foregroundStyle(message.role == "user" ? Color.secondary : meloAccent)
                            ReplyContentView(content: message.content)
                            MessageImages(messageID: message.id, preview: { imagePreview = $0 }, edit: useImage)
                            if let run = store.execution(for: message.id) {
                                HStack {
                                    Button { executionRunID = run.runId; showExecution = true } label: { Label("回看任务空间", systemImage: "atom").font(.caption) }
                                    Spacer()
                                    Menu {
                                        Text("请求模型：\(run.requestedModel.isEmpty ? "未选择" : run.requestedModel)")
                                        Text("服务返回：\(run.returnedModel ?? "未提供，不推断")")
                                    } label: { Text(run.returnedModel ?? "返回模型未提供").font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1) }.accessibilityLabel("查看本轮模型信息")
                                }
                            }
                            if let receipts = store.preferences.messageModels?[message.id], !receipts.isEmpty {
                                Menu {
                                    ForEach(Array(receipts.enumerated()), id: \.offset) { _, receipt in
                                        if receipt.purpose == "intent-judge" { Text("用途：额外快速 · 意图判断") }
                                        if receipt.simulated { Text("模拟调用 · 未验证真实模型") }
                                        Text("请求模型：\(receipt.requestedModel)")
                                        Text("服务返回：\(receipt.reportedModel.isEmpty ? "未提供，不推断" : receipt.reportedModel)")
                                    }
                                } label: { Label("本轮模型记录", systemImage: "cpu").font(.caption2) }
                            }
                            if store.preferences.searchedMessages?.contains(message.id) == true { Label("已联网检索", systemImage: "globe").font(.caption2).foregroundStyle(meloGold) }
                            ForEach(store.preferences.messageSources?[message.id] ?? []) { source in
                                if let url = URL(string: source.url) {
                                    HStack {
                                        Link(destination: url) { Label(source.title, systemImage: "arrow.up.right").font(.caption).lineLimit(2) }
                                        Spacer(minLength: 6)
                                        Button { UIPasteboard.general.url = url } label: { Image(systemName: "doc.on.doc").font(.caption).frame(width: 36, height: 36) }.accessibilityLabel("复制来源链接：\(source.title)")
                                    }
                                }
                            }
                        }.padding(18).padding(.leading, 12)
                        .background(message.role == "user" ? meloGold.opacity(0.065) : meloBackground.opacity(0.3), in: RoundedRectangle(cornerRadius: 22))
                        .overlay(alignment: .leading) {
                            VStack(spacing: 6) { Circle().fill(meloGold.opacity(0.7)).frame(width: 4, height: 4); Rectangle().fill(LinearGradient(colors: [meloGold.opacity(0.3), meloGold.opacity(0.04)], startPoint: .top, endPoint: .bottom)).frame(width: 0.5) }.padding(.vertical, 20).padding(.leading, 10)
                        }.id(message.id)
                        .onAppear { if message.role == "assistant" { store.markRendered(message.id) } }
                    }
                    if store.sendingID == chatID { HStack { ProgressView().tint(meloAccent); VStack(alignment: .leading, spacing: 5) { Text(store.activeImageAction.map { $0.title + "…" } ?? account.replyStatus).font(.subheadline).foregroundStyle(.secondary); Text(store.replyBackgroundStatus).font(.caption2).foregroundStyle(meloGold) }; Spacer(); Button("停止") { store.cancel() } }.padding() }
                    else if chat?.messages.last?.role == "user" {
                        if let notice = store.interruptionNotice(for: chatID) { Label(notice, systemImage: "pause.circle").font(.caption).foregroundStyle(meloGold).padding(.horizontal) }
                        Button { store.send("", chatID: chatID, retry: true, imageTask: imagePlan) } label: { Label("重新生成回复", systemImage: "arrow.clockwise").font(.subheadline) }.padding(.horizontal)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(16)
            }.scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
            .accessibilityIdentifier("chat.messages")
            .onChange(of: chat?.messages.count) { _, _ in withAnimation { reader.scrollTo("bottom", anchor: .bottom) } }
            .onAppear { reader.scrollTo("bottom", anchor: .bottom) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
            VStack(spacing: 8) {
                ImageComposerBar(plan: Binding(get: { imagePlan }, set: { imagePlan = $0 }), importID: $imageImportID, chatID: chatID, onPreview: { imagePreview = $0 }).id(chatID)
                    .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
                voiceInputPanel
                HStack(alignment: .bottom, spacing: 8) {
                    if deviceSpeech.speechFailed { Text(deviceSpeech.speechStatus).font(.caption2).foregroundStyle(.red) }
                    if deviceSpeech.speechActive { Button { LocalDeviceServices.shared.stopSpeech() } label: { Image(systemName: "speaker.slash") }.accessibilityLabel("停止朗读") }
                    AtomicButton(busy: store.sendingID == chatID) { executionRunID = nil; showExecution = true }
                    TextField("给\(store.agent(for: chatID).name)发消息", text: Binding(get: { draft }, set: { draft = $0 }), axis: .vertical).focused($composerFocused).accessibilityIdentifier("chat.composer").lineLimit(1...6).padding(13).background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                    Button {
                        composerFocused = false
                        if voiceInput.state.active { voiceInput.stop() }
                        else {
                            let targetChat = chatID
                            LocalDeviceServices.shared.stopSpeech(); voiceInput.start(locale: voiceLanguage) { text in
                                guard chatID == targetChat else { return }
                                draft += (draft.isEmpty ? "" : "\n") + text
                            }
                        }
                    } label: {
                        Image(systemName: voiceInput.state.recording ? "stop.fill" : "mic.fill")
                            .font(.system(size: 18)).foregroundStyle(voiceInput.state.active ? meloGold : meloAccent)
                            .frame(width: 44, height: 44).background(.white.opacity(0.05), in: Circle())
                    }.disabled(store.sendingID != nil || voiceInput.state.status == "stopping")
                     .accessibilityLabel(voiceInput.state.active ? "停止语音输入" : "语音输入，转为文字后确认发送")
                    Button { let text = draft; store.send(text, chatID: chatID, imageTask: imagePlan); if store.sendingID == chatID { composerFocused = false; draft = ""; imagePlan = ImageTaskPlan(model: imagePlan.model, size: imagePlan.size, quality: imagePlan.quality, connectionID: imagePlan.connectionID) } } label: { Image(systemName: "arrow.up").font(.headline).frame(width: 44, height: 44).background(meloAccent, in: Circle()).foregroundStyle(.black) }.disabled(chat == nil || imageImportID != nil || voiceInput.state.active || store.sendingID != nil || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (imagePlan.references.isEmpty || imagePlan.makesImage)) || !store.storageReady).accessibilityLabel("发送消息")
                }
                HStack {
                    if composerFocused {
                        Button("收起键盘", systemImage: "keyboard.chevron.compact.down") { composerFocused = false }
                            .font(.caption).frame(minHeight: 32).accessibilityIdentifier("chat.dismissKeyboard")
                    }
                    Menu {
                        Picker("语音识别语言", selection: $voiceLanguage) {
                            Text("中文").tag("zh-CN"); Text("English").tag("en-US"); Text("系统语言").tag("system")
                        }
                    } label: { Text(voiceLanguage == "zh-CN" ? "听写 · 中文" : voiceLanguage == "en-US" ? "听写 · English" : "听写 · 系统语言").font(.caption2) }.disabled(voiceInput.state.active)
                    Spacer()
                    Text("回复可能有误，请核实重要信息").font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8).background(meloBackground.opacity(0.65))
        }
        .onAppear { store.selectedConversationID = chatID }
        .onDisappear { voiceInput.cancel(); store.flushDrafts() }
        .onChange(of: scenePhase) { _, phase in
            // Permission sheets briefly make the app inactive; keep that request alive.
            if phase == .background || (phase == .inactive && voiceInput.state.recording) { voiceInput.cancel() }
        }
        .onChange(of: chatID) { _, _ in store.selectedConversationID = chatID; voiceInput.cancel(); composerFocused = false }
        .onChange(of: historyVisible) { _, open in if open { voiceInput.cancel(); composerFocused = false } }
        .onChange(of: settings) { _, open in if open { voiceInput.cancel(); composerFocused = false } }
        .onChange(of: showExecution) { _, open in if open { voiceInput.cancel(); composerFocused = false } }
        .onChange(of: sourcePage?.id) { _, _ in voiceInput.cancel() }
        .alert("重命名对话", isPresented: $renaming) {
            TextField("对话标题", text: $editedTitle)
            Button("保存") { store.rename(chatID, to: editedTitle) }.disabled(editedTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("取消", role: .cancel) {}
        }
        .environment(\.openURL, OpenURLAction { url in
            guard WebSource.validated(title: "", url: url.absoluteString) != nil else { return .discarded }
            sourcePage = SourcePage(url: url)
            return .handled
        })
        .task {
            if store.taskSpaceDiagnosticPending { store.taskSpaceDiagnosticPending = false; showExecution = true }
            #if DEBUG && targetEnvironment(simulator)
            if ProcessInfo.processInfo.arguments.contains("-melo-preview-execution") { showExecution = true }
            #endif
        }
        .sheet(isPresented: $showExecution) { ExecutionWorkspace(chatID: chatID, runID: executionRunID) }
        .sheet(item: $imagePreview) { ImagePreview(image: $0, onUse: useImage, chatID: chatID) }
        .onChange(of: chatID) { _, _ in imagePreview = nil; imageImportID = nil }
        .sheet(item: $sourcePage) { page in SourceBrowser(url: page.url).ignoresSafeArea() }
        .sheet(isPresented: $settings) { SettingsView().presentationBackground(MeloTheme.dialog) }
        .blur(radius: historyVisible ? 8 : 0)
        .allowsHitTesting(!historyVisible)
        .accessibilityHidden(historyVisible)
        .overlay {
            if historyVisible {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Color.black.opacity(0.25).ignoresSafeArea().onTapGesture { withAnimation { historyVisible = false } }
                        VStack(spacing: 0) {
                            HStack { Text("melo").font(.title3.weight(.medium)); Spacer(); Button { withAnimation { historyVisible = false } } label: { Label("回到对话", systemImage: "xmark").font(.caption).frame(minHeight: 44) }.accessibilityLabel("关闭历史对话") }.padding(.horizontal, 24).padding(.top, 14)
                            HistoryView(selectedID: chatID) { id in chatID = id; withAnimation { historyVisible = false } }
                        }.frame(width: min(geometry.size.width * 0.9, 390)).frame(maxHeight: .infinity).background(MeloTheme.floating).background(.ultraThinMaterial).overlay(alignment: .trailing) { Rectangle().fill(meloGold.opacity(0.25)).frame(width: 0.5) }.transition(.move(edge: .leading))
                    }
                }
            }
        }
    }
    private func useImage(_ image: LocalImage) { imagePlan.action = .edit; imagePlan.references = [ImageReference(id: image.id)] }
    @ViewBuilder private var voiceInputPanel: some View {
        let state = voiceInput.state
        if state.active || !state.error.isEmpty || !state.notice.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(state.status == "requesting" ? "等待麦克风授权…" : state.status == "stopping" ? "正在完成转写…" : state.recording ? "正在听写 · 点击麦克风停止" : "语音输入").font(.caption).foregroundStyle(meloGold)
                    Spacer()
                    if state.active { Button("取消") { voiceInput.cancel() }.font(.caption).frame(minHeight: 32) }
                }
                if !state.partial.isEmpty { ScrollView { Text(state.partial).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 78) }
                if !state.error.isEmpty { Text(state.error).font(.caption).foregroundStyle(meloGold) }
                if !state.notice.isEmpty { Text(state.notice).font(.caption).foregroundStyle(.secondary) }
                if state.active { Text("最长 60 秒 · 转为文字后确认发送 · 系统识别可能需要联网").font(.system(size: 10)).foregroundStyle(.secondary) }
            }.padding(10).background(meloGold.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
        }
    }

}

struct TaskHandoffView: View {
    @EnvironmentObject var store: ChatStore
    let open: (String) -> Void
    @State private var filter = 0
    private var tasks: [TaskCheckpoint] { store.taskCheckpoints.filter { filter == 0 ? $0.status != "done" : $0.status == "done" } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeading(eyebrow: "PROJECTS / HANDOFF", title: "任务接力", detail: "在手机接续查看，在执行设备完成工作。")
                VStack(alignment: .leading, spacing: 12) {
                    Label(store.syncStatus, systemImage: "arrow.triangle.2.circlepath").font(.subheadline)
                    Text("检查点是最近一次同步的状态。接力请求送达同步服务后，仍需桌面确认继续；本机权限不会随记录转移。").font(.caption).foregroundStyle(MeloTheme.muted)
                    Button { Task { await store.sync() } } label: { Label(store.syncing ? "正在同步…" : "同步检查点", systemImage: "arrow.clockwise").frame(minHeight: 44) }.disabled(store.syncing)
                }.meloPanel()
                Picker("任务筛选", selection: $filter) { Text("进行中").tag(0); Text("已完成").tag(1) }.pickerStyle(.segmented)
                if tasks.isEmpty { ContentUnavailableView(filter == 0 ? "暂无待处理任务" : "暂无已完成任务", systemImage: "square.stack.3d.up", description: Text("在桌面创建任务并配置同步服务后，检查点会显示在这里。")) }
                ForEach(tasks) { task in
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(alignment: .top) {
                            Image(systemName: task.needsApproval ? "hand.raised" : task.status == "done" ? "checkmark.circle" : "point.3.connected.trianglepath.dotted").foregroundStyle(meloGold)
                            VStack(alignment: .leading, spacing: 6) { Text(task.title).font(.headline); Text(task.statusLabel).font(.caption).foregroundStyle(meloAccent) }
                        }
                        Text(task.checkpoint.isEmpty ? "尚无执行检查点" : task.checkpoint).font(.subheadline).foregroundStyle(MeloTheme.muted).textSelection(.enabled)
                        if task.needsApproval { Label("回到执行设备核对权限或验收结果", systemImage: "lock.shield").font(.caption).foregroundStyle(meloGold) }
                        if let id = task.chatId, store.chats.contains(where: { $0.id == id }) { Button { open(id) } label: { Label("查看已同步对话", systemImage: "bubble.left.and.bubble.right").frame(minHeight: 44) } }
                        if task.canRequestHandoff {
                            Text(task.handoffLabel(requests: store.taskHandoffs, receipts: store.preferences.taskHandoffReceipts ?? [])).font(.caption).foregroundStyle(MeloTheme.soft)
                            Button { Task { await store.requestHandoff(task) } } label: { Label(store.taskHandoffs.contains { $0.taskId == task.id && $0.revision == task.revision } ? "再次同步请求" : "请求桌面继续 / 修复", systemImage: "arrow.right.circle").frame(minHeight: 44) }.disabled(store.syncing)
                        }
                        DisclosureGroup("检查点详情") {
                            VStack(alignment: .leading, spacing: 6) { Text("角色：\(task.owner)"); Text("版本：\(task.revision)"); Text("更新时间：\(task.updatedAt)"); Text("执行设备：\(task.sourceDevice)") }.font(.caption2).foregroundStyle(MeloTheme.soft).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                        }.font(.caption)
                    }.meloPanel()
                }
            }.padding(20)
        }.refreshable { await store.sync() }
    }
}
