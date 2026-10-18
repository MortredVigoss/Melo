import Foundation

struct PortableConnection {
    var id: String
    var name: String
    var baseURL: String
    var apiProtocol: String
}
enum WorkspaceProjection {
    static func base(_ value: String) -> String {
        var result = value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for suffix in ["/chat/completions", "/messages"] where result.hasSuffix(suffix) { result = String(result.dropLast(suffix.count)) }
        return result
    }
    static func document(_ value: SyncValue) -> String {
        let extra = ["identity", "soul", "systemPrompt"].contains { !value[$0].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return extra ? AgentProfile.document(value["instructions"].string, identity:value["identity"].string, soul:value["soul"].string, systemPrompt:value["systemPrompt"].string) : value["instructions"].string
    }
    static func persona(_ document: String, previous: SyncValue = .null) -> [String: String]? {
        let keys = ["instructions", "identity", "soul", "systemPrompt"]
        func valid(_ fields: [String: String]) -> Bool {
            fields.values.allSatisfy { $0.utf16.count <= 50000 } &&
                (try? Self.document(.from(fields))) == document
        }
        let old = Dictionary(uniqueKeysWithValues: keys.map { ($0, previous[$0].string) })
        if previous != .null && valid(old) { return old }
        let single = ["instructions":document, "identity":"", "soul":"", "systemPrompt":""]
        if valid(single) { return single }
        let headings = ["工作要求":"instructions", "身份":"identity", "风格":"soul", "补充要求":"systemPrompt"]
        var fields = Dictionary(uniqueKeysWithValues: keys.map { ($0, "") }), current = "instructions"
        for line in document.components(separatedBy: "\n") {
            if line.hasPrefix("## "), let field = headings[String(line.dropFirst(3))] { current = field }
            else { fields[current, default: ""] += line + "\n" }
        }
        fields = fields.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        return valid(fields) ? fields : nil
    }
    static func agent(_ a: AgentProfile, previous: SyncValue = .null) -> [String: Any]? {
        guard let fields = persona(a.instructions, previous:previous) else { return nil }
        var value: [String: Any] = ["name":a.name,"subtitle":a.description,"symbol":a.symbol,"avatarData":a.avatarData?.base64EncodedString() ?? "","mood":a.mood ?? "warm","model":a.model ?? ""]
        for (key, text) in fields { value[key] = text }
        return value
    }
    static func previous(_ preferences: MobilePreferences, _ kind: String, _ id: String) -> SyncValue {
        guard let row = preferences.workspaceSync?.records.first(where: { $0.kind == kind && $0.id == id }), row.versions.count == 1 else { return .null }
        return row.versions[0].value
    }
    static func pending(_ preferences: MobilePreferences) -> Set<String> {
        var held = Set((preferences.personaSyncHolds ?? [:]).keys)
        for a in preferences.agents where agent(a,previous:previous(preferences,"agent",a.id)) == nil { held.insert("agent:" + a.id) }
        for p in preferences.projects ?? [] {
            let before = previous(preferences,"project",p.id)
            if (preferences.projectAgents?[p.id] ?? [:]).contains(where: { agent($0.value,previous:before["agentOverrides"][$0.key]) == nil }) { held.insert("project:" + p.id) }
        }
        for (id, agent) in preferences.chatAgents where held.contains("agent:" + agent) && previous(preferences,"agent",agent) == .null { held.insert("conversation:" + id) }
        for (id, project) in preferences.chatProjects ?? [:] where held.contains("project:" + project) && previous(preferences,"project",project) == .null { held.insert("conversation:" + id) }
        return held
    }
    static func model(_ selection: ConversationModel?, connections: [PortableConnection]) -> Any {
        guard let selection else { return NSNull() }
        let local = connections.first { $0.id == selection.connectionID }
        return ["connectionID": selection.syncConnectionID ?? selection.connectionID, "name": selection.name ?? local?.name ?? (selection.connectionID == "chatgpt" ? "ChatGPT" : ""), "model": selection.model, "authMode": selection.authMode ?? (selection.connectionID == "chatgpt" ? "codex" : "api-key"), "baseURL": base(selection.baseURL ?? local?.baseURL ?? ""), "apiProtocol": selection.apiProtocol ?? local?.apiProtocol ?? "chat-completions"]
    }
    static func modelSelection(_ value: SyncValue, connections: [PortableConnection]) -> ConversationModel? {
        guard value != .null else { return nil }
        if value["authMode"].string == "codex" { return .init(connectionID: "chatgpt", model: value["model"].string, name: value["name"].string, baseURL:value["baseURL"].string,apiProtocol:value["apiProtocol"].string,syncConnectionID:value["connectionID"].string,authMode:"codex") }
        let matches = connections.filter { base($0.baseURL) == base(value["baseURL"].string) && $0.apiProtocol == value["apiProtocol"].string }
        let local = matches.first { $0.id == value["connectionID"].string } ?? (matches.count == 1 ? matches[0] : nil)
        return .init(connectionID: local?.id ?? "unconnected-sync", model: value["model"].string, name: value["name"].string, baseURL: value["baseURL"].string, apiProtocol: value["apiProtocol"].string,syncConnectionID:value["connectionID"].string,authMode:value["authMode"].string)
    }
    static func stage(_ s: ExecutionStage) -> [String: Any] {
        ["id":s.id,"module":s.module,"name":s.name,"status":s.status,"provider":"","input":s.input,"output":s.output,"query":"","resultSummary":"","model":s.model ?? "","returnedModel":s.returnedModel ?? "","channel":s.channel ?? "","startedAt":s.startedAt ?? "","finishedAt":s.finishedAt ?? ""]
    }
    static func scene(_ r: ExecutionRecord, device: String) -> [String: Any] {
        let operations = r.operations.map { s -> [String: Any] in ["id":s.id,"module":s.module,"name":s.name,"status":s.status,"provider":s.provider,"input":s.input,"output":s.output,"query":s.query,"resultSummary":s.resultSummary,"model":"","returnedModel":"","channel":"","startedAt":"","finishedAt":""] }
        let sources = r.sources.map { s -> [String: Any] in ["id":s.id,"url":s.url,"title":s.title,"titleProvided":s.titleProvided,"order":s.order,"rank":s.rank,"reading":s.reading,"appeared":s.appeared,"accessed":s.accessed,"opened":s.opened,"cited":s.cited,"providers":s.providers,"queries":s.queries] }
        return ["runId":r.runId,"status":r.status,"query":r.query,"startedAt":r.startedAt,"finishedAt":r.finishedAt ?? "","lastModule":r.lastModule ?? "","requestedModel":r.requestedModel,"returnedModel":r.returnedModel ?? "","sourceDevice":r.sourceDevice ?? device,"operations":operations,"pipeline":(r.pipeline ?? []).map(stage),"sources":sources]
    }
    static func refreshed(_ preferences: MobilePreferences, chats: [Conversation], records: [ExecutionRecord], connections: [PortableConnection], device: String) throws -> SyncWorkspace {
        try prepared(preferences,chats:chats,records:records,connections:connections,device:device).workspace
    }
    static func prepared(_ preferences: MobilePreferences, chats: [Conversation], records: [ExecutionRecord], connections: [PortableConnection], device: String) throws -> (workspace: SyncWorkspace, holds: [String: PersonaSyncHold]) {
        var workspace = try (preferences.workspaceSync ?? SyncWorkspace()).validated()
        var holds = preferences.personaSyncHolds ?? [:]
        func hold(_ kind: String, _ id: String, _ name: String) {
            let key = kind + ":" + id
            if holds[key] == nil { holds[key] = .init(kind:kind,id:id,name:name,base:workspace.records.first { $0.key == key }) }
        }
        func put(_ kind: String, _ id: String, _ value: [String: Any]) throws {
            let value = try SyncValue.from(value), key = kind + ":" + id
            guard let held = holds[key] else { workspace.put(kind:kind,id:id,value:value,device:device); return }
            let clocks = (held.base?.versions ?? []).map(\.clock)
            var clock: [String: Int] = [:]
            for key in Set(clocks.flatMap { $0.keys }) {
                let count = clocks.map { $0[key, default:0] }.min() ?? 0
                if count > 0 { clock[key] = count }
            }
            clock[device] = (clocks.map { $0[device, default:0] }.max() ?? 0) + 1
            workspace = try workspace.merging(SyncWorkspace(records:[.init(kind:kind,id:id,versions:[.init(clock:clock,value:value)])]))
            holds.removeValue(forKey:key)
        }
        let live = Set(chats.map(\.id))
        holds = holds.filter { $0.value.kind != "conversation" || live.contains($0.value.id) }
        for fact in preferences.memoryFacts ?? [] where live.contains(fact.chatId) {
            let data = try JSONEncoder().encode(fact)
            workspace.put(kind: "memory", id: fact.id, value: try JSONDecoder().decode(SyncValue.self, from: data), device: device)
        }
        var unavailableAgents = Set<String>(), unavailableProjects = Set<String>()
        for a in preferences.agents {
            let before = previous(preferences,"agent",a.id)
            if let value = agent(a,previous:before) { try put("agent",a.id,value) }
            else { hold("agent",a.id,a.name); if before == .null { unavailableAgents.insert(a.id) } }
        }
        for p in preferences.projects ?? [] {
            let before = previous(preferences,"project",p.id)
            var overrides: [String: Any] = [:], blocked = false
            for (id,a) in preferences.projectAgents?[p.id] ?? [:] {
                if let value = agent(a,previous:before["agentOverrides"][id]) { overrides[id] = value } else { blocked = true }
            }
            if blocked { hold("project",p.id,p.name); if before == .null { unavailableProjects.insert(p.id) } }
            else { try put("project", p.id, ["name":p.name,"goal":p.goal,"instructions":p.instructions ?? "","archived":p.archived == true,"knowledgeIds":(p.knowledgeIds ?? []).sorted(),"agentOverrides":overrides]) }
        }
        for n in preferences.knowledge ?? [] { try put("knowledge",n.id,["title":n.title,"content":n.content,"deleted":n.deleted == true,"kind":n.kind ?? "note","language":n.language ?? "text","projectId":n.projectId as Any? ?? NSNull()]) }
        for chat in chats {
            if unavailableAgents.contains(preferences.chatAgents[chat.id] ?? preferences.agents.first?.id ?? "melo") || unavailableProjects.contains(preferences.chatProjects?[chat.id] ?? "") { hold("conversation",chat.id,chat.title) }
            else {
                var conversation: [String: Any] = ["agentId":preferences.chatAgents[chat.id] ?? preferences.agents.first?.id ?? "melo","projectId":preferences.chatProjects?[chat.id] as Any? ?? NSNull(),"knowledgeIds":(preferences.chatKnowledge?[chat.id] ?? []).sorted(),"model":model(preferences.chatModels?[chat.id],connections:connections)]
                // Desktop compact state is carried back unchanged so a phone edit never drops it (design 2026-10-17 手机对齐).
                if let compact = preferences.chatCompact?[chat.id], compact != .null, let value = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(compact), options: [.fragmentsAllowed]) { conversation["compact"] = value }
                try put("conversation",chat.id,conversation)
            }
            for message in chat.messages where message.role == "assistant" {
                let persona = preferences.messageAgents?[message.id]
                let record = records.last { $0.messageId == message.id && $0.terminal }
                let models = (preferences.messageModels?[message.id] ?? []).map { receipt -> [String: Any] in
                    var value: [String: Any] = ["requestedModel":receipt.requestedModel,"reportedModel":receipt.reportedModel,"simulated":receipt.simulated]
                    if let purpose = receipt.purpose { value["purpose"] = purpose }
                    return value
                }
                try put("message",message.id,["chatId":chat.id,"agent":persona.map { ["agentID":$0.agentID,"name":$0.name,"symbol":$0.symbol] } as Any? ?? NSNull(),"models":models,"scene":record.map { scene($0,device:device) } as Any? ?? NSNull()])
            }
        }
        return (try workspace.validated(), holds)
    }
    static func readAgent(_ id: String, _ v: SyncValue, previous: AgentProfile? = nil) -> AgentProfile {
        var result = AgentProfile(id:id,name:v["name"].string,subtitle:v["subtitle"].string,symbol:v["symbol"].string,instructions:document(v),avatarData:Data(base64Encoded:v["avatarData"].string),mood:v["mood"].string,model:v["model"].string)
        result.capabilities=previous?.capabilities; result.collaboration=previous?.collaboration; result.contextSources=previous?.contextSources
        return result
    }

