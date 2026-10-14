import Foundation
@main struct ConversationFoundationTests {
 static func main() throws {
    let old = Data(#"{"agents":[{"id":"custom","name":"蓝鲸","subtitle":"只使用短句","symbol":"star","instructions":"先说收到"}],"chatAgents":{"a":"custom"},"pinnedChats":[],"archivedChats":[]}"#.utf8)
    var preferences = try JSONDecoder().decode(MobilePreferences.self, from: old)
    assert(preferences.agents[0].avatarData == nil && preferences.chatModels == nil)
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
    print("Conversation foundations passed: legacy preferences, avatar/selection persistence, role/project/reference prompts, history attribution and readable tables/code")
 }
}
