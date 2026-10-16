import Foundation

@main struct AgentEditTests {
    static func main() throws {
        var role = AgentProfile.defaults[0]
        role.identity = "keep identity"; role.soul = "keep soul"; role.model = "chosen-model"
        role.avatarData = Data([1, 2, 3])
        var editor = AgentEditSession(agent: role)
        var writes = 0
        assert(!editor.isEditing && !editor.canSave && !editor.hasChanges)
        assert(!editor.save(current: role) { _ in writes += 1; return true })
        editor.begin(current: role)
        assert(editor.isEditing && !editor.canSave)
        editor.draft.name = "君冬天"
        assert(editor.canSave && editor.needsDiscardConfirmation)
        assert(!editor.save(current: role) { _ in writes += 1; return false })
        assert(editor.isEditing && editor.hasChanges && !editor.didSave && editor.error != nil)
        assert(editor.draft.name == "君冬天" && editor.original == role)
        assert(editor.save(current: role) { value in
            writes += 1
            assert(value.identity == role.identity && value.soul == role.soul && value.model == role.model && value.avatarData == role.avatarData)
            return true
        })
        assert(editor.didSave && !editor.isEditing && !editor.hasChanges && !editor.canSave && editor.error == nil)
        editor.begin(current: editor.original); editor.draft.subtitle = "unsaved"
        editor.cancel()
        assert(editor.draft.subtitle == role.subtitle && !editor.isEditing)
        editor.begin(current: role); editor.draft.name = "local edit"
        var external = role; external.name = "synced edit"
        editor.refresh(external)
        assert(editor.draft.name == "local edit")
        assert(!editor.save(current: external) { _ in fatalError("must not overwrite remote edit") })
        assert(editor.hasChanges && editor.error != nil)
        let restored = try JSONDecoder().decode(AgentEditSession.self, from: JSONEncoder().encode(editor))
        assert(restored == editor && restored.isEditing && restored.draft.avatarData == role.avatarData && restored.draft.model == role.model)
        assert(!editor.save(current: nil) { _ in fatalError("must not resurrect deleted role") })
        assert(editor.hasConflict)
        external.model = "new remote model"
        editor.rebase(current: external)
        assert(editor.draft.name == "local edit" && editor.draft.model == "new remote model" && editor.draft.avatarData == role.avatarData)
        assert(editor.save(current: external) { _ in true })
        editor.begin(current: external); editor.draft.name = "rescued draft"
        assert(!editor.save(current: nil) { _ in false }); editor.keepAsNew()
        assert(editor.draft.id != external.id && editor.isNew && editor.canSave && editor.draft.name == "rescued draft")
        editor.cancel(); editor.refresh(external)
        assert(editor.draft == external)
        var newRole = AgentEditSession(agent: AgentProfile(name: "", subtitle: "", symbol: "sparkles", instructions: ""), isNew: true)
        assert(newRole.isEditing && !newRole.canSave)
        newRole.draft.name = "New"; newRole.draft.instructions = "   "
        assert(newRole.canSave) // An empty persona is an explicit choice.
        newRole.draft.instructions = "Be concise"
        assert(newRole.save(current: nil) { _ in true })
        assert(!newRole.isNew && newRole.didSave)
        print("Agent edit tests passed: read-only, dirty/save/cancel, failure retention, external conflict, new role, hidden fields")
    }
}