    static func apply(_ workspace: SyncWorkspace, preferences: inout MobilePreferences, records: inout [ExecutionRecord], connections: [PortableConnection], resolvedKeys: Set<String> = []) throws {
        _ = try workspace.validated()
        var held = pending(preferences)
        for key in resolvedKeys where held.contains(key) {
            guard let row = workspace.records.first(where: { $0.key == key && $0.versions.count == 1 }) else { continue }
            let agents = row.kind == "agent" ? Dictionary(uniqueKeysWithValues: preferences.agents.filter { $0.id == row.id }.map { ($0.id, $0) }) : row.kind == "project" ? preferences.projectAgents?[row.id] ?? [:] : [:]
            if !agents.isEmpty {
                if preferences.personaRecoveries == nil { preferences.personaRecoveries = [] }
                preferences.personaRecoveries?.append(.init(id:UUID().uuidString,key:key,createdAt:ISO8601DateFormatter().string(from:Date()),agents:agents))
            }
            preferences.personaSyncHolds?.removeValue(forKey:key)
            held.remove(key)
        }
        for row in workspace.records where row.versions.count == 1 && !held.contains(row.key) {
            let v = row.versions[0].value
            switch row.kind {
            case "memory":
                let fact = try v.decoded(MobileMemoryFact.self).validated()
                var facts = preferences.memoryFacts ?? []
                if let index = facts.firstIndex(where: { $0.id == fact.id }) { facts[index] = fact } else { facts.append(fact) }
                preferences.memoryFacts = facts
            case "agent":
                let a = readAgent(row.id,v,previous:preferences.agents.first { $0.id == row.id })
                if let index = preferences.agents.firstIndex(where: { $0.id == row.id }) { preferences.agents[index] = a } else { preferences.agents.append(a) }
            case "project":
                let p = PersonalProject(id:row.id,name:v["name"].string,goal:v["goal"].string,instructions:v["instructions"].string,knowledgeIds:Set(v["knowledgeIds"].array.map(\.string)),archived:v["archived"].bool)
                var projects = preferences.projects ?? []; if let index = projects.firstIndex(where: { $0.id == row.id }) { projects[index] = p } else { projects.append(p) }; preferences.projects = projects
                if preferences.projectAgents == nil { preferences.projectAgents = [:] }
                let previousAgents=preferences.projectAgents?[row.id] ?? [:]
                preferences.projectAgents?[row.id] = Dictionary(uniqueKeysWithValues:v["agentOverrides"].object.map { id,value in (id,readAgent(id,value,previous:previousAgents[id])) })
                for id in preferences.projectAgents?[row.id]?.keys.map({$0}) ?? [] { preferences.projectAgents?[row.id]?[id]?.id = id }
            case "knowledge":
                let n = KnowledgeNote(id:row.id,title:v["title"].string,content:v["content"].string,deleted:v["deleted"].bool,kind:v["kind"].string,language:v["language"].string,projectId:v["projectId"] == .null ? nil : v["projectId"].string)
                var notes = preferences.knowledge ?? []; if let index = notes.firstIndex(where: { $0.id == row.id }) { notes[index] = n } else { notes.append(n) }; preferences.knowledge = notes
            case "conversation":
                preferences.chatAgents[row.id] = v["agentId"].string
                if preferences.chatProjects == nil { preferences.chatProjects = [:] }; preferences.chatProjects?[row.id] = v["projectId"] == .null ? nil : v["projectId"].string
                if preferences.chatKnowledge == nil { preferences.chatKnowledge = [:] }; preferences.chatKnowledge?[row.id] = Set(v["knowledgeIds"].array.map(\.string))
                if preferences.chatModels == nil { preferences.chatModels = [:] }; preferences.chatModels?[row.id] = modelSelection(v["model"],connections:connections)
                // Compact never moves backwards: larger compactedCount wins, ties go to the later `at`.
                if v["compact"] != .null {
                    let incoming = v["compact"], current = preferences.chatCompact?[row.id] ?? .null
                    var incomingCount = 0.0, currentCount = -1.0
                    if case .number(let n) = incoming["compactedCount"] { incomingCount = n }
                    if case .number(let n) = current["compactedCount"] { currentCount = n }
                    if incomingCount > currentCount || (incomingCount == currentCount && incoming["at"].string > current["at"].string) {
                        if preferences.chatCompact == nil { preferences.chatCompact = [:] }; preferences.chatCompact?[row.id] = incoming
                    }
                }
            case "message":
                if v["agent"] != .null {
                    if preferences.messageAgents == nil { preferences.messageAgents = [:] }
                    preferences.messageAgents?[row.id] = try v["agent"].decoded(ReplyPersona.self)
                }
                if preferences.messageModels == nil { preferences.messageModels = [:] }
                preferences.messageModels?[row.id] = try v["models"].decoded([PortableModelReceipt].self)
                if v["scene"] != .null {
                    let s = v["scene"]
                    guard ["completed","failed","cancelled","interrupted"].contains(s["status"].string) else { throw MeloError.message("同步场景不是结束状态，未恢复执行。") }
                    var record = ExecutionRecord(chatId:v["chatId"].string,query:s["query"].string,requestedModel:s["requestedModel"].string)
                    record.runId=s["runId"].string; record.status=s["status"].string; record.startedAt=s["startedAt"].string; record.finishedAt=s["finishedAt"].string; record.messageId=row.id
                    record.sourceDevice=s["sourceDevice"].string; record.returnedModel=s["returnedModel"].string; record.lastModule=s["lastModule"].string
                    record.operations=try s["operations"].decoded([ExecutionOperation].self); record.pipeline=try s["pipeline"].decoded([ExecutionStage].self); record.sources=try s["sources"].decoded([ExecutionSource].self)
                    record.observationNote="跨设备同步的真实执行与来源记录；本机未重新执行。"
                    if let index=records.firstIndex(where: { $0.runId==record.runId }) {
                        if records[index].terminal {
                            // The v1 wire omits local receipts; a sync echo must not erase them.
                            let local = records[index].pipeline ?? []
                            for stage in (record.pipeline ?? []).indices {
                                let id = record.pipeline![stage].id
                                record.pipeline?[stage].api = local.first { $0.id == id }?.api
                            }
                            records[index]=record
                        }
                    } else { records.append(record) }
                    if preferences.messageSources == nil { preferences.messageSources = [:] }
                    preferences.messageSources?[row.id] = record.sources.filter(\.cited).compactMap { WebSource.validated(title:$0.title,url:$0.url) }
                }
            default: break
            }
        }
        preferences.workspaceSync = workspace
    }
}
