import Foundation
@main struct EditDraftTests {
    static func main() throws {
        var edit = EditDraft("original")
        assert(!edit.canSave); edit.begin("original"); assert(!edit.canSave)
        edit.value = "changed"; assert(edit.start(current: "original") && edit.saving)
        edit.cancel(); assert(edit.saving && edit.value == "changed")
        edit.fail("disk full"); assert(edit.editing && edit.value == "changed" && edit.canSave)
        assert(edit.start(current: "original")); edit.finish("changed")
        assert(edit.saved && !edit.editing && !edit.dirty)
        edit.begin("changed"); edit.value = "draft"; assert(!edit.start(current: "external")); assert(edit.value == "draft")
        edit.cancel(); edit.refresh("external"); assert(edit.value == "external" && !edit.saved)
        var imported = EditDraft("prefilled import"); imported.begin("prefilled import")
        assert(!imported.start(current: "prefilled import"))
        assert(imported.start(current: "prefilled import", allowUnchanged: true))
        imported.finish("prefilled import"); assert(imported.saved && !imported.editing)
        struct Settings: Codable, Equatable { var name: String; var voice: Bool; var token: String? }
        let base = Settings(name: "base", voice: false, token: "secret")
        var draft = EditDraft(base); draft.begin(base); draft.value.name = "mine"; draft.value.token = nil
        let newest = Settings(name: "remote", voice: true, token: "secret")
        assert(!draft.start(current: newest) && draft.hasConflict)
        var oldJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]; oldJSON.removeValue(forKey: "conflict")
        let oldDraft = try JSONDecoder().decode(EditDraft<Settings>.self, from: JSONSerialization.data(withJSONObject: oldJSON))
        assert(oldDraft.value.name == "mine")
        draft.rebase(current: newest)
        assert(draft.value == Settings(name: "mine", voice: true, token: nil) && draft.dirty && !draft.hasConflict && !draft.saved)
        assert(draft.start(current: newest)); draft.fail("disk full")
        assert(draft.value.name == "mine" && draft.value.voice && draft.canSave)
        assert(draft.start(current: newest)); draft.finish(draft.value); assert(draft.saved)
        print("Edit draft: no implicit save, failure retry, cancellation, external conflict and success passed")
    }
}
