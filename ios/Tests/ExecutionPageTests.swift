import Foundation
@main struct ExecutionPageTests {
    static func main() {
        let entry = URL(fileURLWithPath:"/var/containers/Bundle/Application/ID/Melo.app/Scene/index.html")
        let alias = URL(fileURLWithPath:"/private/var/containers/Bundle/Application/ID/Melo.app/Scene/index.html")
        assert(!alias.standardizedFileURL.path.hasPrefix(entry.deletingLastPathComponent().path + "/"), "Reproduce the old raw-prefix rejection")
        assert(ExecutionPagePolicy.allows(alias, entry:entry))
        assert(ExecutionPagePolicy.allows(entry, entry:alias))
        assert(ExecutionPagePolicy.allows(entry, entry:entry))
        for text in ["file:///var/containers/Bundle/Application/OTHER/Melo.app/Scene/index.html", "file:///var/containers/Bundle/Application/ID/Melo.app/Scene/../Info.plist", "https://example.com/index.html", "file://example.com/var/containers/Bundle/Application/ID/Melo.app/Scene/index.html"] {
            assert(!ExecutionPagePolicy.allows(URL(string:text), entry:entry))
        }
        assert(!ExecutionPagePolicy.allows(nil, entry:entry))
        print("Scene entry tests passed: iOS path aliases accepted, remote and neighboring files denied")
    }
}
