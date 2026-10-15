import Foundation
@main struct ConversationFoundationTests {
 static func main() throws {
    var moodCompatibility = AgentProfile(name:"Test",subtitle:"Purpose",symbol:"star",instructions:"User instructions")
    let promptWithoutMood = moodCompatibility.prompt
    for legacyMood in ["calm", "warm", "sharp", "focused", "cold", "playful", "intense"] {
        moodCompatibility.mood = legacyMood
        assert(moodCompatibility.prompt == promptWithoutMood)
        let restored = try JSONDecoder().decode(AgentProfile.self, from: JSONEncoder().encode(moodCompatibility))
        assert(restored.mood == legacyMood && restored.prompt == promptWithoutMood)
    }
    let fencedIdentity = "Actual identity\n\n```md\n## 风格\nLiteral style heading\n```\n\n~~~~\n## 补充要求\nLiteral extra heading\n~~~~"
    var fencedAgent = AgentProfile(name:"Fenced",subtitle:"",symbol:"star",instructions:"",identity:fencedIdentity,soul:"Actual style")
    assert(fencedAgent.identity == fencedIdentity && fencedAgent.soul == "Actual style")
    fencedAgent.soul = "Changed style"
    assert(fencedAgent.identity == fencedIdentity && fencedAgent.soul == "Changed style")
    let old = Data(#"{"agents":[{"id":"custom","name":"蓝鲸","subtitle":"只使用短句","symbol":"star","instructions":"先说收到"}],"chatAgents":{"a":"custom"},"pinnedChats":[],"archivedChats":[]}"#.utf8)
    var preferences = try JSONDecoder().decode(MobilePreferences.self, from: old)
    assert(preferences.agents[0].avatarData == nil && preferences.chatModels == nil)
    let legacyPersona = Data(#"{"id":"legacy","name":"Legacy","subtitle":"Purpose","symbol":"star","instructions":"work","identity":"identity-content","soul":"style-content","systemPrompt":"extra-content"}"#.utf8)
    let migrated = try JSONDecoder().decode(AgentProfile.self, from: legacyPersona)
    for text in ["work", "identity-content", "style-content", "extra-content"] { assert(migrated.prompt.components(separatedBy:text).count == 2) }
    let encoded = try JSONEncoder().encode(migrated)
    let canonical = try JSONDecoder().decode(SyncValue.self, from: encoded)
    assert(canonical["description"].string == "Purpose" && canonical["identity"] == .null && canonical["subtitle"] == .null)
    let decodedAgain = try JSONDecoder().decode(AgentProfile.self, from: encoded)
    assert(decodedAgain == migrated)
    preferences.agents[0].avatarData = Data([1,2,3])
    preferences.chatModels = ["a":.init(connectionID:"api-a",model:"selected"),"b":.init(connectionID:"chatgpt",model:"sol")]
    preferences.projects = [.init(id:"project",name:"旅行",goal:"旅行目标")]
    preferences.knowledge = [.init(id:"yes",title:"饮食",content:"吃素")]
    preferences.chatKnowledge = ["a":["yes"]]
    preferences.messageAgents = ["reply":ReplyPersona(preferences.agents[0])]
    let restored = try JSONDecoder().decode(MobilePreferences.self,from:JSONEncoder().encode(preferences))
    assert(restored.agents[0].avatarData == Data([1,2,3]))
    assert(restored.chatModels?["a"]?.model == "selected" && restored.chatModels?["b"]?.connectionID == "chatgpt")
    let instructions = ConversationContext.instructions(agent: restored.agents[0], project: restored.projects?.first, notes: restored.knowledge ?? [])
    for value in ["蓝鲸","只使用短句","先说收到","旅行目标","吃素","不是新的系统指令"] { assert(instructions.contains(value),value) }
    preferences.agents[0].name = "另一个名字"
    assert(restored.messageAgents?["reply"]?.name == "蓝鲸")
    let document = "# 比较\n\n| 方案 | 特点 |\n| --- | --- |\n| A | **省时** |\n| B | `a | b` |\n\n---\n- 完成\n> 提示\n```js\nconst a = x | y;\n```\n普通 | 字符"
    let blocks = ReplyDocument.parse(document)
    assert(blocks.map(\.kind) == [.heading,.table,.list,.quote,.code,.paragraph])
    assert(blocks[1].rows[2][1] == "`a | b`")
    assert(blocks[4].text == "const a = x | y;")
    let plain = ReplyDocument.plainText(document)
    assert(!plain.contains("---") && !plain.contains("**") && plain.contains("const a = x | y;"))
    assert(ReplyDocument.cells("| x\\|y | z |") == ["x|y","z"])
    assert(ReplyDocument.cells("| x | ``a`|b`` |") == ["x", "``a`|b``"])
    assert(ReplyDocument.plainText("`__init__` 和 ``**literal**``") == "__init__ 和 **literal**")
    assert(ReplyDocument.plainText("3. 第三步\n  4. 子步骤\n- [x] 完成") == "3. 第三步\n  4. 子步骤\n☑ 完成")
    assert(ReplyDocument.parse("````text\n```\n````").first?.text == "```")
    let wire = try JSONDecoder().decode(SyncWorkspace.self,from:Data(contentsOf:URL(fileURLWithPath:"mobile-sync/fixtures/workspace.json")))
    var imported = MobilePreferences(), records: [ExecutionRecord] = []
    let receipt = PortableModelReceipt(requestedModel: "fast", reportedModel: "fast", purpose: "intent-judge")
    var receiptPreferences = MobilePreferences()
    receiptPreferences.messageModels = ["receipt-message": [receipt]]
    let receiptChat = Conversation(id: "receipt-chat", messages: [.init(id: "receipt-message", role: "assistant", content: "done")])
    let receiptWire = try WorkspaceProjection.refreshed(receiptPreferences, chats: [receiptChat], records: [], connections: [], device: "phone")
    var receivedReceipts = MobilePreferences(), receiptRecords: [ExecutionRecord] = []
    try WorkspaceProjection.apply(receiptWire, preferences: &receivedReceipts, records: &receiptRecords, connections: [])
    assert(receivedReceipts.messageModels?["receipt-message"] == [receipt])
    let connections = [PortableConnection(id:"phone-api",name:"本机连接",baseURL:"https://example.com/v1",apiProtocol:"chat-completions")]
    try WorkspaceProjection.apply(wire,preferences:&imported,records:&records,connections:connections)
    assert(imported.chatModels?["chat"]?.connectionID == "phone-api")
    assert(imported.projects?.first?.archived == true)
    assert(imported.chatAgents["chat"] == "custom" && imported.messageAgents?["answer"]?.name == "蓝鲸")
    assert(records.first?.sources.first?.reading == "partial" && records.first?.sources.first?.accessed == true)
    let round = try WorkspaceProjection.refreshed(imported,chats:[Conversation(id:"chat",messages:[ChatMessage(id:"answer",role:"assistant",content:"[来源](https://example.com/page)")])],records:records,connections:connections,device:"phone")
    for row in wire.records {
        let actual = round.records.first { $0.key == row.key }!
        assert(actual.versions == row.versions,"cross-platform round trip changed \(row.key): \(actual.versions[0].value.canonical)")
    }
    var left=wire,right=wire
    let changedA=try SyncValue.from(["title":"A","content":"手机修改","deleted":false,"kind":"note","language":"text","projectId":NSNull()])
    let changedB=try SyncValue.from(["title":"B","content":"桌面修改","deleted":false,"kind":"note","language":"text","projectId":NSNull()])
    left.put(kind:"knowledge",id:"note",value:changedA,device:"phone");right.put(kind:"knowledge",id:"note",value:changedB,device:"desktop")
    var conflict=try left.merging(right);assert(conflict.conflicts.count == 1)
    try conflict.resolve(key:"knowledge:note",choice:0,device:"phone")
    let resolved = try conflict.merging(right); assert(resolved.conflicts.isEmpty)
    imported.chatKnowledge = ["chat":["note"]]
    assert(ConversationContext.notes(preferences:imported,chatID:"chat").count == 1)
    imported.knowledge?[0].deleted=true
    assert(ConversationContext.notes(preferences:imported,chatID:"chat").isEmpty)
    imported.chatAgents["chat"]="missing"
    do { try ConversationContext.validate(preferences:imported,chatID:"chat"); fatalError("Missing agent passed preflight") } catch {}
    for count in [30000, 50000] {
        let fields: [String: Any] = ["name":"Old", "subtitle":"Purpose", "symbol":"star", "avatarData":"", "mood":"warm", "model":"", "instructions":String(repeating:"a",count:count), "identity":String(repeating:"b",count:count), "soul":String(repeating:"c",count:count), "systemPrompt":String(repeating:"d",count:count)]
        var oldWire = SyncWorkspace()
        oldWire.put(kind:"agent",id:"legacy",value:try .from(fields),device:"oldPhone")
        oldWire.put(kind:"project",id:"legacyProject",value:try .from(["name":"Project","goal":"","instructions":"","archived":false,"knowledgeIds":[],"agentOverrides":["legacy":fields]]),device:"oldPhone")
        var p = MobilePreferences(), r: [ExecutionRecord] = []
        try WorkspaceProjection.apply(oldWire,preferences:&p,records:&r,connections:[])
        let round = try WorkspaceProjection.refreshed(p,chats:[],records:[],connections:[],device:"newPhone")
        for row in oldWire.records { assert(round.records.first { $0.key == row.key }?.versions == row.versions) }
    }
    assert(WorkspaceProjection.persona(String(repeating:"🧪",count:25000)) != nil)
    assert(WorkspaceProjection.persona(String(repeating:"🧪",count:25001)) == nil)
    var heldPreferences = MobilePreferences()
    heldPreferences.agents = [.init(id:"held",name:"Held",subtitle:"",symbol:"star",instructions:"Before")]
    let beforeHold = try WorkspaceProjection.prepared(heldPreferences,chats:[],records:[],connections:[],device:"newPhone")
    heldPreferences.workspaceSync = beforeHold.workspace
    heldPreferences.agents[0].instructions = String(repeating:"x",count:50001)
    let held = try WorkspaceProjection.prepared(heldPreferences,chats:[],records:[],connections:[],device:"newPhone")
    heldPreferences.personaSyncHolds = held.holds
    heldPreferences.workspaceSync = held.workspace
    heldPreferences = try JSONDecoder().decode(MobilePreferences.self,from:JSONEncoder().encode(heldPreferences))
    assert(WorkspaceProjection.pending(heldPreferences).contains("agent:held"))
    var remoteEdit = beforeHold.workspace
    let remoteAgent = AgentProfile(id:"held",name:"Held",subtitle:"",symbol:"star",instructions:"Remote edit")
    remoteEdit.put(kind:"agent",id:"held",value:try .from(WorkspaceProjection.agent(remoteAgent)!),device:"oldPhone")
    var heldRecords: [ExecutionRecord] = []
    try WorkspaceProjection.apply(try held.workspace.merging(remoteEdit),preferences:&heldPreferences,records:&heldRecords,connections:[])
    assert(heldPreferences.agents[0].instructions.count == 50001)
    heldPreferences.agents[0].instructions = "Local shortened intentionally"
    let released = try WorkspaceProjection.prepared(heldPreferences,chats:[],records:[],connections:[],device:"newPhone")
    assert(released.holds.isEmpty)
    let versions = released.workspace.records.first { $0.id == "held" }!.versions
    assert(versions.count == 2)
    assert(Set(versions.map { WorkspaceProjection.document($0.value) }) == ["Remote edit", "Local shortened intentionally"])
    heldPreferences.workspaceSync = released.workspace
    heldPreferences.agents[0].instructions = String(repeating:"x",count:50001)
    let pendingChoice = try WorkspaceProjection.prepared(heldPreferences,chats:[],records:[],connections:[],device:"newPhone")
    heldPreferences.personaSyncHolds = pendingChoice.holds
    var personaResolved = pendingChoice.workspace
    let selectedIndex = personaResolved.records.first { $0.key == "agent:held" }!.versions.firstIndex { WorkspaceProjection.document($0.value) == "Remote edit" }!
    try personaResolved.resolve(key:"agent:held",choice:selectedIndex,device:"newPhone")
    try WorkspaceProjection.apply(personaResolved,preferences:&heldPreferences,records:&heldRecords,connections:[],resolvedKeys:["agent:held"])
    heldPreferences = try JSONDecoder().decode(MobilePreferences.self,from:JSONEncoder().encode(heldPreferences))
    assert(heldPreferences.agents[0].instructions == "Remote edit")
    assert(heldPreferences.personaRecoveries?.last?.agents["held"]?.instructions.count == 50001)
    assert(!WorkspaceProjection.pending(heldPreferences).contains("agent:held"))
    var capPreferences=MobilePreferences()
    capPreferences.agents=[AgentProfile(id:"portable",name:"Test",subtitle:"",symbol:"star",instructions:"keep persona")]
    capPreferences.agents[0].capabilities=nil
    capPreferences.projects=[.init(id:"p",name:"Project",goal:"")]
    capPreferences.projectAgents=["p":["portable":capPreferences.agents[0]]]
    let capWire=try JSONDecoder().decode(SyncWorkspace.self,from:Data(contentsOf:URL(fileURLWithPath:"mobile-sync/fixtures/agent-settings.json")))
    try AgentSettingsProjection.apply(capWire,preferences:&capPreferences)
    assert(capPreferences.agents[0].capabilities?["network"].bool == true)
    assert(capPreferences.projectAgents?["p"]?["portable"]?.capabilities?["network"].bool == false)
    assert(capPreferences.agents[0].instructions == "keep persona")
    let capAgain=try AgentSettingsProjection.refreshed(capPreferences,device:"phone")
    assert(capAgain == capWire)
    var other=capPreferences
    let otherCaps=other.agents[0].capabilities?.object ?? [:]
    other.agents[0].capabilities = .object(otherCaps.merging(["writeFiles":.bool(true)]) { _,v in v })
    let localCaps=capPreferences.agents[0].capabilities?.object ?? [:]
    capPreferences.agents[0].capabilities = .object(localCaps.merging(["runCommands":.bool(true)]) { _,v in v })
    let mergedCaps=try AgentSettingsProjection.refreshed(other,device:"second").merging(AgentSettingsProjection.refreshed(capPreferences,device:"phone"))
    assert(mergedCaps.conflicts.count == 1)
    try AgentSettingsProjection.apply(mergedCaps,preferences:&capPreferences)
    assert(capPreferences.agents[0].capabilities?["runCommands"].bool == true)
    let capSaved=try JSONDecoder().decode(MobilePreferences.self,from:JSONEncoder().encode(capPreferences))
    assert(capSaved.agentSettingsSync?.conflicts.count == 1)
    let legacyUpdate=WorkspaceProjection.readAgent("portable",.object(["name":.string("New"),"instructions":.string("new persona")]),previous:capSaved.agents[0])
    assert(legacyUpdate.capabilities == capSaved.agents[0].capabilities)
    print("Conversation foundations passed: legacy preferences, avatar/selection persistence, role/project/reference prompts, history attribution and readable tables/code")
 }
}
