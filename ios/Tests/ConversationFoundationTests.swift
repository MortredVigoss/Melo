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
    let legacyProject = PersonalProject(id:"legacy-project",name:"Original",goal:"归拢相关对话、资料与目标。",instructions:"Keep this project focused, actionable, and easy to continue later.")
    let projectPrompt = ConversationContext.instructions(agent:moodCompatibility,project:legacyProject,notes:[])
    assert(!projectPrompt.contains(legacyProject.goal) && !projectPrompt.contains(legacyProject.instructions!), "legacy placeholder must not enter the prompt")
    let restoredProject = try JSONDecoder().decode(PersonalProject.self,from:JSONEncoder().encode(legacyProject))
    assert(restoredProject == legacyProject, "presentation cleanup must not migrate stored project text")
    var authoredProject = legacyProject; authoredProject.goal += " "
    assert(ConversationContext.instructions(agent:moodCompatibility,project:authoredProject,notes:[]).contains(authoredProject.goal), "only exact old placeholders are hidden")
    var projectPreferences = MobilePreferences()
    projectPreferences.projects = [legacyProject, PersonalProject(id:"archived",name:"Archived",goal:"",archived:true)]
    try ConversationContext.validateNewProject(nil,preferences:projectPreferences)
    try ConversationContext.validateNewProject("legacy-project",preferences:projectPreferences)
    for id in ["missing", "archived"] {
        do { try ConversationContext.validateNewProject(id,preferences:projectPreferences); assertionFailure("invalid project accepted") } catch { }
    }
    let deletionFixture = try JSONDecoder().decode(SyncValue.self,from:Data(contentsOf:URL(fileURLWithPath:"shared/protocol/project-lifecycle.fixture.json")))
    assert(ProjectDeletion.id(deletionFixture["projectId"].string) == deletionFixture["markerId"].string)
    let deletionWire = try SyncWorkspace(records:[.init(kind:"knowledge",id:deletionFixture["markerId"].string,versions:[.init(clock:["desktop":1],value:deletionFixture["markerValue"])])]).validated()
    let interoperableMarkers = try ProjectDeletion.markers(deletionWire)
    assert(interoperableMarkers[deletionFixture["projectId"].string]?["operationId"].string == "delete-once")
    var lifecycle = projectPreferences
    lifecycle.chatProjects = ["chat":"legacy-project"]
    lifecycle.knowledge = [.init(id:"asset",title:"Original",content:"keep exact",projectId:"legacy-project")]
    let offline = try WorkspaceProjection.refreshed(lifecycle,chats:[],records:[],connections:[],device:"old-phone")
    try WorkspaceProjection.deleteProject("legacy-project",preferences:&lifecycle,device:"phone",at:"2026-10-20T01:00:00Z",operation:"once")
    do { try WorkspaceProjection.assertProjectMovementIdle(projectPreferences,lifecycle,activeChats:["chat"])
    } catch { assertionFailure("original had no membership to change") }
    var activeBefore = projectPreferences; activeBefore.chatProjects = ["chat":"legacy-project"]
    do { try WorkspaceProjection.assertProjectMovementIdle(activeBefore,lifecycle,activeChats:["chat"]); assertionFailure("active project moved") } catch { }
    try WorkspaceProjection.assertProjectMovementIdle(activeBefore,lifecycle,activeChats:[])
    let deleted = lifecycle.workspaceSync!
    assert(lifecycle.chatProjects?["chat"] == nil && lifecycle.knowledge?.first?.content == "keep exact")
    assert(lifecycle.projects?.first?.deletedAt != nil)
    let reopenedLifecycle = try JSONDecoder().decode(MobilePreferences.self,from:JSONEncoder().encode(lifecycle))
    assert(reopenedLifecycle.projects == lifecycle.projects && reopenedLifecycle.workspaceSync == lifecycle.workspaceSync)
    for merged in [try deleted.merging(offline), try offline.merging(deleted)] {
        assert(!merged.records.contains { $0.kind == "project" && $0.id == "legacy-project" })
        var current = projectPreferences, records: [ExecutionRecord] = []
        try WorkspaceProjection.apply(merged,preferences:&current,records:&records,connections:[])
        assert(current.projects?.first?.deletedAt != nil)
    }
    let restoredID = try WorkspaceProjection.restoreProject("legacy-project",preferences:&lifecycle,replacement:"restored")
    assert(restoredID == "restored" && lifecycle.chatProjects?["chat"] == nil)
    let repeatedRestore = try WorkspaceProjection.restoreProject("legacy-project",preferences:&lifecycle,replacement:"retry")
    assert(repeatedRestore == "restored")
    let refreshedLifecycle = try WorkspaceProjection.refreshed(lifecycle,chats:[],records:[],connections:[],device:"phone")
    assert(refreshedLifecycle.records.contains { $0.kind == "project" && $0.id == "restored" })
    assert(!refreshedLifecycle.records.contains { $0.kind == "project" && $0.id == "legacy-project" })
    var corrupted = deleted
    corrupted.records[0].versions[0].value = .object(["kind":.string("note"),"content":.string("not a tombstone")])
    do { _ = try corrupted.validated(); assertionFailure("tombstone replacement accepted") } catch { }
    let legacyPreview: SyncValue = .object(["name":.string("Original"),"mood":.string("sharp"),"symbol":.string("star")])
    assert(!legacyPreview.preview.contains("sharp") && legacyPreview.preview.contains("star"), "retired mood must not appear in conflict previews")
    let mixedNotes = [KnowledgeNote(id:"note",title:"知识",content:"reference"), KnowledgeNote(id:"result",title:"成果",content:"original code",kind:"result"), KnowledgeNote(id:"deleted-result",title:"已删除",content:"retained",deleted:true,kind:"result")]
    assert(KnowledgeCollection.items(mixedNotes,results:false,deleted:false,query:"").map(\.id) == ["note"])
    assert(KnowledgeCollection.items(mixedNotes,results:true,deleted:false,query:"CODE").map(\.id) == ["result"])
    assert(KnowledgeCollection.items(mixedNotes,results:true,deleted:true,query:"").map(\.id) == ["deleted-result"])
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
    if records[0].pipeline?.isEmpty != false { records[0].pipeline = [ExecutionStage(id:"local-only",name:"local",status:"completed")] }
    let localStage = records[0].pipeline![0]
    records[0].pipeline![0].api = ["responseId":.string("resp_local_only"),"usage":.object(["input":.number(12)])]
    var wireWithLocalStage = wire
    let messageRow = wire.records.first { $0.kind == "message" && $0.id == "answer" }!
    var messageValue = messageRow.versions[0].value.object
    var sceneValue = messageValue["scene"]!.object
    sceneValue["pipeline"] = try .from([WorkspaceProjection.stage(localStage)])
    messageValue["scene"] = .object(sceneValue)
    wireWithLocalStage.put(kind:"message",id:"answer",value:.object(messageValue),device:"phone")
    try WorkspaceProjection.apply(wireWithLocalStage,preferences:&imported,records:&records,connections:connections)
    assert(records[0].pipeline?[0].api?["responseId"] == .string("resp_local_only"),"Old sync echoes must retain local API receipts")
    assert(WorkspaceProjection.stage(records[0].pipeline![0])["api"] == nil,"Do not add fields to frozen v1 wire")
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
    // Audit I6: a desktop memory row with project-book fields (section/bookStatus, validTo null, no
    // mergedInto) survives apply → refreshed byte-for-byte, so the phone clock is not bumped and the
    // row cannot ping-pong between devices. A real edit still bumps it.
    let memoryID = "promoted:book-1", memoryChat = Conversation(id: "chat-m", messages: [ChatMessage(id: "q", role: "user", content: "目标是上线")])
    let desktopRow: SyncValue = .object(["id": .string(MobileMemoryFact.identifier(memoryID)), "memoryID": .string(memoryID), "text": .string("目标：本月上线"), "originalFact": .string("目标：本月上线"), "scope": .string("project"), "status": .string("active"),
        "chatId": .string("chat-m"), "messageId": .string("q"), "projectId": .string("proj"), "agentId": .string("main"), "sourceText": .string("目标是上线"), "category": .string("project_context"),
        "updatedAt": .string("2026-10-18T00:00:00.000Z"), "userEdited": .bool(false), "validTo": .null, "section": .string("goal"), "bookStatus": .string("confirmed")])
    let desktopWire = SyncWorkspace(records: [.init(kind: "memory", id: MobileMemoryFact.identifier(memoryID), versions: [.init(clock: ["desktop": 4], value: desktopRow)])])
    var memoryPreferences = MobilePreferences(); var memoryRecords: [ExecutionRecord] = []
    try WorkspaceProjection.apply(desktopWire, preferences: &memoryPreferences, records: &memoryRecords, connections: [])
    assert(memoryPreferences.memoryFacts?.first?.section == "goal" && memoryPreferences.memoryFacts?.first?.bookStatus == "confirmed")
    let echoedWire = try WorkspaceProjection.refreshed(memoryPreferences, chats: [memoryChat], records: [], connections: [], device: "phone")
    let echoedRow = echoedWire.records.first { $0.kind == "memory" }!
    assert(echoedRow.versions.count == 1 && echoedRow.versions[0].clock == ["desktop": 4], "unchanged memory must not bump the phone clock: \(echoedRow.versions[0].clock)")
    assert(echoedRow.versions[0].value["section"].string == "goal" && echoedRow.versions[0].value["bookStatus"].string == "confirmed" && echoedRow.versions[0].value.object["mergedInto"] == nil)
    var withoutNull = desktopRow.object; withoutNull.removeValue(forKey: "validTo")
    let omittedWire = SyncWorkspace(records: [.init(kind: "memory", id: MobileMemoryFact.identifier(memoryID), versions: [.init(clock: ["desktop": 5], value: .object(withoutNull))])])
    memoryPreferences = MobilePreferences(); try WorkspaceProjection.apply(omittedWire, preferences: &memoryPreferences, records: &memoryRecords, connections: [])
    let omittedEcho = try WorkspaceProjection.refreshed(memoryPreferences, chats: [memoryChat], records: [], connections: [], device: "phone").records.first { $0.kind == "memory" }!
    assert(omittedEcho.versions[0].clock == ["desktop": 5], "absent vs null validTo is not a change")
    memoryPreferences.memoryFacts?[0].text = "目标：下月上线"
    let editedEcho = try WorkspaceProjection.refreshed(memoryPreferences, chats: [memoryChat], records: [], connections: [], device: "phone").records.first { $0.kind == "memory" }!
    assert(editedEcho.versions[0].clock == ["desktop": 5, "phone": 1] && editedEcho.versions[0].value["text"].string == "目标：下月上线")
    var badSection = memoryPreferences.memoryFacts![0]; badSection.section = "chapter"
    do { _ = try badSection.validated(); fatalError("invalid section accepted") } catch {}
    // Audit I22: compact `at` is compared as an instant, not as a string.
    assert(WorkspaceProjection.isLater("2026-10-18T09:00:00.000+08:00", than: "2026-10-18T00:30:00.000Z") && !WorkspaceProjection.isLater("2026-10-18T09:00:00.000+08:00", than: "2026-10-18T02:00:00.000Z"), "string order would say 09:00 > 02:00")
    assert(WorkspaceProjection.isLater("2026-10-18T00:00:01Z", than: "2026-10-18T00:00:00.500Z") && WorkspaceProjection.isLater("b", than: "a") && !WorkspaceProjection.isLater("", than: ""))
    print("Conversation foundations passed: legacy preferences, avatar/selection persistence, role/project/reference prompts, history attribution and readable tables/code")
 }
}
